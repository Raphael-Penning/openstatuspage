/**
 * Leases for background tasks when several instances share one PostgreSQL database.
 *
 * Every task has a row in `task_leases`. Before a worker runs a task it claims the
 * row in one statement (INSERT ... ON CONFLICT DO UPDATE ... WHERE):
 *
 *   - the lease must be free (`locked_until` passed): no two instances run a task
 *     (e.g. the poll of one source, outbox delivery) at the same time;
 *   - for a scheduled run, the task must be due (`last_started_at` at least one
 *     interval ago): a task runs once per interval in the whole deployment, not
 *     once per instance.
 *
 * The holder renews `locked_until` while the task runs and frees it when done. If
 * an instance dies, its lease expires after `ttlMs` and another instance takes
 * over. All times come from the database clock (`clock_timestamp()`), so clock
 * differences between instances do not matter.
 *
 * SQLite runs a single instance and does not use leases (see context.ts).
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { sql } from 'kysely';
import type { DB } from '../db/index.js';

/** Lease lifetime without renewal; an instance that died blocks a task at most this long. */
export const LEASE_TTL_MS = 60_000;
/** Leases unused for this long are removed (e.g. polls of deleted sources). */
export const LEASE_RETENTION_MS = 7 * 86400_000;

/** Coordinates task runs between instances; implemented by TaskLeases. */
export interface TaskCoordinator {
  /** Instance id stored as the lease owner. */
  readonly owner: string;
  /** How often a running task renews its lease. */
  readonly renewEveryMs: number;
  /**
   * Claims the lease of `name`. With `intervalMs` the task must also be due
   * (scheduled run); with null only the lock counts (run now, manual poll).
   */
  claim(name: string, intervalMs: number | null): Promise<boolean>;
  /** Extends a held lease; false when it was lost (expired and taken over). */
  renew(name: string): Promise<boolean>;
  release(name: string): Promise<void>;
}

/**
 * Tolerance for a scheduled run: timers of different instances fire at different
 * moments, so a run counts as due a little before the full interval has passed.
 */
export function scheduleSlackMs(intervalMs: number): number {
  return Math.min(2000, Math.floor(intervalMs / 10));
}

const NOW_MS = sql<string>`(extract(epoch from clock_timestamp()) * 1000)::bigint`;

export class TaskLeases implements TaskCoordinator {
  readonly owner: string;
  readonly ttlMs: number;
  readonly renewEveryMs: number;

  constructor(
    private readonly db: DB,
    options: { owner?: string; ttlMs?: number } = {},
  ) {
    this.owner = options.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.ttlMs = options.ttlMs ?? LEASE_TTL_MS;
    this.renewEveryMs = Math.max(100, Math.floor(this.ttlMs / 3));
  }

  async claim(name: string, intervalMs: number | null): Promise<boolean> {
    const minGap = intervalMs === null ? 0 : Math.max(0, intervalMs - scheduleSlackMs(intervalMs));
    const { rows } = await sql<{ name: string }>`
      insert into task_leases as l (name, owner, locked_until, last_started_at, last_finished_at)
      select ${name}, ${this.owner}, t.now + ${this.ttlMs}::bigint, t.now, null
      from (select ${NOW_MS} as now) t
      on conflict (name) do update
        set owner = excluded.owner, locked_until = excluded.locked_until, last_started_at = excluded.last_started_at
        where (l.locked_until is null or l.locked_until < excluded.last_started_at)
          and (${sql.raw(intervalMs === null ? 'true' : 'false')} or l.last_started_at is null
               or l.last_started_at <= excluded.last_started_at - ${minGap}::bigint)
      returning l.name`.execute(this.db);
    return rows.length > 0;
  }

  async renew(name: string): Promise<boolean> {
    const result = await this.db
      .updateTable('task_leases')
      .set({ locked_until: sql<string>`${NOW_MS} + ${this.ttlMs}::bigint` })
      .where('name', '=', name)
      .where('owner', '=', this.owner)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async release(name: string): Promise<void> {
    await this.db
      .updateTable('task_leases')
      .set({ owner: null, locked_until: null, last_finished_at: NOW_MS })
      .where('name', '=', name)
      .where('owner', '=', this.owner)
      .execute();
  }

  /** Removes free leases that were not used for `olderThanMs` (deleted sources). */
  async purge(olderThanMs = LEASE_RETENTION_MS): Promise<number> {
    const result = await this.db
      .deleteFrom('task_leases')
      .where((eb) => eb.or([eb('locked_until', 'is', null), eb('locked_until', '<', NOW_MS)]))
      .where(sql<boolean>`coalesce(last_started_at, 0) < ${NOW_MS} - ${olderThanMs}::bigint`)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }
}

/**
 * Runs `fn` while holding the lease of `name` (renewed in the background).
 * Without coordinator (SQLite) `fn` simply runs. Returns `{ ran: false }` when
 * another instance holds the lease or (with `intervalMs`) the task is not due.
 */
export async function withLease<T>(
  coordinator: TaskCoordinator | null | undefined,
  name: string,
  intervalMs: number | null,
  fn: () => Promise<T>,
  onLost?: () => void,
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (!coordinator) return { ran: true, value: await fn() };
  if (!(await coordinator.claim(name, intervalMs))) return { ran: false };
  let lost = false;
  const timer = setInterval(() => {
    coordinator.renew(name).then(
      (held) => {
        if (!held && !lost) {
          lost = true;
          onLost?.();
        }
      },
      () => undefined,
    );
  }, coordinator.renewEveryMs);
  timer.unref();
  try {
    return { ran: true, value: await fn() };
  } finally {
    clearInterval(timer);
    await coordinator.release(name).catch(() => undefined);
  }
}
