import type { Kysely } from 'kysely';

/**
 * Initial schema. Only portable column types are used (text, integer,
 * double precision) so the same migration runs on SQLite and PostgreSQL.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('settings')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('users')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('role', 'text', (c) => c.notNull())
    .addColumn('password_hash', 'text')
    .addColumn('oidc_subject', 'text', (c) => c.unique())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('last_login_at', 'text')
    .execute();

  await db.schema
    .createTable('sessions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('ip', 'text')
    .addColumn('user_agent', 'text')
    .execute();
  await db.schema.createIndex('sessions_user_idx').on('sessions').column('user_id').execute();

  await db.schema
    .createTable('api_tokens')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('role', 'text', (c) => c.notNull())
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('last_used_at', 'text')
    .execute();

  await db.schema
    .createTable('locations')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('slug', 'text', (c) => c.notNull().unique())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('code', 'text')
    .addColumn('city', 'text')
    .addColumn('country', 'text')
    .addColumn('region', 'text', (c) => c.notNull())
    .addColumn('latitude', 'double precision')
    .addColumn('longitude', 'double precision')
    .addColumn('description', 'text')
    .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('is_public', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('status_override', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('service_groups')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('slug', 'text', (c) => c.notNull().unique())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('is_public', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('collapsed_by_default', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('services')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('slug', 'text', (c) => c.notNull().unique())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('kind', 'text', (c) => c.notNull().defaultTo('service'))
    .addColumn('url', 'text')
    .addColumn('group_id', 'text', (c) => c.references('service_groups.id').onDelete('set null'))
    .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('is_public', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('status_mode', 'text', (c) => c.notNull().defaultTo('auto'))
    .addColumn('manual_status', 'text', (c) => c.notNull().defaultTo('operational'))
    .addColumn('aggregation', 'text', (c) => c.notNull().defaultTo('worst'))
    .addColumn('current_status', 'text', (c) => c.notNull().defaultTo('operational'))
    .addColumn('monitor_status', 'text', (c) => c.notNull().defaultTo('operational'))
    .addColumn('status_changed_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('services_group_idx').on('services').column('group_id').execute();

  await db.schema
    .createTable('service_locations')
    .addColumn('service_id', 'text', (c) => c.notNull().references('services.id').onDelete('cascade'))
    .addColumn('location_id', 'text', (c) => c.notNull().references('locations.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('service_locations_pk', ['service_id', 'location_id'])
    .execute();
  await db.schema
    .createIndex('service_locations_location_idx')
    .on('service_locations')
    .column('location_id')
    .execute();

  await db.schema
    .createTable('monitor_sources')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('config_encrypted', 'text', (c) => c.notNull())
    .addColumn('poll_interval_seconds', 'integer', (c) => c.notNull().defaultTo(60))
    .addColumn('ingest_token_hash', 'text', (c) => c.notNull())
    .addColumn('last_poll_at', 'text')
    .addColumn('last_poll_ok', 'integer')
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('monitor_checks')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('source_id', 'text', (c) => c.notNull().references('monitor_sources.id').onDelete('cascade'))
    .addColumn('external_id', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('host', 'text')
    .addColumn('state', 'text', (c) => c.notNull().defaultTo('unknown'))
    .addColumn('output', 'text')
    .addColumn('last_check_at', 'text')
    .addColumn('last_state_change_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('monitor_checks_source_external_uq', ['source_id', 'external_id'])
    .execute();

  await db.schema
    .createTable('service_checks')
    .addColumn('service_id', 'text', (c) => c.notNull().references('services.id').onDelete('cascade'))
    .addColumn('check_id', 'text', (c) => c.notNull().references('monitor_checks.id').onDelete('cascade'))
    .addColumn('warning_status', 'text')
    .addColumn('critical_status', 'text')
    .addColumn('unknown_status', 'text')
    .addPrimaryKeyConstraint('service_checks_pk', ['service_id', 'check_id'])
    .execute();
  await db.schema.createIndex('service_checks_check_idx').on('service_checks').column('check_id').execute();

  await db.schema
    .createTable('service_status_history')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('service_id', 'text', (c) => c.notNull().references('services.id').onDelete('cascade'))
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('started_at', 'text', (c) => c.notNull())
    .addColumn('ended_at', 'text')
    .execute();
  await db.schema
    .createIndex('service_status_history_service_idx')
    .on('service_status_history')
    .columns(['service_id', 'started_at'])
    .execute();

  await db.schema
    .createTable('incidents')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('impact', 'text', (c) => c.notNull())
    .addColumn('is_public', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('source', 'text', (c) => c.notNull().defaultTo('manual'))
    .addColumn('started_at', 'text', (c) => c.notNull())
    .addColumn('resolved_at', 'text')
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('incidents_started_idx').on('incidents').column('started_at').execute();

  await db.schema
    .createTable('incident_updates')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('incident_id', 'text', (c) => c.notNull().references('incidents.id').onDelete('cascade'))
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('message', 'text', (c) => c.notNull())
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex('incident_updates_incident_idx')
    .on('incident_updates')
    .column('incident_id')
    .execute();

  await db.schema
    .createTable('incident_services')
    .addColumn('incident_id', 'text', (c) => c.notNull().references('incidents.id').onDelete('cascade'))
    .addColumn('service_id', 'text', (c) => c.notNull().references('services.id').onDelete('cascade'))
    .addColumn('status', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('incident_services_pk', ['incident_id', 'service_id'])
    .execute();

  await db.schema
    .createTable('incident_locations')
    .addColumn('incident_id', 'text', (c) => c.notNull().references('incidents.id').onDelete('cascade'))
    .addColumn('location_id', 'text', (c) => c.notNull().references('locations.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('incident_locations_pk', ['incident_id', 'location_id'])
    .execute();

  await db.schema
    .createTable('maintenances')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('scheduled_start', 'text', (c) => c.notNull())
    .addColumn('scheduled_end', 'text', (c) => c.notNull())
    .addColumn('actual_start', 'text')
    .addColumn('actual_end', 'text')
    .addColumn('auto_start', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('auto_complete', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('is_public', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex('maintenances_start_idx')
    .on('maintenances')
    .column('scheduled_start')
    .execute();

  await db.schema
    .createTable('maintenance_updates')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('maintenance_id', 'text', (c) => c.notNull().references('maintenances.id').onDelete('cascade'))
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('message', 'text', (c) => c.notNull())
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('maintenance_services')
    .addColumn('maintenance_id', 'text', (c) => c.notNull().references('maintenances.id').onDelete('cascade'))
    .addColumn('service_id', 'text', (c) => c.notNull().references('services.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('maintenance_services_pk', ['maintenance_id', 'service_id'])
    .execute();

  await db.schema
    .createTable('maintenance_locations')
    .addColumn('maintenance_id', 'text', (c) => c.notNull().references('maintenances.id').onDelete('cascade'))
    .addColumn('location_id', 'text', (c) => c.notNull().references('locations.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('maintenance_locations_pk', ['maintenance_id', 'location_id'])
    .execute();

  await db.schema
    .createTable('audit_log')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('entity_type', 'text', (c) => c.notNull())
    .addColumn('entity_id', 'text')
    .addColumn('details', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('audit_log_created_idx').on('audit_log').column('created_at').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  const tables = [
    'audit_log',
    'maintenance_locations',
    'maintenance_services',
    'maintenance_updates',
    'maintenances',
    'incident_locations',
    'incident_services',
    'incident_updates',
    'incidents',
    'service_status_history',
    'service_checks',
    'monitor_checks',
    'monitor_sources',
    'service_locations',
    'services',
    'service_groups',
    'locations',
    'api_tokens',
    'sessions',
    'users',
    'settings',
  ];
  for (const t of tables) await db.schema.dropTable(t).ifExists().execute();
}
