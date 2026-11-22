import type { Kysely } from 'kysely';

/**
 * Cumulative guard for full syncs pushed to a source (services/ingest.ts):
 *
 * - monitor_sources.full_sync_window_at: start of the current 24-hour window.
 * - monitor_sources.full_sync_removed_links: checks linked to services or bundles
 *   that full pushes removed within that window.
 *
 * Together they keep repeated full pushes from removing more than half of the
 * linked checks per window, instead of half per request.
 * monitor_sources keeps the row level security of 0007_public_role.
 * Portable column types only (see 0001_initial).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('monitor_sources').addColumn('full_sync_window_at', 'text').execute();
  await db.schema
    .alterTable('monitor_sources')
    .addColumn('full_sync_removed_links', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('monitor_sources').dropColumn('full_sync_removed_links').execute();
  await db.schema.alterTable('monitor_sources').dropColumn('full_sync_window_at').execute();
}
