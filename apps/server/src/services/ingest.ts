/**
 * Stores normalized check results and triggers status recomputation.
 * Used by both pollers and push endpoints.
 */
import type { NormalizedCheck } from '../adapters/types.js';
import type { DB } from '../db/index.js';
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
   */
  async ingest(sourceId: string, checks: NormalizedCheck[], options: { full: boolean }): Promise<IngestResult> {
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
              name: check.name,
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
              name: check.name,
              host: check.host ?? null,
              state: check.state,
              output: truncate(check.output),
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
