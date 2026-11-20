import { PostgresAdapter, sql, type Kysely } from 'kysely';

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
 *   when two admin instances start one at the same moment. Older duplicates of
 *   an active job are marked failed first.
 * - On PostgreSQL task_leases gets the same row level security as the other
 *   private tables of 0007_public_role: the restricted public role sees no row.
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

  // Older versions could leave two active jobs of one source (check-then-insert, crashes):
  // keep the newest, fail the others, so the index can be created.
  const now = new Date().toISOString();
  await sql`
    update history_imports
    set status = 'failed', error = 'Superseded by a newer import of the same source',
      credentials_encrypted = null, finished_at = ${now}, updated_at = ${now}
    where status in ('fetching', 'ready', 'applying')
      and exists (
        select 1 from history_imports h
        where h.source_id = history_imports.source_id and h.status in ('fetching', 'ready', 'applying')
          and (h.created_at > history_imports.created_at or (h.created_at = history_imports.created_at and h.id > history_imports.id))
      )`.execute(db);

  await sql`create unique index history_imports_active_idx on history_imports (source_id) where status in ('fetching', 'ready', 'applying')`.execute(
    db,
  );

  if (db.getExecutor().adapter instanceof PostgresAdapter) {
    const restricted = `(SELECT osp_is_public_role(current_user)) IS NOT TRUE`;
    await sql`alter table task_leases enable row level security`.execute(db);
    await sql`create policy osp_access on task_leases using (true) with check (true)`.execute(db);
    await sql
      .raw(`create policy osp_public_role on task_leases as restrictive using (${restricted}) with check (${restricted})`)
      .execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index if exists history_imports_active_idx`.execute(db);
  await db.schema.dropTable('task_leases').ifExists().execute();
}
