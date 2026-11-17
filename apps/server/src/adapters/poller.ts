/**
 * Schedules one poll task per enabled pull-capable monitoring source.
 *
 * `syncPollers` must be called on startup and whenever a monitoring source is
 * created, updated or deleted (the admin API does this). Tasks are named
 * `poll:<sourceId>` and run every `poll_interval_seconds`.
 */
import type { AppContext } from '../context.js';
import type { Worker } from '../worker.js';
import { isPollable } from './index.js';
import { pollAndStore, type RunnerOptions } from './runner.js';

export const POLL_TASK_PREFIX = 'poll:';

export function pollTaskName(sourceId: string): string {
  return `${POLL_TASK_PREFIX}${sourceId}`;
}

/** Per worker: scheduled source id -> fingerprint of the settings the task was created with. */
const scheduled = new WeakMap<Worker, Map<string, string>>();

export async function syncPollers(ctx: AppContext, options: RunnerOptions = {}): Promise<void> {
  const rows = await ctx.db
    .selectFrom('monitor_sources')
    .select(['id', 'type', 'poll_interval_seconds', 'updated_at'])
    .where('enabled', '=', 1)
    .execute();

  let current = scheduled.get(ctx.worker);
  if (!current) {
    current = new Map();
    scheduled.set(ctx.worker, current);
  }

  const wanted = new Map<string, { intervalMs: number; fingerprint: string }>();
  for (const row of rows) {
    if (!isPollable(row.type)) continue;
    const intervalMs = Math.max(10, row.poll_interval_seconds) * 1000;
    // A changed source (config, interval) is rescheduled, which also polls it right away.
    wanted.set(row.id, { intervalMs, fingerprint: `${intervalMs}|${row.updated_at}` });
  }

  for (const id of [...current.keys()]) {
    if (!wanted.has(id)) {
      ctx.worker.unschedule(pollTaskName(id));
      current.delete(id);
    }
  }

  for (const [id, { intervalMs, fingerprint }] of wanted) {
    if (current.get(id) === fingerprint && ctx.worker.has(pollTaskName(id))) continue;
    ctx.worker.schedule(pollTaskName(id), intervalMs, async (signal) => {
      await pollAndStore(ctx, id, { ...options, signal });
    });
    current.set(id, fingerprint);
  }
}
