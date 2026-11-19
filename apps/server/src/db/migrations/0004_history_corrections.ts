import type { Kysely } from 'kysely';

/**
 * Corrections of historical data, applied as a layer over the measured
 * `service_status_history` (which itself is never changed):
 *
 * - `status_corrections` (+ services): a status override for a time range with
 *   an internal reason and an optional public note.
 * - `maintenances.retroactive`: the window had already started when it was
 *   entered; it counts as "maintenance" in the corrected history.
 *
 * Portable column types only (see 0001_initial).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('status_corrections')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('starts_at', 'text', (c) => c.notNull())
    .addColumn('ends_at', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    // Internal only, never returned by public endpoints.
    .addColumn('reason', 'text', (c) => c.notNull())
    .addColumn('show_public', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('public_note', 'text')
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex('status_corrections_range_idx')
    .on('status_corrections')
    .columns(['ends_at', 'starts_at'])
    .execute();

  await db.schema
    .createTable('status_correction_services')
    .addColumn('correction_id', 'text', (c) => c.notNull().references('status_corrections.id').onDelete('cascade'))
    .addColumn('service_id', 'text', (c) => c.notNull().references('services.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('status_correction_services_pk', ['correction_id', 'service_id'])
    .execute();
  await db.schema
    .createIndex('status_correction_services_service_idx')
    .on('status_correction_services')
    .column('service_id')
    .execute();

  await db.schema
    .alterTable('maintenances')
    .addColumn('retroactive', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('maintenances').dropColumn('retroactive').execute();
  await db.schema.dropTable('status_correction_services').ifExists().execute();
  await db.schema.dropTable('status_corrections').ifExists().execute();
}
