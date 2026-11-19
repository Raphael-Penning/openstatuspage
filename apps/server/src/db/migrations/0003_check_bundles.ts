import type { Kysely } from 'kysely';

/**
 * Check bundles: several checks (usually of different monitoring sources, e.g.
 * Uptime Kuma instances in different places) vote with a weight on one state.
 * Each bundle owns one check of the virtual "bundle" source (`check_id`), so it
 * links to services like any other check. The virtual source row is created on
 * demand by the application (its config column needs SECRET_KEY).
 * Portable column types only (see 0001_initial).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('check_bundles')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    // The bundle's own check; deleting it removes the bundle.
    .addColumn('check_id', 'text', (c) => c.notNull().unique().references('monitor_checks.id').onDelete('cascade'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('check_bundle_members')
    .addColumn('bundle_id', 'text', (c) => c.notNull().references('check_bundles.id').onDelete('cascade'))
    // A check may belong to several bundles; removing the check removes the membership.
    .addColumn('check_id', 'text', (c) => c.notNull().references('monitor_checks.id').onDelete('cascade'))
    .addColumn('votes', 'integer', (c) => c.notNull().defaultTo(1))
    .addPrimaryKeyConstraint('check_bundle_members_pk', ['bundle_id', 'check_id'])
    .execute();
  await db.schema
    .createIndex('check_bundle_members_check_idx')
    .on('check_bundle_members')
    .column('check_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('check_bundle_members').ifExists().execute();
  await db.schema.dropTable('check_bundles').ifExists().execute();
  // The virtual source (and with it the bundle checks and their service links) goes too.
  await db.deleteFrom('monitor_sources').where('type', '=', 'bundle').execute();
}
