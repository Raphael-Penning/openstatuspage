import { PostgresAdapter, sql, type Kysely } from 'kysely';

/**
 * SSO providers managed in the management UI (services/oidc-providers.ts).
 *
 * - oidc_providers: one OpenID Connect provider per row. `client_secret` holds
 *   the client secret encrypted with SecretBox (SECRET_KEY), never in clear
 *   text. `allowed_domains` and `role_mappings` are JSON text.
 * - user_oidc_identities: the IdP identities linked to a user, by `sub` per
 *   provider. A user may be linked to several providers, but to one identity
 *   per provider. `provider_id` is the id of an oidc_providers row or `env`,
 *   the provider configured with the OIDC_* environment variables (no row, so
 *   no foreign key; deleting a provider deletes its identities in the app).
 *
 * The links of 0.3.x (`users.oidc_subject`, always from the environment
 * provider) move to user_oidc_identities with provider `env`; the column stays
 * (unused, always null) so a downgrade finds it.
 *
 * On PostgreSQL both tables get the row level security of the private tables
 * (0007_public_role): the restricted public role sees no row, holds no
 * privilege on them and gets no view or function in osp_public.
 *
 * Portable column types only (see 0001_initial).
 */

/** Id of the environment provider (ENV_OIDC_PROVIDER_ID in packages/shared). */
const ENV_PROVIDER = 'env';

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function isPostgres(db: Kysely<any>): Promise<boolean> {
  return db.getExecutor().adapter instanceof PostgresAdapter;
}

async function baseSchema(db: Kysely<any>): Promise<string> {
  const { rows } = await sql<{ schema: string }>`select current_schema() as schema`.execute(db);
  return ident(rows[0]!.schema);
}

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('oidc_providers')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('issuer_url', 'text', (c) => c.notNull())
    .addColumn('client_id', 'text', (c) => c.notNull())
    // SecretBox payload (v1.<iv>.<tag>.<data>); null for a public client.
    .addColumn('client_secret', 'text')
    .addColumn('scopes', 'text', (c) => c.notNull())
    .addColumn('auto_create_users', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('allowed_domains', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('role_claim', 'text', (c) => c.notNull())
    .addColumn('role_mappings', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('default_role', 'text', (c) => c.notNull())
    .addColumn('role_sync', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('user_oidc_identities')
    .addColumn('provider_id', 'text', (c) => c.notNull())
    .addColumn('subject', 'text', (c) => c.notNull())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('last_login_at', 'text')
    .addPrimaryKeyConstraint('user_oidc_identities_pk', ['provider_id', 'subject'])
    .addUniqueConstraint('user_oidc_identities_user_provider_key', ['user_id', 'provider_id'])
    .execute();

  // The links of 0.3.x were made by the environment provider.
  await sql`
    insert into user_oidc_identities (provider_id, subject, user_id, created_at, last_login_at)
    select ${ENV_PROVIDER}, oidc_subject, id, updated_at, last_login_at from users where oidc_subject is not null
  `.execute(db);
  await db.updateTable('users').set({ oidc_subject: null }).where('oidc_subject', 'is not', null).execute();

  if (!(await isPostgres(db))) return;
  const b = await baseSchema(db);
  const restricted = `(SELECT ${b}.osp_is_public_role(current_user)) IS NOT TRUE`;
  for (const table of ['oidc_providers', 'user_oidc_identities']) {
    await sql.raw(`REVOKE ALL ON ${b}.${table} FROM PUBLIC`).execute(db);
    await sql.raw(`ALTER TABLE ${b}.${table} ENABLE ROW LEVEL SECURITY`).execute(db);
    await sql.raw(`CREATE POLICY osp_access ON ${b}.${table} USING (true) WITH CHECK (true)`).execute(db);
    await sql
      .raw(`CREATE POLICY osp_public_role ON ${b}.${table} AS RESTRICTIVE USING (${restricted}) WITH CHECK (${restricted})`)
      .execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // Back to one link per user, from the environment provider (others are lost).
  await sql`
    update users set oidc_subject = (
      select i.subject from user_oidc_identities i where i.user_id = users.id and i.provider_id = ${ENV_PROVIDER}
    )
    where exists (select 1 from user_oidc_identities i where i.user_id = users.id and i.provider_id = ${ENV_PROVIDER})
  `.execute(db);
  await db.schema.dropTable('user_oidc_identities').ifExists().execute();
  await db.schema.dropTable('oidc_providers').ifExists().execute();
}
