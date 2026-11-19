/**
 * Check bundles: loads members, runs the weighted vote (bundle-rules.ts) and
 * stores the result as the state of the bundle's own check, then lets the
 * StatusEngine recompute the services linked to that check.
 *
 * Every bundle owns one row in `monitor_checks` that belongs to the built-in
 * virtual source of type "bundle" (BUNDLE_SOURCE_ID). That source is created on
 * demand, is never polled and accepts no ingest.
 *
 * Call `recomputeForSource` / `recomputeForChecks` after anything that changes
 * a member (results, poll outcome, source enabled/disabled or interval), and
 * `recompute(ids)` after bundle changes. The worker re-evaluates all bundles
 * periodically so members that go silent drop out of the vote.
 */
import {
  BUNDLE_SOURCE_TYPE,
  type AdminCheckBundle,
  type AdminCheckBundleMember,
  type BundleVoteSummary,
} from '@openstatuspage/shared';
import type { FastifyBaseLogger } from 'fastify';
import { isPollable } from '../adapters/index.js';
import type { DB } from '../db/index.js';
import type { CheckBundle } from '../db/types.js';
import { sha256, type SecretBox } from '../lib/crypto.js';
import { newToken } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import type { Worker } from '../worker.js';
import { bundleOutput, evaluateBundle, memberReason } from './bundle-rules.js';
import type { StatusEngine } from './status-engine.js';

/** Fixed id of the virtual source, so concurrent creation cannot produce two. */
export const BUNDLE_SOURCE_ID = '00000000-0000-4000-8000-00000000b0d1';
/** Internal name of the virtual source (admin UI only). */
export const BUNDLE_SOURCE_NAME = 'Check bundles';
/** Worker task re-evaluating all bundles (members going silent drop out of the vote). */
export const BUNDLE_TASK = 'bundle-evaluation';
export const BUNDLE_TASK_INTERVAL_MS = 60_000;

export interface BundleEvaluation {
  bundle: CheckBundle;
  vote: BundleVoteSummary;
  members: AdminCheckBundleMember[];
}

export class BundleService {
  constructor(
    private readonly db: DB,
    private readonly engine: StatusEngine,
    private readonly secrets: SecretBox,
    /** How long results of push-only sources count (BUNDLE_PUSH_STALE_SECONDS). */
    private readonly pushStaleMs: number,
  ) {}

  /** Creates the virtual bundle source if it does not exist. Returns its id. */
  async ensureSource(db: Pick<DB, 'insertInto'> = this.db): Promise<string> {
    const now = nowIso();
    await db
      .insertInto('monitor_sources')
      .values({
        id: BUNDLE_SOURCE_ID,
        name: BUNDLE_SOURCE_NAME,
        type: BUNDLE_SOURCE_TYPE,
        enabled: 1,
        config_encrypted: this.secrets.encryptJson({}),
        poll_interval_seconds: 60,
        // Random token that is never shown: the ingest endpoints reject this source anyway.
        ingest_token_hash: sha256(newToken()),
        last_poll_at: null,
        last_poll_ok: null,
        last_error: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    return BUNDLE_SOURCE_ID;
  }

  /** Bundles that have at least one of the given checks as member. */
  async bundlesOfChecks(checkIds: string[]): Promise<string[]> {
    if (checkIds.length === 0) return [];
    const rows = await this.db
      .selectFrom('check_bundle_members')
      .select('bundle_id')
      .distinct()
      .where('check_id', 'in', checkIds)
      .execute();
    return rows.map((r) => r.bundle_id);
  }

  /** Bundles with at least one member check of the given source. */
  async bundlesOfSource(sourceId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('check_bundle_members')
      .innerJoin('monitor_checks', 'monitor_checks.id', 'check_bundle_members.check_id')
      .select('check_bundle_members.bundle_id')
      .distinct()
      .where('monitor_checks.source_id', '=', sourceId)
      .execute();
    return rows.map((r) => r.bundle_id);
  }

  /** Evaluates the given bundles (all when omitted) without storing anything. */
  async evaluate(bundleIds?: string[], now = Date.now()): Promise<BundleEvaluation[]> {
    if (bundleIds && bundleIds.length === 0) return [];
    let q = this.db.selectFrom('check_bundles').selectAll().orderBy('name').orderBy('id');
    if (bundleIds) q = q.where('id', 'in', [...new Set(bundleIds)]);
    const bundles = await q.execute();
    if (bundles.length === 0) return [];

    const rows = await this.db
      .selectFrom('check_bundle_members')
      .innerJoin('monitor_checks', 'monitor_checks.id', 'check_bundle_members.check_id')
      .innerJoin('monitor_sources', 'monitor_sources.id', 'monitor_checks.source_id')
      .select([
        'check_bundle_members.bundle_id',
        'check_bundle_members.check_id',
        'check_bundle_members.votes',
        'monitor_checks.name as check_name',
        'monitor_checks.host',
        'monitor_checks.state',
        'monitor_checks.last_check_at',
        'monitor_sources.id as source_id',
        'monitor_sources.name as source_name',
        'monitor_sources.type as source_type',
        'monitor_sources.enabled',
        'monitor_sources.poll_interval_seconds',
        'monitor_sources.last_poll_ok',
      ])
      .where(
        'check_bundle_members.bundle_id',
        'in',
        bundles.map((b) => b.id),
      )
      .orderBy('monitor_sources.name')
      .orderBy('monitor_checks.host')
      .orderBy('monitor_checks.name')
      .execute();

    return bundles.map((bundle) => {
      const members: AdminCheckBundleMember[] = rows
        .filter((r) => r.bundle_id === bundle.id)
        .map((r) => {
          const reason = memberReason(
            { state: r.state, lastCheckAt: r.last_check_at },
            {
              enabled: r.enabled === 1,
              pollable: isPollable(r.source_type),
              pollIntervalSeconds: r.poll_interval_seconds,
              lastPollOk: r.last_poll_ok === null ? null : r.last_poll_ok === 1,
            },
            now,
            this.pushStaleMs,
          );
          return {
            checkId: r.check_id,
            votes: r.votes,
            checkName: r.check_name,
            host: r.host,
            sourceId: r.source_id,
            sourceName: r.source_name,
            sourceType: r.source_type,
            state: r.state,
            lastCheckAt: r.last_check_at,
            reporting: reason === 'reporting',
            reason,
          };
        });
      return { bundle, members, vote: evaluateBundle(members) };
    });
  }

  /**
   * Evaluates bundles (all when omitted), stores the results on their checks and
   * recomputes the services linked to bundles whose state changed.
   */
  async recompute(bundleIds?: string[]): Promise<void> {
    const evaluations = await this.evaluate(bundleIds);
    if (evaluations.length === 0) return;
    const current = await this.db
      .selectFrom('monitor_checks')
      .select(['id', 'state', 'output'])
      .where(
        'id',
        'in',
        evaluations.map((e) => e.bundle.check_id),
      )
      .execute();
    const byId = new Map(current.map((c) => [c.id, c]));
    const now = nowIso();
    const changed: string[] = [];
    for (const { bundle, vote } of evaluations) {
      const check = byId.get(bundle.check_id);
      if (!check) continue;
      const output = bundleOutput(vote);
      const stateChanged = check.state !== vote.state;
      await this.db
        .updateTable('monitor_checks')
        .set({
          state: vote.state,
          output,
          last_check_at: now,
          ...(stateChanged || check.output !== output ? { updated_at: now } : {}),
          ...(stateChanged ? { last_state_change_at: now } : {}),
        })
        .where('id', '=', check.id)
        .execute();
      if (stateChanged) changed.push(check.id);
    }
    await this.engine.recomputeForChecks(changed);
  }

  async recomputeForChecks(checkIds: string[]): Promise<void> {
    const ids = await this.bundlesOfChecks(checkIds);
    if (ids.length > 0) await this.recompute(ids);
  }

  async recomputeForSource(sourceId: string): Promise<void> {
    if (sourceId === BUNDLE_SOURCE_ID) return;
    const ids = await this.bundlesOfSource(sourceId);
    if (ids.length > 0) await this.recompute(ids);
  }

  /** Admin view of bundles (all, or the given ids) with the live vote. */
  async loadAdmin(ids?: string[]): Promise<AdminCheckBundle[]> {
    const evaluations = await this.evaluate(ids);
    if (evaluations.length === 0) return [];
    const counts = await this.db
      .selectFrom('service_checks')
      .select((eb) => ['check_id', eb.fn.countAll<number>().as('n')])
      .where(
        'check_id',
        'in',
        evaluations.map((e) => e.bundle.check_id),
      )
      .groupBy('check_id')
      .execute();
    const countById = new Map(counts.map((c) => [c.check_id, Number(c.n)]));
    return evaluations.map(({ bundle, vote, members }) => ({
      id: bundle.id,
      name: bundle.name,
      description: bundle.description,
      checkId: bundle.check_id,
      vote,
      members,
      serviceCount: countById.get(bundle.check_id) ?? 0,
      createdAt: bundle.created_at,
      updatedAt: bundle.updated_at,
    }));
  }
}

/** Periodic re-evaluation, so members whose results become stale stop counting. */
export function registerBundleTasks(ctx: { worker: Worker; bundles: BundleService; log: FastifyBaseLogger }): void {
  ctx.worker.schedule(BUNDLE_TASK, BUNDLE_TASK_INTERVAL_MS, async () => {
    await ctx.bundles.recompute();
  });
}
