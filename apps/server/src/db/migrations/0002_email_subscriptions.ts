import type { Kysely } from 'kysely';

/**
 * Email subscriptions: subscribers (double opt-in), their selected services,
 * an outbox for mail delivery and the per-maintenance notification flag.
 * Portable column types only (see 0001_initial).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('subscribers')
    .addColumn('id', 'text', (c) => c.primaryKey())
    // Always stored lowercase.
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('locale', 'text', (c) => c.notNull().defaultTo('en'))
    .addColumn('all_services', 'integer', (c) => c.notNull().defaultTo(1))
    // Random salt for the HMAC-derived confirm/manage tokens; the tokens themselves are never stored.
    .addColumn('token_salt', 'text', (c) => c.notNull())
    .addColumn('confirmed_at', 'text')
    .addColumn('confirmation_sent_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex('subscribers_pending_idx')
    .on('subscribers')
    .columns(['confirmed_at', 'created_at'])
    .execute();

  await db.schema
    .createTable('subscriber_services')
    .addColumn('subscriber_id', 'text', (c) => c.notNull().references('subscribers.id').onDelete('cascade'))
    .addColumn('service_id', 'text', (c) => c.notNull().references('services.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('subscriber_services_pk', ['subscriber_id', 'service_id'])
    .execute();
  await db.schema
    .createIndex('subscriber_services_service_idx')
    .on('subscriber_services')
    .column('service_id')
    .execute();

  await db.schema
    .createTable('email_outbox')
    .addColumn('id', 'text', (c) => c.primaryKey())
    // Null for mails not tied to a subscriber (e.g. test mails). Deleting a subscriber drops its mails.
    .addColumn('subscriber_id', 'text', (c) => c.references('subscribers.id').onDelete('cascade'))
    .addColumn('recipient', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('subject', 'text', (c) => c.notNull())
    .addColumn('text_body', 'text', (c) => c.notNull())
    .addColumn('html_body', 'text', (c) => c.notNull())
    // JSON object of extra headers (List-Unsubscribe, ...).
    .addColumn('headers', 'text')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('pending'))
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'text', (c) => c.notNull())
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('sent_at', 'text')
    .execute();
  await db.schema
    .createIndex('email_outbox_status_next_idx')
    .on('email_outbox')
    .columns(['status', 'next_attempt_at'])
    .execute();
  await db.schema.createIndex('email_outbox_subscriber_idx').on('email_outbox').column('subscriber_id').execute();

  // One column per statement: SQLite cannot add several columns in one ALTER TABLE.
  await db.schema
    .alterTable('maintenances')
    .addColumn('notify_subscribers', 'integer', (c) => c.notNull().defaultTo(1))
    .execute();
  await db.schema.alterTable('maintenances').addColumn('reminder_sent_at', 'text').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('maintenances').dropColumn('reminder_sent_at').execute();
  await db.schema.alterTable('maintenances').dropColumn('notify_subscribers').execute();
  for (const t of ['email_outbox', 'subscriber_services', 'subscribers']) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
