/**
 * Stores normalized check results and triggers status recomputation.
 * Used by both pollers and push endpoints.
 */
import type { NormalizedCheck } from '../adapters/types.js';
import type { DB } from '../db/index.js';
import { conflict } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { nowIso, toIso } from '../lib/time.js';
import type { StatusEngine } from './status-engine.js';

export interface IngestResult {
  created: number;
  updated: number;
  removed: number;
  stateChanges: number;
}

export class IngestService {
  constructor(
    private readonly db: DB,
    private readonly engine: StatusEngine,
  ) {}

  /**
   * Upserts check results of one source.
   * With `full = true`, checks that are missing from `checks` are deleted
   * (their service links disappear with them).
   * With `guardLinkedChecks`, a full sync that would delete more than half of
   * the checks linked to services is rejected with 409 and nothing is stored:
   * service links are configured by administrators and do not come back when
   * a check reappears later.
   */
  async ingest(
    sourceId: string,
    checks: NormalizedCheck[],
    options: { full: boolean; guardLinkedChecks?: boolean },
  ): Promise<IngestResult> {
    const now = nowIso();
    const result: IngestResult = { created: 0, updated: 0, removed: 0, stateChanges: 0 };
    const affectedCheckIds: string[] = [];
    const servicesOfRemovedChecks: string[] = [];

    // Last result wins when a payload contains duplicates.
    const byExternalId = new Map(checks.map((c) => [c.externalId, c]));

    const existing = await this.db
      .selectFrom('monitor_checks')
      .select(['id', 'external_id', 'state'])
      .where('source_id', '=', sourceId)
      .execute();
    const existingByExternal = new Map(existing.map((c) => [c.external_id, c]));

    if (options.full && options.guardLinkedChecks) {
      await this.assertKeepsLinkedChecks(sourceId, byExternalId);
    }

    await this.db.transaction().execute(async (trx) => {
      for (const check of byExternalId.values()) {
        const checkedAt = check.checkedAt ? safeIso(check.checkedAt) ?? now : now;
        const prev = existingByExternal.get(check.externalId);
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
    return result;
  }

  /**
   * Push counterpart of the poll runner's empty-result guard: a truncated or
   * forged full payload must not wipe most of the service mappings at once.
   */
  private async assertKeepsLinkedChecks(sourceId: string, incoming: Map<string, NormalizedCheck>): Promise<void> {
    const linked = await this.db
      .selectFrom('service_checks')
      .innerJoin('monitor_checks', 'monitor_checks.id', 'service_checks.check_id')
      .select('monitor_checks.external_id')
      .distinct()
      .where('monitor_checks.source_id', '=', sourceId)
      .execute();
    const removed = linked.filter((l) => !incoming.has(l.external_id)).length;
    if (removed > 0 && removed * 2 > linked.length) {
      throw conflict(
        `Full sync rejected: it would remove ${removed} of ${linked.length} checks that are linked to services. ` +
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
  }
}

function truncate(value: string | null | undefined, max = 4000): string | null {
  if (value == null) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function safeIso(value: string): string | null {
  try {
    return toIso(value);
  } catch {
    return null;
  }
}
