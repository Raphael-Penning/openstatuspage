import { PostgresAdapter, sql, type Kysely } from 'kysely';

/**
 * PostgreSQL hardening for the restricted database role of APP_ROLE=public
 * (see docs/security-model.md). A no-op on SQLite (single instance, APP_ROLE=all).
 *
 * - Schema `osp_public` with views named like the tables the public code reads.
 *   They expose only public rows and only public columns. The public role connects
 *   with search_path=osp_public, so the unchanged queries of the public code read
 *   the views. Most views are `security_invoker` (PostgreSQL 15+): they run with
 *   the privileges of the public role, which therefore holds SELECT on exactly the
 *   public columns of these tables (and nothing on any other table). A view that
 *   blanks a column (a hidden group id, an unpublished note) runs with the owner's
 *   rights instead (`ownerRights`, as a security_barrier view): the public role
 *   gets no privilege on that base column, so reading the table directly cannot
 *   skip the blanking.
 * - Row level security on every table: a permissive `osp_access` policy keeps
 *   every other role as it was (table owners bypass RLS anyway), a restrictive
 *   `osp_public_role` policy limits registered public roles to public rows and
 *   forbids them every write. Tables without public data have no row at all for them.
 * - SECURITY DEFINER functions in `osp_public` (search_path pinned) for the only
 *   writes of the public role: subscribe, confirm, read/update preferences and
 *   unsubscribe. Tokens are checked against their hashes (0006), mails are queued
 *   without content (the worker renders them).
 * - Functions the migrating role creates are not executable by PUBLIC by default
 *   (ALTER DEFAULT PRIVILEGES): a later helper is only callable where granted.
 * - `osp_grant_public_role(role)`: registers a role as public role and grants it
 *   exactly the above (refusing roles that are members of any role). Instances that migrate call it on every start for
 *   DB_PUBLIC_ROLE (once the role exists, see deploy/postgres/roles.sql).
 *
 * The base tables stay where they are (the schema the migrations run in).
 * Never edit this migration: later changes replace views and functions in a new one.
 */

const SCHEMA = 'osp_public';
const CONFIRMATION_THROTTLE = '10 minutes';

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

interface PublicTable {
  table: string;
  /** Select list of the view: base columns or `expression AS name`. */
  columns: string[];
  /** Base columns the public role may read: every column the view or the filter uses. */
  grant: string[];
  /** Rows the public role may see (view WHERE and RLS policy); null = all rows. */
  filter: ((b: string) => string) | null;
  /** Kysely's own tables get no RLS. */
  rls?: boolean;
  /**
   * The view transforms a column (CASE ... END) that the public role must not read
   * unchanged. Such a column is not in `grant`, and the view runs with the owner's
   * rights (security_barrier), so it can read it. The rows are filtered by the view.
   */
  ownerRights?: boolean;
}

/** `EXISTS` a public row of `table` with id = `column` (an unqualified column of the outer table). */
const isPublic = (b: string, table: string, column: string) =>
  `EXISTS (SELECT 1 FROM ${b}.${table} p WHERE p.id = ${column} AND p.is_public = 1)`;

const PUBLIC_TABLES: PublicTable[] = [
  {
    table: 'settings',
    columns: ['key', 'value', 'updated_at'],
    grant: ['key', 'value', 'updated_at'],
    // Only the page settings; everything they hold is shown on the public page.
    filter: () => `key = 'page'`,
  },
  {
    table: 'service_groups',
    columns: ['id', 'slug', 'name', 'description', 'sort_order', 'is_public', 'collapsed_by_default', 'created_at', 'updated_at'],
    grant: ['id', 'slug', 'name', 'description', 'sort_order', 'is_public', 'collapsed_by_default', 'created_at', 'updated_at'],
    filter: () => 'is_public = 1',
  },
  {
    table: 'services',
    columns: [
      'id',
      'slug',
      'name',
      'description',
      'kind',
      'url',
      // Hidden groups are not revealed.
      `CASE WHEN group_id IN (SELECT g.id FROM %b.service_groups g WHERE g.is_public = 1) THEN group_id END AS group_id`,
      'sort_order',
      'is_public',
      'current_status',
      'status_changed_at',
      'created_at',
      'updated_at',
    ],
    // Not: status_mode, manual_status, aggregation, monitor_status (how the status is made),
    // group_id (only through the view, which blanks hidden groups).
    grant: [
      'id',
      'slug',
      'name',
      'description',
      'kind',
      'url',
      'sort_order',
      'is_public',
      'current_status',
      'status_changed_at',
      'created_at',
      'updated_at',
    ],
    filter: () => 'is_public = 1',
    ownerRights: true,
  },
  {
    table: 'locations',
    columns: [
      'id',
      'slug',
      'name',
      'code',
      'city',
      'country',
      'region',
      'latitude',
      'longitude',
      'description',
      'sort_order',
      'is_public',
      'status_override',
      'created_at',
      'updated_at',
    ],
    grant: [
      'id',
      'slug',
      'name',
      'code',
      'city',
      'country',
      'region',
      'latitude',
      'longitude',
      'description',
      'sort_order',
      'is_public',
      'status_override',
      'created_at',
      'updated_at',
    ],
    filter: () => 'is_public = 1',
  },
  {
    table: 'service_locations',
    columns: ['service_id', 'location_id'],
    grant: ['service_id', 'location_id'],
    filter: (b) => `${isPublic(b, 'services', 'service_id')} AND ${isPublic(b, 'locations', 'location_id')}`,
  },
  {
    table: 'service_status_history',
    columns: ['id', 'service_id', 'status', 'started_at', 'ended_at', 'source'],
    grant: ['id', 'service_id', 'status', 'started_at', 'ended_at', 'source'],
    filter: (b) => isPublic(b, 'services', 'service_id'),
  },
  {
    table: 'incidents',
    // Not: source, created_by.
    columns: ['id', 'title', 'status', 'impact', 'is_public', 'started_at', 'resolved_at', 'created_at', 'updated_at'],
    grant: ['id', 'title', 'status', 'impact', 'is_public', 'started_at', 'resolved_at', 'created_at', 'updated_at'],
    filter: () => 'is_public = 1',
  },
  {
    table: 'incident_updates',
    columns: ['id', 'incident_id', 'status', 'message', 'created_at'],
    grant: ['id', 'incident_id', 'status', 'message', 'created_at'],
    filter: (b) => isPublic(b, 'incidents', 'incident_id'),
  },
  {
    table: 'incident_services',
    columns: ['incident_id', 'service_id', 'status'],
    grant: ['incident_id', 'service_id', 'status'],
    filter: (b) => `${isPublic(b, 'incidents', 'incident_id')} AND ${isPublic(b, 'services', 'service_id')}`,
  },
  {
    table: 'incident_locations',
    columns: ['incident_id', 'location_id'],
    grant: ['incident_id', 'location_id'],
    filter: (b) => `${isPublic(b, 'incidents', 'incident_id')} AND ${isPublic(b, 'locations', 'location_id')}`,
  },
  {
    table: 'maintenances',
    // Not: auto_start, auto_complete, notify_subscribers, reminder_sent_at, created_by.
    columns: [
      'id',
      'title',
      'description',
      'status',
      'scheduled_start',
      'scheduled_end',
      'actual_start',
      'actual_end',
      'is_public',
      'retroactive',
      'created_at',
      'updated_at',
    ],
    grant: [
      'id',
      'title',
      'description',
      'status',
      'scheduled_start',
      'scheduled_end',
      'actual_start',
      'actual_end',
      'is_public',
      'retroactive',
      'created_at',
      'updated_at',
    ],
    filter: () => 'is_public = 1',
  },
  {
    table: 'maintenance_updates',
    columns: ['id', 'maintenance_id', 'status', 'message', 'created_at'],
    grant: ['id', 'maintenance_id', 'status', 'message', 'created_at'],
    filter: (b) => isPublic(b, 'maintenances', 'maintenance_id'),
  },
  {
    table: 'maintenance_services',
    columns: ['maintenance_id', 'service_id'],
    grant: ['maintenance_id', 'service_id'],
    filter: (b) => `${isPublic(b, 'maintenances', 'maintenance_id')} AND ${isPublic(b, 'services', 'service_id')}`,
  },
  {
    table: 'maintenance_locations',
    columns: ['maintenance_id', 'location_id'],
    grant: ['maintenance_id', 'location_id'],
    filter: (b) => `${isPublic(b, 'maintenances', 'maintenance_id')} AND ${isPublic(b, 'locations', 'location_id')}`,
  },
  {
    table: 'status_corrections',
    // Corrections change the public uptime, so their status and range are public. Not: reason, created_by;
    // the note only when it is meant to be shown.
    columns: [
      'id',
      'starts_at',
      'ends_at',
      'status',
      'show_public',
      'CASE WHEN show_public = 1 THEN public_note END AS public_note',
      'created_at',
      'updated_at',
    ],
    // Not public_note: only through the view, which blanks unpublished notes.
    grant: ['id', 'starts_at', 'ends_at', 'status', 'show_public', 'created_at', 'updated_at'],
    filter: (b) =>
      `id IN (SELECT cs.correction_id FROM ${b}.status_correction_services cs ` +
      `JOIN ${b}.services s ON s.id = cs.service_id WHERE s.is_public = 1)`,
    ownerRights: true,
  },
  {
    table: 'status_correction_services',
    columns: ['correction_id', 'service_id'],
    grant: ['correction_id', 'service_id'],
    filter: (b) => isPublic(b, 'services', 'service_id'),
  },
  {
    // The applied schema version (schemaStatus / waitForSchema).
    table: 'kysely_migration',
    columns: ['name', '"timestamp"'],
    grant: ['name', 'timestamp'],
    filter: null,
    rls: false,
  },
];

/** Tables the public role never reads: RLS hides every row from it even if it got privileges by mistake. */
const PRIVATE_TABLES = [
  'users',
  'sessions',
  'api_tokens',
  'audit_log',
  'monitor_sources',
  'monitor_checks',
  'monitor_check_history',
  'service_checks',
  'check_bundles',
  'check_bundle_members',
  'history_imports',
  'history_import_intervals',
  'subscribers',
  'subscriber_services',
  'email_outbox',
];

/**
 * Addresses the subscribe function accepts: the pattern of the application's z.email()
 * (lower case, the function lowercases first). An allow list: no comma, semicolon,
 * angle bracket, quote, parenthesis or backslash, so one value is one recipient.
 */
const EMAIL_PATTERN = "^(?:[a-z0-9_'+-]+[.])*[a-z0-9_'+-]*[a-z0-9_+-]@(?:[a-z0-9][a-z0-9-]*[.])+[a-z]{2,}$";

const SUBSCRIPTION_COLUMNS =
  'id text, email text, locale text, all_services integer, confirmed boolean, service_ids text[]';

interface Statements {
  /** Objects in the base schema: registry, RLS policies, helpers, osp_grant_public_role. */
  base: string[];
  /** The schema osp_public with its views and functions (needs CREATE on the database). */
  schema: string[];
}

/** Every statement of the migration, for base schema `b` (quoted). */
function statements(b: string, schemaName: string, invokerViews: boolean): Statements {
  const s = ident(SCHEMA);
  const pin = `SET search_path = ${b}, pg_temp`;
  const out: string[] = [];
  const schema: string[] = [];

  // Functions the migrating role creates from now on are not executable by PUBLIC: every
  // function a role needs is granted explicitly. (Default privileges for PUBLIC can only be
  // changed for the whole database, not per schema.)
  out.push(`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);

  // Registry of the public roles, read by the RLS policies.
  out.push(`CREATE TABLE ${b}.osp_public_roles (role_name text PRIMARY KEY)`);
  out.push(`REVOKE ALL ON ${b}.osp_public_roles FROM PUBLIC`);
  // Called inside the policies of every table, so executable by every role. Reveals only whether a
  // role name is registered. session_user too, so SET ROLE cannot leave the restrictions.
  out.push(`CREATE FUNCTION ${b}.osp_is_public_role(p_role name) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER ${pin} AS $$
      SELECT EXISTS (SELECT 1 FROM ${b}.osp_public_roles r WHERE r.role_name IN (p_role, session_user))
    $$`);
  out.push(`GRANT EXECUTE ON FUNCTION ${b}.osp_is_public_role(name) TO PUBLIC`);

  schema.push(`CREATE SCHEMA ${s}`);
  schema.push(`REVOKE ALL ON SCHEMA ${s} FROM PUBLIC`);

  const restricted = `(SELECT ${b}.osp_is_public_role(current_user)) IS NOT TRUE`;
  for (const t of PUBLIC_TABLES) {
    const columns = t.columns.map((c) => c.replaceAll('%b', b)).join(', ');
    const where = t.filter ? ` WHERE ${t.filter(b)}` : '';
    // security_barrier: conditions of the caller (e.g. a cast that fails with the value
    // in its error message) only see the rows that passed the view's filter.
    const options = invokerViews && !t.ownerRights ? 'security_invoker = true' : 'security_barrier = true';
    schema.push(`CREATE VIEW ${s}.${t.table} WITH (${options}) AS SELECT ${columns} FROM ${b}.${t.table}${where}`);
    if (t.rls === false) continue;
    out.push(`ALTER TABLE ${b}.${t.table} ENABLE ROW LEVEL SECURITY`);
    out.push(`CREATE POLICY osp_access ON ${b}.${t.table} USING (true) WITH CHECK (true)`);
    out.push(
      `CREATE POLICY osp_public_role ON ${b}.${t.table} AS RESTRICTIVE ` +
        `USING (${restricted} OR (${t.filter ? t.filter(b) : 'true'})) WITH CHECK (${restricted})`,
    );
  }
  // The registry too: its function reads it with the owner's rights, which bypass RLS.
  for (const table of [...PRIVATE_TABLES, 'osp_public_roles']) {
    out.push(`ALTER TABLE ${b}.${table} ENABLE ROW LEVEL SECURITY`);
    out.push(`CREATE POLICY osp_access ON ${b}.${table} USING (true) WITH CHECK (true)`);
    out.push(`CREATE POLICY osp_public_role ON ${b}.${table} AS RESTRICTIVE USING (${restricted}) WITH CHECK (${restricted})`);
  }

  // Helpers of the functions below (not callable by the public role).
  out.push(`CREATE FUNCTION ${b}.osp_iso(p_at timestamptz) RETURNS text LANGUAGE sql STABLE ${pin} AS $$
      SELECT to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    $$`);
  out.push(`CREATE FUNCTION ${b}.osp_token_matches(p_hash text, p_token text) RETURNS boolean
    LANGUAGE sql IMMUTABLE ${pin} AS $$
      SELECT coalesce(p_hash IS NOT NULL AND length(p_token) BETWEEN 1 AND 256
        AND p_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex'), false)
    $$`);
  out.push(`CREATE FUNCTION ${b}.osp_subscriptions_enabled() RETURNS boolean LANGUAGE sql STABLE ${pin} AS $$
      SELECT coalesce((SELECT (st.value::jsonb ->> 'emailSubscriptionsEnabled') = 'true'
        FROM ${b}.settings st WHERE st.key = 'page'), false)
    $$`);
  out.push(`CREATE FUNCTION ${b}.osp_subscription_row(p_id text) RETURNS TABLE (${SUBSCRIPTION_COLUMNS})
    LANGUAGE sql STABLE ${pin} AS $$
      SELECT s.id, s.email, s.locale, s.all_services, s.confirmed_at IS NOT NULL,
        CASE WHEN s.all_services = 1 THEN ARRAY[]::text[] ELSE ARRAY(
          SELECT v.id FROM ${b}.subscriber_services ss JOIN ${b}.services v ON v.id = ss.service_id
          WHERE ss.subscriber_id = s.id AND v.is_public = 1 ORDER BY v.sort_order, v.name) END
      FROM ${b}.subscribers s WHERE s.id = p_id
    $$`);
  // Validates locale and services like SubscribeInput / assertPublicServices; returns the distinct ids.
  out.push(`CREATE FUNCTION ${b}.osp_check_subscription_input(p_locale text, p_all_services boolean, p_service_ids text[])
    RETURNS text[] LANGUAGE plpgsql STABLE ${pin} AS $$
    DECLARE
      v_ids text[];
    BEGIN
      IF p_locale IS NULL OR p_locale NOT IN ('en', 'de') THEN
        RAISE EXCEPTION 'Invalid locale' USING ERRCODE = '22023';
      END IF;
      IF p_all_services IS NULL THEN
        RAISE EXCEPTION 'Invalid allServices' USING ERRCODE = '22023';
      END IF;
      IF p_all_services THEN
        RETURN ARRAY[]::text[];
      END IF;
      SELECT coalesce(array_agg(DISTINCT x), ARRAY[]::text[]) INTO v_ids FROM unnest(coalesce(p_service_ids, ARRAY[]::text[])) AS x;
      IF cardinality(v_ids) = 0 THEN
        RAISE EXCEPTION 'Select at least one service' USING ERRCODE = '22023';
      END IF;
      IF cardinality(v_ids) > 500 THEN
        RAISE EXCEPTION 'Too many services' USING ERRCODE = '22023';
      END IF;
      -- Same answer for unknown and hidden services.
      IF (SELECT count(*) FROM ${b}.services v WHERE v.id = ANY (v_ids) AND v.is_public = 1) <> cardinality(v_ids) THEN
        RAISE EXCEPTION 'Unknown service' USING ERRCODE = '22023';
      END IF;
      RETURN v_ids;
    END
    $$`);
  // Account mails are queued without content: the worker renders them (NotificationService).
  out.push(`CREATE FUNCTION ${b}.osp_queue_account_mail(p_subscriber_id text, p_recipient text, p_kind text, p_now text)
    RETURNS void LANGUAGE sql VOLATILE ${pin} AS $$
      UPDATE ${b}.subscribers SET confirmation_sent_at = p_now WHERE id = p_subscriber_id;
      INSERT INTO ${b}.email_outbox (id, subscriber_id, recipient, kind, subject, text_body, html_body, headers,
        status, attempts, next_attempt_at, last_error, last_attempt_at, created_at, sent_at)
      VALUES (md5(random()::text || clock_timestamp()::text || p_subscriber_id), p_subscriber_id, p_recipient, p_kind, '', '', '',
        '{"Auto-Submitted":"auto-generated"}', 'pending', 0, p_now, NULL, NULL, p_now, NULL);
    $$`);

  // The functions of the public role. Same behaviour as services/subscriptions.ts.
  schema.push(`CREATE FUNCTION ${s}.subscribe(p_id text, p_email text, p_locale text, p_all_services boolean,
      p_service_ids text[], p_token_salt text, p_confirm_token_hash text, p_manage_token_hash text, p_token_key text)
    RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER ${pin} AS $$
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
      IF v_email IS NULL OR length(v_email) > 254 OR v_email !~ ${literal(EMAIL_PATTERN)} THEN
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
      -- Existing address: preferences never change without the manage token. Mails are throttled.
      IF v_sub.confirmation_sent_at IS NULL
        OR v_sub.confirmation_sent_at < ${b}.osp_iso(clock_timestamp() - interval ${literal(CONFIRMATION_THROTTLE)}) THEN
        PERFORM ${b}.osp_queue_account_mail(v_sub.id, v_sub.email,
          CASE WHEN v_sub.confirmed_at IS NULL THEN 'confirm' ELSE 'manage' END, v_now);
      END IF;
    END
    $$`);
  schema.push(`CREATE FUNCTION ${s}.subscription_confirm(p_id text, p_token text)
    RETURNS TABLE (${SUBSCRIPTION_COLUMNS}, token_salt text)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER ${pin} AS $$
    DECLARE
      v_sub ${b}.subscribers;
      v_now text := ${b}.osp_iso(clock_timestamp());
    BEGIN
      SELECT * INTO v_sub FROM ${b}.subscribers s WHERE s.id = p_id FOR UPDATE;
      IF NOT FOUND OR NOT ${b}.osp_token_matches(v_sub.confirm_token_hash, p_token) THEN
        RETURN;
      END IF;
      IF v_sub.confirmed_at IS NULL THEN
        UPDATE ${b}.subscribers s SET confirmed_at = v_now, updated_at = v_now WHERE s.id = v_sub.id;
      END IF;
      -- The salt lets the caller (it knows the token key) derive the manage token for its answer.
      RETURN QUERY SELECT r.id, r.email, r.locale, r.all_services, r.confirmed, r.service_ids, v_sub.token_salt
        FROM ${b}.osp_subscription_row(v_sub.id) r;
    END
    $$`);
  schema.push(`CREATE FUNCTION ${s}.subscription_get(p_id text, p_token text) RETURNS TABLE (${SUBSCRIPTION_COLUMNS})
    LANGUAGE sql STABLE SECURITY DEFINER ${pin} AS $$
      SELECT r.* FROM ${b}.subscribers s CROSS JOIN LATERAL ${b}.osp_subscription_row(s.id) r
      WHERE s.id = p_id AND ${b}.osp_token_matches(s.manage_token_hash, p_token)
    $$`);
  schema.push(`CREATE FUNCTION ${s}.subscription_update(p_id text, p_token text, p_locale text, p_all_services boolean,
      p_service_ids text[]) RETURNS TABLE (${SUBSCRIPTION_COLUMNS})
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER ${pin} AS $$
    DECLARE
      v_sub ${b}.subscribers;
      v_ids text[];
    BEGIN
      SELECT * INTO v_sub FROM ${b}.subscribers s WHERE s.id = p_id FOR UPDATE;
      IF NOT FOUND OR NOT ${b}.osp_token_matches(v_sub.manage_token_hash, p_token) THEN
        RETURN;
      END IF;
      v_ids := ${b}.osp_check_subscription_input(p_locale, p_all_services, p_service_ids);
      UPDATE ${b}.subscribers s
        SET locale = p_locale, all_services = CASE WHEN p_all_services THEN 1 ELSE 0 END,
          updated_at = ${b}.osp_iso(clock_timestamp())
        WHERE s.id = v_sub.id;
      DELETE FROM ${b}.subscriber_services ss WHERE ss.subscriber_id = v_sub.id;
      INSERT INTO ${b}.subscriber_services (subscriber_id, service_id) SELECT v_sub.id, unnest(v_ids);
      RETURN QUERY SELECT * FROM ${b}.osp_subscription_row(v_sub.id);
    END
    $$`);
  schema.push(`CREATE FUNCTION ${s}.subscription_delete(p_id text, p_token text) RETURNS boolean
    LANGUAGE sql VOLATILE SECURITY DEFINER ${pin} AS $$
      WITH deleted AS (
        DELETE FROM ${b}.subscribers s WHERE s.id = p_id AND ${b}.osp_token_matches(s.manage_token_hash, p_token)
        RETURNING 1
      )
      SELECT EXISTS (SELECT 1 FROM deleted)
    $$`);
  // Lets a public instance check on start that its login really is restricted.
  schema.push(`CREATE FUNCTION ${s}.connection_restricted() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER ${pin} AS $$
      SELECT ${b}.osp_is_public_role(session_user)
    $$`);

  schema.push(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${s} FROM PUBLIC`);
  for (const helper of [
    'osp_iso(timestamptz)',
    'osp_token_matches(text, text)',
    'osp_subscriptions_enabled()',
    'osp_subscription_row(text)',
    'osp_check_subscription_input(text, boolean, text[])',
    'osp_queue_account_mail(text, text, text, text)',
  ]) {
    out.push(`REVOKE ALL ON FUNCTION ${b}.${helper} FROM PUBLIC`);
  }

  // Grants for one role. Run by the owner (migrating instances call it on every start).
  const columnGrants = PUBLIC_TABLES.map(
    (t) =>
      `EXECUTE format('GRANT SELECT (${t.grant.map(ident).join(', ')}) ON %I.%I TO %I', ${literal(schemaName)}, ${literal(t.table)}, p_role);`,
  ).join('\n      ');
  out.push(`CREATE FUNCTION ${b}.osp_grant_public_role(p_role text) RETURNS boolean
    LANGUAGE plpgsql VOLATILE ${pin} AS $$
    DECLARE
      v_role pg_roles;
    BEGIN
      SELECT * INTO v_role FROM pg_roles WHERE rolname = p_role;
      IF NOT FOUND THEN
        RETURN false;
      END IF;
      -- No membership in any role: predefined roles such as pg_read_all_data would bypass the
      -- column privileges (RLS still applies), the owner's role would bypass everything.
      IF p_role = current_user OR p_role = session_user OR v_role.rolsuper OR v_role.rolbypassrls
        OR pg_has_role(p_role, current_user, 'MEMBER')
        OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = v_role.oid) THEN
        RAISE EXCEPTION 'The public database role "%" must be a separate login without SUPERUSER, BYPASSRLS or membership in any role',
          p_role USING ERRCODE = '42501';
      END IF;
      -- Concurrent starts of several instances.
      PERFORM pg_advisory_xact_lock(hashtext('osp_grant_public_role'));
      INSERT INTO ${b}.osp_public_roles (role_name) VALUES (p_role) ON CONFLICT DO NOTHING;
      -- Start from nothing (also removes column privileges), then grant exactly what the views need.
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', ${literal(schemaName)}, p_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', ${literal(schemaName)}, p_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM %I', ${literal(schemaName)}, p_role);
      EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', ${literal(schemaName)}, p_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', ${literal(SCHEMA)}, p_role);
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', ${literal(SCHEMA)}, p_role);
      EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', ${literal(SCHEMA)}, p_role);
      EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I', ${literal(SCHEMA)}, p_role);
      ${columnGrants}
      RETURN true;
    END
    $$`);
  out.push(`REVOKE ALL ON FUNCTION ${b}.osp_grant_public_role(text) FROM PUBLIC`);
  return { base: out, schema };
}

async function isPostgres(db: Kysely<any>): Promise<boolean> {
  return db.getExecutor().adapter instanceof PostgresAdapter;
}

async function baseSchema(db: Kysely<any>): Promise<string> {
  const { rows } = await sql<{ schema: string }>`select current_schema() as schema`.execute(db);
  return rows[0]!.schema;
}

interface Server {
  schemaName: string;
  version: number;
  /** The migrating role may create schemas in the database (needed for osp_public). */
  canCreateSchema: boolean;
}

async function server(db: Kysely<any>): Promise<Server> {
  const { rows } = await sql<{ schema: string; version: number; can_create: boolean }>`
    select current_schema() as schema, current_setting('server_version_num')::int as version,
      has_database_privilege(current_user, current_database(), 'CREATE') as can_create`.execute(db);
  const row = rows[0]!;
  return { schemaName: row.schema, version: row.version, canCreateSchema: row.can_create };
}

function statementsFor(info: Server): Statements {
  // security_invoker needs PostgreSQL 15. Older servers get views with the owner's rights: the
  // views still filter rows and columns, but the RLS policies do not apply through them.
  return statements(ident(info.schemaName), info.schemaName, info.version >= 150000);
}

/**
 * Creates the schema osp_public (views and functions of the public role) when it
 * does not exist yet. The migration skips it when the migrating role may not
 * create schemas (CREATE on the database), which only APP_ROLE=public needs:
 * migrating instances call this on every start (ensurePublicSchema), so it is
 * created once the privilege is granted. Returns whether it was created.
 *
 * A later migration that changes osp_public must skip that change when the schema
 * does not exist and add it to ensurePublicSchema after this one.
 */
export async function createPublicSchema(db: Kysely<any>): Promise<boolean> {
  const info = await server(db);
  if (!info.canCreateSchema) return false;
  for (const statement of statementsFor(info).schema) {
    await sql.raw(statement).execute(db);
  }
  return true;
}

export async function up(db: Kysely<any>): Promise<void> {
  if (!(await isPostgres(db))) return;
  const info = await server(db);
  if (info.version < 110000) {
    throw new Error(`PostgreSQL 11 or newer is required (this server is ${info.version}); 15 or newer is recommended`);
  }
  const { base, schema } = statementsFor(info);
  for (const statement of info.canCreateSchema ? [...base, ...schema] : base) {
    await sql.raw(statement).execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  if (!(await isPostgres(db))) return;
  const b = ident(await baseSchema(db));
  await sql.raw(`DROP SCHEMA IF EXISTS ${ident(SCHEMA)} CASCADE`).execute(db);
  for (const table of [...PUBLIC_TABLES.filter((t) => t.rls !== false).map((t) => t.table), ...PRIVATE_TABLES]) {
    await sql.raw(`DROP POLICY IF EXISTS osp_public_role ON ${b}.${table}`).execute(db);
    await sql.raw(`DROP POLICY IF EXISTS osp_access ON ${b}.${table}`).execute(db);
    await sql.raw(`ALTER TABLE ${b}.${table} DISABLE ROW LEVEL SECURITY`).execute(db);
  }
  for (const fn of [
    'osp_grant_public_role(text)',
    'osp_queue_account_mail(text, text, text, text)',
    'osp_check_subscription_input(text, boolean, text[])',
    'osp_subscription_row(text)',
    'osp_subscriptions_enabled()',
    'osp_token_matches(text, text)',
    'osp_iso(timestamptz)',
    'osp_is_public_role(name)',
  ]) {
    await sql.raw(`DROP FUNCTION IF EXISTS ${b}.${fn}`).execute(db);
  }
  await sql.raw(`DROP TABLE IF EXISTS ${b}.osp_public_roles`).execute(db);
  await sql.raw(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC`).execute(db);
}
