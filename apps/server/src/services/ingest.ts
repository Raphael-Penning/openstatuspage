/**
 * Stores normalized check results and triggers status recomputation.
 * Used by both pollers and push endpoints.
 */
import type { NormalizedCheck } from '../adapters/types.js';
import type { DB } from '../db/index.js';
import { conflict } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { nowIso, toIso } from '../lib/time.js';
import { MAX_CLOCK_SKEW_MS } from './bundle-rules.js';
import type { BundleService } from './bundles.js';
import { recordCheckState } from './check-history.js';
import type { StatusEngine } from './status-engine.js';

export interface IngestResult {
  created: number;
  updated: number;
  removed: number;
  stateChanges: number;
}

/** Default for MAX_CHECKS_PER_SOURCE. */
export const DEFAULT_MAX_CHECKS_PER_SOURCE = 20_000;

export interface IngestOptions {
  /** Upper bound for the number of checks of one source (MAX_CHECKS_PER_SOURCE). */
  maxChecksPerSource?: number;
}

export class IngestService {
  private readonly maxChecksPerSource: number;

  constructor(
    private readonly db: DB,
    private readonly engine: StatusEngine,
    /** Re-evaluates check bundles whose members belong to the ingested source. */
    private readonly bundles?: BundleService,
    options: IngestOptions = {},
  ) {
    this.maxChecksPerSource = options.maxChecksPerSource ?? DEFAULT_MAX_CHECKS_PER_SOURCE;
  }

  /**
   * Upserts check results of one source.
   * A result older than the stored result of its check (by `checkedAt`) is
   * ignored, so delayed or replayed results cannot overwrite newer state.
   * A call that would leave the source with more than `maxChecksPerSource`
   * checks is rejected with 409 and nothing is stored.
   * With `full = true`, checks that are missing from `checks` are deleted
   * (their service links disappear with them).
   * With `guardLinkedChecks`, a full sync that would delete more than half of
   * the checks linked to services or used as bundle members is rejected with
   * 409 and nothing is stored: service links and bundle memberships are
   * configured by administrators and do not come back when a check reappears.
   * With `deferBundleRecompute` (poll path), the source's bundles are not
   * re-evaluated here because `recordPoll` follows and does it with the new
   * poll outcome; bundles that lost a removed member are still re-evaluated.
   */
  async ingest(
    sourceId: string,
    checks: NormalizedCheck[],
    options: { full: boolean; guardLinkedChecks?: boolean; deferBundleRecompute?: boolean },
  ): Promise<IngestResult> {
    const now = nowIso();
    const result: IngestResult = { created: 0, updated: 0, removed: 0, stateChanges: 0 };
    const affectedCheckIds: string[] = [];
    const servicesOfRemovedChecks: string[] = [];
    const bundlesOfRemovedChecks: string[] = [];

    // Last result wins when a payload contains duplicates.
    const byExternalId = new Map(checks.map((c) => [c.externalId, c]));

    // Read and guard inside the transaction, so two concurrent full syncs cannot
    // each pass the guard against the same snapshot and together remove all links.
    await this.db.transaction().execute(async (trx) => {
      if (options.full) {
        // Serialise full syncs of one source (row lock on PostgreSQL; SQLite
        // transactions already run one at a time).
        await trx
          .updateTable('monitor_sources')
          .set({ id: sourceId })
          .where('id', '=', sourceId)
          .execute();
      }
      const existing = await trx
        .selectFrom('monitor_checks')
        .select(['id', 'external_id', 'state', 'last_check_at'])
        .where('source_id', '=', sourceId)
        .execute();
      const existingByExternal = new Map(existing.map((c) => [c.external_id, c]));

      const added = [...byExternalId.keys()].filter((id) => !existingByExternal.has(id)).length;
      const total = options.full ? byExternalId.size : existing.length + added;
      if (added > 0 && total > this.maxChecksPerSource) {
        throw conflict(
          `This would give the source ${total} checks; at most ${this.maxChecksPerSource} are allowed (MAX_CHECKS_PER_SOURCE). ` +
            'Nothing was stored. Remove checks that are no longer needed or split the source.',
        );
      }

      if (options.full && options.guardLinkedChecks) {
        await this.assertKeepsLinkedChecks(trx, sourceId, byExternalId);
      }

      for (const check of byExternalId.values()) {
        const checkedAt = resultTime(check.checkedAt, now);
        const prev = existingByExternal.get(check.externalId);
        // Out of order (a delayed or replayed result): the stored result is newer, keep it.
        if (prev && isOlder(checkedAt, prev.last_check_at, now)) continue;
        if (!prev) {
          const id = newId();
          await trx
            .insertInto('monitor_checks')
            .values({
              id,
              source_id: sourceId,
              external_id: check.externalId,
              name: check.name ?? check.externalId,
              host: check.host ?? null,
              state: check.state,
              output: truncate(check.output),
              last_check_at: checkedAt,
              last_state_change_at: now,
              created_at: now,
              updated_at: now,
            })
            .execute();
          await recordCheckState(trx, id, check.state, now);
          result.created++;
        } else {
          const changed = prev.state !== check.state;
          await trx
            .updateTable('monitor_checks')
            .set({
              // Partial pushes (e.g. state only) keep the stored metadata.
              ...(check.name !== undefined ? { name: check.name } : {}),
              ...(check.host !== undefined ? { host: check.host } : {}),
              ...(check.output !== undefined
                ? { output: truncate(check.output) }
                : changed
                  ? { output: null }
                  : {}),
              state: check.state,
              last_check_at: checkedAt,
              updated_at: now,
              ...(changed ? { last_state_change_at: now } : {}),
            })
            .where('id', '=', prev.id)
            .execute();
          result.updated++;
          if (changed) {
            await recordCheckState(trx, prev.id, check.state, now);
            result.stateChanges++;
            affectedCheckIds.push(prev.id);
          }
        }
      }

      if (options.full) {
        const stale = existing.filter((c) => !byExternalId.has(c.external_id));
        if (stale.length > 0) {
          // Recompute linked services after deletion: collect them first.
          const linked = await trx
            .selectFrom('service_checks')
            .select('service_id')
            .where(
              'check_id',
              'in',
              stale.map((c) => c.id),
            )
            .execute();
          // Their bundle memberships cascade too: re-evaluate those bundles afterwards.
          const memberships = await trx
            .selectFrom('check_bundle_members')
            .select('bundle_id')
            .where(
              'check_id',
              'in',
              stale.map((c) => c.id),
            )
            .execute();
          bundlesOfRemovedChecks.push(...memberships.map((m) => m.bundle_id));
          await trx
            .deleteFrom('monitor_checks')
            .where(
              'id',
              'in',
              stale.map((c) => c.id),
            )
            .execute();
          result.removed = stale.length;
          servicesOfRemovedChecks.push(...linked.map((l) => l.service_id));
        }
      }
    });

    await this.engine.recomputeForChecks(affectedCheckIds);
    await this.engine.recompute(servicesOfRemovedChecks);
    // Fresh results (even without a state change) can bring a stale member back into the vote.
    if (this.bundles) {
      if (!options.deferBundleRecompute) await this.bundles.recomputeForSource(sourceId);
      if (bundlesOfRemovedChecks.length > 0) await this.bundles.recompute(bundlesOfRemovedChecks);
    }
    return result;
  }

  /**
   * Push counterpart of the poll runner's empty-result guard: a truncated or
   * forged full payload must not wipe most of the service mappings at once.
   */
  private async assertKeepsLinkedChecks(
    db: Pick<DB, 'selectFrom'>,
    sourceId: string,
    incoming: Map<string, NormalizedCheck>,
  ): Promise<void> {
    // Checks linked to services or used as bundle members (each counted once).
    const linked = await db
      .selectFrom('monitor_checks')
      .select('monitor_checks.external_id')
      .where('monitor_checks.source_id', '=', sourceId)
      .where((eb) =>
        eb.or([
          eb.exists(
            eb.selectFrom('service_checks').select('check_id').whereRef('service_checks.check_id', '=', 'monitor_checks.id'),
          ),
          eb.exists(
            eb
              .selectFrom('check_bundle_members')
              .select('check_id')
              .whereRef('check_bundle_members.check_id', '=', 'monitor_checks.id'),
          ),
        ]),
      )
      .execute();
    const removed = linked.filter((l) => !incoming.has(l.external_id)).length;
    if (removed > 0 && removed * 2 > linked.length) {
      throw conflict(
        `Full sync rejected: it would remove ${removed} of ${linked.length} checks that are linked to services or bundles. ` +
          'Include these checks, unlink them in the admin UI first, or push without "full".',
      );
    }
  }

  /** Records the outcome of a poll on the source row. */
  async recordPoll(sourceId: string, ok: boolean, error?: string | null): Promise<void> {
    await this.db
      .updateTable('monitor_sources')
      .set({ last_poll_at: nowIso(), last_poll_ok: ok ? 1 : 0, last_error: ok ? null : truncate(error, 1000) })
      .where('id', '=', sourceId)
      .execute();
    // A failed poll takes the source's checks out of bundle votes (and a good one brings them back).
    await this.bundles?.recomputeForSource(sourceId);
  }
}

function truncate(value: string | null | undefined, max = 4000): string | null {
  if (value == null) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Time of a result: the producer's time, but never later than the server clock
 * plus MAX_CLOCK_SKEW_MS (a later time is replaced by the server time), so a
 * result cannot stay fresh in bundle votes longer than the stale window.
 */
function resultTime(value: string | null | undefined, now: string): string {
  const at = value ? safeIso(value) : null;
  if (!at || Date.parse(at) > Date.parse(now) + MAX_CLOCK_SKEW_MS) return now;
  return at;
}

/**
 * Whether a result time lies before the stored one. A stored time beyond the
 * clock skew (written before ingest capped result times) does not count, so it
 * cannot block newer results.
 */
function isOlder(checkedAt: string, stored: string | null, now: string): boolean {
  if (!stored) return false;
  const storedAt = Date.parse(stored);
  if (!Number.isFinite(storedAt) || storedAt > Date.parse(now) + MAX_CLOCK_SKEW_MS) return false;
  return Date.parse(checkedAt) < storedAt;
}

function safeIso(value: string): string | null {
  try {
    return toIso(value);
  } catch {
    return null;
  }
}
