/**
 * Check state history (`monitor_check_history`).
 *
 * Live recording: every code path that changes `monitor_checks.state` (ingest,
 * bundle evaluation) calls `recordCheckState`, which closes the open interval
 * and opens a new one. New checks get their first open interval on creation.
 *
 * Imported intervals (source = 'import') only fill periods without any other
 * history (see services/history-import.ts).
 */
import type { CheckState } from '@openstatuspage/shared';
import type { DB } from '../db/index.js';
import { newId } from '../lib/ids.js';

type Writer = Pick<DB, 'selectFrom' | 'updateTable' | 'insertInto'>;

/** Makes `state` the open (current) interval of a check, starting at `at`. No-op if it already is. */
export async function recordCheckState(db: Writer, checkId: string, state: CheckState, at: string): Promise<void> {
  const open = await db
    .selectFrom('monitor_check_history')
    .select(['id', 'state', 'started_at'])
    .where('check_id', '=', checkId)
    .where('ended_at', 'is', null)
    .execute();
  if (open.length === 1 && open[0]!.state === state) return;
  if (open.length > 0) {
    // Never produce a negative interval when clocks or timestamps disagree.
    for (const row of open) {
      await db
        .updateTable('monitor_check_history')
        .set({ ended_at: row.started_at > at ? row.started_at : at })
        .where('id', '=', row.id)
        .execute();
    }
  }
  await db
    .insertInto('monitor_check_history')
    .values({ id: newId(), check_id: checkId, state, started_at: at, ended_at: null, source: 'live' })
    .execute();
}
