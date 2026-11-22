import { PostgresAdapter, sql, type Kysely } from 'kysely';

/**
 * Hardening of the PostgreSQL functions of the restricted public role
 * (0007_public_role, 0009_private_pages). A no-op on SQLite.
 *
 * - Every SECURITY DEFINER function in osp_public and every helper in the table
 *   schema runs with `search_path = pg_catalog, pg_temp`. Their bodies name every
 *   table and helper with its schema, so only built-ins are looked up on the path,
 *   and those always resolve to pg_catalog. Before, the table schema was on the
 *   path: a role that may CREATE there (PUBLIC on PostgreSQL 14 and older, and on
 *   clusters upgraded from them) could place an exact-type overload of a
 *   polymorphic built-in (cardinality(text[]), jsonb_agg(jsonb), ...) that the
 *   functions would then call with the owner's rights.
 * - osp_grant_public_role refuses a public role that may create objects in the
 *   table schema or in osp_public (the migrating instance does not start), and
 *   osp_public.connection_restricted reports such a role as not restricted (the
 *   public instance does not start). deploy/postgres/harden.sql revokes CREATE on
 *   the schema "public" from PUBLIC. The grant function of 0007 stays as
 *   osp_grant_public_role_privileges and is called by the new one.
 * - osp_private_page_id is VOLATILE (it reads clock_timestamp()).
 * - osp_public.subscribe claims the mail throttle with one conditional UPDATE, like
 *   services/subscriptions.ts.
 *
 * When osp_public does not exist yet, its part (hardenPublicSchema) runs in
 * ensurePublicSchema (db/public-role.ts) right after the schema is created.
 */

const PIN = 'SET search_path = pg_catalog, pg_temp';
const PUBLIC_SCHEMA = 'osp_public';
const CONFIRMATION_THROTTLE = '10 minutes';
/** The address pattern of 0007_public_role (the application's z.email(), lower case). */
const EMAIL_PATTERN = "^(?:[a-z0-9_'+-]+[.])*[a-z0-9_'+-]*[a-z0-9_+-]@(?:[a-z0-9][a-z0-9-]*[.])+[a-z]{2,}$";

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Helpers in the table schema (0007, 0009); none is callable by the public role but the policy check. */
const BASE_FUNCTIONS = [
  'osp_is_public_role(name)',
  'osp_iso(timestamptz)',
  'osp_token_matches(text, text)',
  'osp_subscriptions_enabled()',
  'osp_subscription_row(text)',
  'osp_check_subscription_input(text, boolean, text[])',
  'osp_queue_account_mail(text, text, text, text)',
  'osp_private_page_id(text)',
];

/** The functions of the public role in osp_public (0007, 0009). */
const PUBLIC_FUNCTIONS = [
  'subscribe(text, text, text, boolean, text[], text, text, text, text)',
  'subscription_confirm(text, text)',
  'subscription_get(text, text)',
  'subscription_update(text, text, text, boolean, text[])',
  'subscription_delete(text, text)',
  'connection_restricted()',
  'private_page(text)',
  'private_page_services(text)',
  'private_page_history(text, text, text)',
  'private_page_corrections(text, text, text)',
  'private_page_retroactive_maintenances(text, text)',
  'private_page_incidents(text, text)',
  'private_page_maintenances(text, text)',
];

interface Schema {
  /** Quoted name of the table schema. */
  b: string;
  /** Its plain name (for has_schema_privilege). */
  name: string;
}

async function isPostgres(db: Kysely<any>): Promise<boolean> {
  return db.getExecutor().adapter instanceof PostgresAdapter;
}

async function tableSchema(db: Kysely<any>): Promise<Schema> {
  const { rows } = await sql<{ schema: string }>`select current_schema() as schema`.execute(db);
  const name = rows[0]!.schema;
  return { b: ident(name), name };
}

async function publicSchemaExists(db: Kysely<any>): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`select to_regnamespace(${PUBLIC_SCHEMA}) is not null as found`.execute(db);
  return rows[0]?.found === true;
}

/** Whether `role` may create objects in the table schema or in osp_public (SQL expression). */
const mayCreate = (role: string, schema: Schema) =>
  `(has_schema_privilege(${role}, ${literal(schema.name)}, 'CREATE')
    OR (to_regnamespace(${literal(PUBLIC_SCHEMA)}) IS NOT NULL AND has_schema_privilege(${role}, ${literal(PUBLIC_SCHEMA)}, 'CREATE')))`;

function baseStatements(schema: Schema): string[] {
  const { b } = schema;
  const out: string[] = [];
  for (const fn of BASE_FUNCTIONS) out.push(`ALTER FUNCTION ${b}.${fn} ${PIN}`);
  out.push(`ALTER FUNCTION ${b}.osp_private_page_id(text) VOLATILE`);

  // The grant function of 0007 does the grants; the new one adds the schema check.
  out.push(`ALTER FUNCTION ${b}.osp_grant_public_role(text) RENAME TO osp_grant_public_role_privileges`);
  out.push(`ALTER FUNCTION ${b}.osp_grant_public_role_privileges(text) ${PIN}`);
  out.push(`REVOKE ALL ON FUNCTION ${b}.osp_grant_public_role_privileges(text) FROM PUBLIC`);
  out.push(`CREATE FUNCTION ${b}.osp_grant_public_role(p_role text) RETURNS boolean
    LANGUAGE plpgsql VOLATILE ${PIN} AS $$
    BEGIN
      IF NOT ${b}.osp_grant_public_role_privileges(p_role) THEN
        RETURN false;
      END IF;
      -- The grants above took CREATE from the role itself; what is left comes from PUBLIC.
      IF ${mayCreate('p_role', schema)} THEN
        RAISE EXCEPTION 'The public database role "%" may create objects in the schema % or osp_public (CREATE granted to PUBLIC, the default before PostgreSQL 15): run REVOKE CREATE ON SCHEMA % FROM PUBLIC (deploy/postgres/harden.sql)',
          p_role, ${literal(schema.name)}, ${literal(b)} USING ERRCODE = '42501';
      END IF;
      RETURN true;
    END
    $$`);
  out.push(`REVOKE ALL ON FUNCTION ${b}.osp_grant_public_role(text) FROM PUBLIC`);
  return out;
}

function publicStatements(schema: Schema): string[] {
  const { b } = schema;
  const s = ident(PUBLIC_SCHEMA);
  const out: string[] = [];

  // Same as 0007, but the mail throttle is claimed with one conditional UPDATE.
  out.push(`CREATE OR REPLACE FUNCTION ${s}.subscribe(p_id text, p_email text, p_locale text, p_all_services boolean,
      p_service_ids text[], p_token_salt text, p_confirm_token_hash text, p_manage_token_hash text, p_token_key text)
    RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER ${PIN} AS $$
    DECLARE
      v_email text := lower(btrim(p_email));
      v_now text := ${b}.osp_iso(clock_timestamp());
      v_ids text[];
      v_sub ${b}.subscribers;
    BEGIN
      IF NOT ${b}.osp_subscriptions_enabled() THEN
        RAISE EXCEPTION 'Subscriptions are disabled' USING ERRCODE = '55000';
      END IF;
      IF p_id IS NULL OR p_id !~ '^[A-Za-z0-9_-]{1,64}$' THEN
        RAISE EXCEPTION 'Invalid id' USING ERRCODE = '22023';
      END IF;
      IF v_email IS NULL OR length(v_email) > 254
        OR v_email !~ ${literal(EMAIL_PATTERN)} THEN
        RAISE EXCEPTION 'Invalid email' USING ERRCODE = '22023';
      END IF;
      v_ids := ${b}.osp_check_subscription_input(p_locale, p_all_services, p_service_ids);
      IF p_token_salt IS NULL OR p_token_salt !~ '^[A-Za-z0-9_-]{16,64}$' THEN
        RAISE EXCEPTION 'Invalid token salt' USING ERRCODE = '22023';
      END IF;
      IF p_confirm_token_hash IS NULL OR p_confirm_token_hash !~ '^[0-9a-f]{64}$'
        OR p_manage_token_hash IS NULL OR p_manage_token_hash !~ '^[0-9a-f]{64}$'
        OR p_confirm_token_hash = p_manage_token_hash THEN
        RAISE EXCEPTION 'Invalid token hash' USING ERRCODE = '22023';
      END IF;
      IF p_token_key IS NULL OR p_token_key !~ '^[A-Za-z0-9_-]{1,64}$' THEN
        RAISE EXCEPTION 'Invalid token key' USING ERRCODE = '22023';
      END IF;

      SELECT * INTO v_sub FROM ${b}.subscribers s WHERE s.email = v_email FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO ${b}.subscribers (id, email, locale, all_services, token_salt, confirmed_at, confirmation_sent_at,
          created_at, updated_at, confirm_token_hash, manage_token_hash, token_key)
        VALUES (p_id, v_email, p_locale, CASE WHEN p_all_services THEN 1 ELSE 0 END, p_token_salt, NULL, NULL,
          v_now, v_now, p_confirm_token_hash, p_manage_token_hash, p_token_key)
        ON CONFLICT DO NOTHING
        RETURNING * INTO v_sub;
        -- A concurrent request for the same address: that one queues the mail.
        IF NOT FOUND THEN
          RETURN;
        END IF;
        INSERT INTO ${b}.subscriber_services (subscriber_id, service_id) SELECT v_sub.id, unnest(v_ids);
        PERFORM ${b}.osp_queue_account_mail(v_sub.id, v_sub.email, 'confirm', v_now);
        RETURN;
      END IF;
      -- Existing address: preferences never change without the manage token. Mails are throttled:
      -- only the request whose UPDATE claims the slot queues one.
      UPDATE ${b}.subscribers s SET confirmation_sent_at = v_now
        WHERE s.id = v_sub.id AND (s.confirmation_sent_at IS NULL
          OR s.confirmation_sent_at < ${b}.osp_iso(clock_timestamp() - interval ${literal(CONFIRMATION_THROTTLE)}));
      IF FOUND THEN
        PERFORM ${b}.osp_queue_account_mail(v_sub.id, v_sub.email,
          CASE WHEN v_sub.confirmed_at IS NULL THEN 'confirm' ELSE 'manage' END, v_now);
      END IF;
    END
    $$`);

  // Restricted: registered, and no CREATE on the table schema or osp_public (also through PUBLIC).
  out.push(`CREATE OR REPLACE FUNCTION ${s}.connection_restricted() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER ${PIN} AS $$
      SELECT ${b}.osp_is_public_role(session_user) AND NOT ${mayCreate('session_user', schema)}
    $$`);

  for (const fn of PUBLIC_FUNCTIONS) out.push(`ALTER FUNCTION ${s}.${fn} ${PIN}`);
  return out;
}

/**
 * The osp_public part of this migration (idempotent). Called by the migration when
 * the schema exists and by ensurePublicSchema right after it created the schema.
 */
export async function hardenPublicSchema(db: Kysely<any>): Promise<void> {
  for (const statement of publicStatements(await tableSchema(db))) {
    await sql.raw(statement).execute(db);
  }
}

export async function up(db: Kysely<any>): Promise<void> {
  if (!(await isPostgres(db))) return;
  for (const statement of baseStatements(await tableSchema(db))) {
    await sql.raw(statement).execute(db);
  }
  if (await publicSchemaExists(db)) await hardenPublicSchema(db);
}

/**
 * Restores the grant function and the volatility of 0007/0009. The functions keep
 * the pinned search_path and the replaced bodies (they behave like before for
 * every valid call).
 */
export async function down(db: Kysely<any>): Promise<void> {
  if (!(await isPostgres(db))) return;
  const { b } = await tableSchema(db);
  await sql.raw(`DROP FUNCTION IF EXISTS ${b}.osp_grant_public_role(text)`).execute(db);
  await sql.raw(`ALTER FUNCTION ${b}.osp_grant_public_role_privileges(text) RENAME TO osp_grant_public_role`).execute(db);
  await sql.raw(`ALTER FUNCTION ${b}.osp_private_page_id(text) STABLE`).execute(db);
}
