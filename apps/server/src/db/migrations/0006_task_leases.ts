import { sql, type Kysely } from 'kysely';

/**
 * Several instances on one PostgreSQL database.
 *
 * - task_leases: one row per background task (`email-delivery`, `poll:<source id>`, ...).
 *   A worker runs a task only after claiming its row: `locked_until` keeps other
 *   instances out while it runs, `last_started_at` stops them from running it
 *   again before the interval has passed. Times are milliseconds since the epoch
 *   taken from the database clock, so the clocks of the instances do not matter.
 *   Only used on PostgreSQL (lib/task-leases.ts); SQLite runs a single instance.
 * - history_imports_active_idx: at most one active import job per source, also
 *   when two admin instances start one at the same moment.
 *
 * Portable column types only (see 0001_initial).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('task_leases')
    .addColumn('name', 'text', (c) => c.primaryKey())
    // Instance that holds the lease; null when free.
    .addColumn('owner', 'text')
    .addColumn('locked_until', 'bigint')
    .addColumn('last_started_at', 'bigint')
    .addColumn('last_finished_at', 'bigint')
    .execute();

  await sql`create unique index history_imports_active_idx on history_imports (source_id) where status in ('fetching', 'ready', 'applying')`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index if exists history_imports_active_idx`.execute(db);
  await db.schema.dropTable('task_leases').ifExists().execute();
}
