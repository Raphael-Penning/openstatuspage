import type { Kysely } from 'kysely';

/**
 * Crash-safe polling (adapters/runner.ts):
 *
 * - monitor_sources.poll_started_at: set when a poll of the source starts and
 *   cleared when it ends, whatever the outcome. A value left behind means the
 *   process stopped during the poll (e.g. it ran out of memory on the answer).
 * - monitor_sources.poll_aborts: polls in a row that never finished. Scheduled
 *   polls of such a source back off exponentially instead of running again right
 *   after every restart; a finished poll resets it.
 *
 * monitor_sources keeps the row level security of 0007_public_role.
 * Portable column types only (see 0001_initial).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('monitor_sources').addColumn('poll_started_at', 'text').execute();
  await db.schema
    .alterTable('monitor_sources')
    .addColumn('poll_aborts', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('monitor_sources').dropColumn('poll_aborts').execute();
  await db.schema.alterTable('monitor_sources').dropColumn('poll_started_at').execute();
}
