import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';

/**
 * Check state history and history import.
 *
 * - monitor_check_history: state intervals per check. Recorded live from now on
 *   (every state change closes the open row and opens a new one) and filled by
 *   history imports (source = 'import') for periods without live data.
 * - service_status_history.source: 'live' (status engine), 'import' (rebuilt
 *   from imported check history) or 'import_explicit' (service status from a
 *   CSV import). Imports never replace 'live' segments.
 * - history_imports / history_import_intervals: import jobs and the data they
 *   fetched, kept until the job is applied or discarded.
 *
 * Portable column types only (see 0001_initial).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('monitor_check_history')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('check_id', 'text', (c) => c.notNull().references('monitor_checks.id').onDelete('cascade'))
    .addColumn('state', 'text', (c) => c.notNull())
    .addColumn('started_at', 'text', (c) => c.notNull())
    // null = current state (open interval)
    .addColumn('ended_at', 'text')
    .addColumn('source', 'text', (c) => c.notNull().defaultTo('live'))
    .execute();
  await db.schema
    .createIndex('monitor_check_history_check_idx')
    .on('monitor_check_history')
    .columns(['check_id', 'started_at'])
    .execute();

  await db.schema
    .alterTable('service_status_history')
    .addColumn('source', 'text', (c) => c.notNull().defaultTo('live'))
    .execute();

  await db.schema
    .createTable('history_imports')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('source_id', 'text', (c) => c.notNull().references('monitor_sources.id').onDelete('cascade'))
    // fetching | ready | applying | completed | failed | cancelled
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('range_from', 'text', (c) => c.notNull())
    .addColumn('range_to', 'text', (c) => c.notNull())
    .addColumn('only_linked', 'integer', (c) => c.notNull().defaultTo(1))
    // JSON: { phase, done, total }
    .addColumn('progress', 'text')
    // AES-256-GCM encrypted one-off credentials; cleared as soon as fetching ends.
    .addColumn('credentials_encrypted', 'text')
    // JSON: what was fetched (matched/unmatched ids, warnings)
    .addColumn('fetch_summary', 'text')
    // JSON: HistoryImportPreview
    .addColumn('preview', 'text')
    // JSON: HistoryImportResult
    .addColumn('result', 'text')
    .addColumn('error', 'text')
    // HistoryImportErrorCode (translated in the UI); `error` holds the English detail.
    .addColumn('error_code', 'text')
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('finished_at', 'text')
    .execute();
  await db.schema
    .createIndex('history_imports_source_idx')
    .on('history_imports')
    .columns(['source_id', 'created_at'])
    .execute();

  await db.schema
    .createTable('history_import_intervals')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('import_id', 'text', (c) => c.notNull().references('history_imports.id').onDelete('cascade'))
    // Exactly one of check_id (check state) and service_id (service status, CSV only) is set.
    .addColumn('check_id', 'text', (c) => c.references('monitor_checks.id').onDelete('cascade'))
    .addColumn('service_id', 'text', (c) => c.references('services.id').onDelete('cascade'))
    .addColumn('state', 'text', (c) => c.notNull())
    .addColumn('started_at', 'text', (c) => c.notNull())
    .addColumn('ended_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex('history_import_intervals_import_idx')
    .on('history_import_intervals')
    .column('import_id')
    .execute();

  // The current state of every existing check is known since its last state change.
  const checks = await db
    .selectFrom('monitor_checks')
    .select(['id', 'state', 'last_state_change_at', 'created_at'])
    .execute();
  const rows = checks.map((c: { id: string; state: string; last_state_change_at: string | null; created_at: string }) => ({
    id: randomUUID(),
    check_id: c.id,
    state: c.state,
    started_at: c.last_state_change_at ?? c.created_at,
    ended_at: null,
    source: 'live',
  }));
  for (let i = 0; i < rows.length; i += 200) {
    await db.insertInto('monitor_check_history').values(rows.slice(i, i + 200)).execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('history_import_intervals').ifExists().execute();
  await db.schema.dropTable('history_imports').ifExists().execute();
  await db.schema.dropTable('monitor_check_history').ifExists().execute();
  await db.deleteFrom('service_status_history').where('source', '<>', 'live').execute();
  await db.schema.alterTable('service_status_history').dropColumn('source').execute();
}
