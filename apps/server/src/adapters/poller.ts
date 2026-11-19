/**
 * Schedules one poll task per enabled pull-capable monitoring source.
 *
 * `syncPollers` must be called on startup and whenever a monitoring source is
 * created, updated or deleted (the admin API does this; a worker also re-reads
 * the sources every 30 s). Tasks are named `poll:<sourceId>` and run every
 * `poll_interval_seconds`. On PostgreSQL every worker schedules every source,
 * and the lease `poll:<sourceId>` makes sure that only one of them polls it
 * per interval (lib/task-leases.ts).
 */
import type { AppContext } from '../context.js';
import type { Worker } from '../worker.js';
import { isPollable } from './index.js';
import { pollAndStore, pollTaskName, type RunnerOptions } from './runner.js';

export { POLL_TASK_PREFIX, pollTaskName } from './runner.js';

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
  const updatedAt = new Map<string, string>();
  for (const row of rows) {
    if (!isPollable(row.type)) continue;
    updatedAt.set(row.id, row.updated_at);
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
    // A source edited after its last poll (on any instance) is polled right away, once.
    // updated_at comes from the clock of the instance that saved the source, the lease
    // times from the database clock: with clock skew between the two, an edited source
    // is polled once more than needed or only at its next interval. Accepted: polls are
    // idempotent and the interval bounds the delay.
    const changedAt = current.has(id) ? Date.parse(updatedAt.get(id) ?? '') : undefined;
    ctx.worker.schedule(
      pollTaskName(id),
      intervalMs,
      async (signal) => {
        // The worker already holds the lease `poll:<id>`.
        await pollAndStore(ctx, id, { ...options, signal, leaseHeld: true });
      },
      { changedAt },
    );
    current.set(id, fingerprint);
  }
}
