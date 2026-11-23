import { PostgresAdapter, sql, type Kysely } from 'kysely';

/**
 * Webhook and SMS notifications (services/channels/*).
 *
 * - notification_webhooks (+ _services): admin webhooks (Discord, Slack, Teams,
 *   generic JSON). The URL, the signing secret and the header values are stored
 *   encrypted (SecretBox of SECRET_KEY); `host` and `header_names` are shown in
 *   the admin UI. Repeated failures disable a webhook (disabled_reason).
 * - sms_recipients (+ _services): on-call numbers of the admins.
 * - channel_subscribers (+ _services): visitors subscribed with a webhook or a
 *   phone number. The target is stored encrypted (a key derived from
 *   SUBSCRIPTION_TOKEN_KEY, the one key every instance has), `target_hash` (HMAC)
 *   finds it again, `target_hint` is the masked form. The subscription is active
 *   once the visitor entered the 6-digit code of the confirmation message
 *   (`code_hash`, at most 5 attempts per code, 5 codes per sign-up). The manage
 *   token is never stored, only its hash (like the email subscriptions of 0006).
 * - channel_outbox: every webhook and SMS delivery (worker with retries). Rows
 *   hold the event data (public text only), never a URL, number or token; the
 *   worker renders each message right before sending it. It is also the
 *   delivery log of the admin webhooks and the count of the monthly SMS budget.
 * - The settings rows `channels` (what visitors may subscribe with, limits) and
 *   `sms_provider` (request template, credentials encrypted) live in `settings`.
 *
 * On PostgreSQL every new table gets the row level security of the private
 * tables (0007_public_role): the restricted public role holds no privilege on
 * them. It reads the channel options and writes subscriptions only through
 * SECURITY DEFINER functions in osp_public (search_path pinned like 0012), which
 * check every input themselves, enforce the admin's options (enabled kinds,
 * allowed countries, the confirmation cap per hour and the monthly SMS budget)
 * and queue the confirmation message without content. When osp_public does not
 * exist yet, the functions are created by ensurePublicSchema (db/public-role.ts).
 *
 * Portable column types only (see 0001_initial).
 */

const PIN = 'SET search_path = pg_catalog, pg_temp';
const PUBLIC_SCHEMA = 'osp_public';

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Wrong codes per sent code, codes per sign-up. Same values as services/channels/subscriptions.ts. */
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_CODE_SENDS = 5;

const TABLES = [
  'notification_webhooks',
  'notification_webhook_services',
  'sms_recipients',
  'sms_recipient_services',
  'channel_subscribers',
  'channel_subscriber_services',
  'channel_outbox',
];

const ROW_COLUMNS =
  'id text, channel text, webhook_kind text, target_hint text, locale text, all_services integer, confirmed boolean, service_ids text[]';

/** Helpers in the table schema (not callable by the public role). */
function baseStatements(b: string): string[] {
  const out: string[] = [];
  const restricted = `(SELECT ${b}.osp_is_public_role(current_user)) IS NOT TRUE`;
  for (const table of TABLES) {
    out.push(`ALTER TABLE ${b}.${table} ENABLE ROW LEVEL SECURITY`);
    out.push(`CREATE POLICY osp_access ON ${b}.${table} USING (true) WITH CHECK (true)`);
    out.push(`CREATE POLICY osp_public_role ON ${b}.${table} AS RESTRICTIVE USING (${restricted}) WITH CHECK (${restricted})`);
  }
  out.push(`CREATE FUNCTION ${b}.osp_channel_settings() RETURNS jsonb LANGUAGE sql STABLE ${PIN} AS $$
      SELECT coalesce((SELECT st.value::jsonb FROM ${b}.settings st WHERE st.key = 'channels'), '{}'::jsonb)
    $$`);
  // ISO timestamp of the start of the current month (UTC), comparable with the text timestamps.
  out.push(`CREATE FUNCTION ${b}.osp_sms_used_this_month() RETURNS bigint LANGUAGE sql STABLE ${PIN} AS $$
      SELECT count(*) FROM ${b}.channel_outbox o
      WHERE o.channel = 'sms' AND o.status IN ('sent', 'pending')
        AND o.created_at >= ${b}.osp_iso(date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
    $$`);
  out.push(`CREATE FUNCTION ${b}.osp_channel_options() RETURNS TABLE (webhook_kinds text[], sms boolean, sms_calling_codes text[])
    LANGUAGE sql STABLE ${PIN} AS $$
      WITH s AS (SELECT ${b}.osp_channel_settings() AS j),
        p AS (SELECT coalesce((SELECT (st.value::jsonb ->> 'enabled') = 'true' FROM ${b}.settings st WHERE st.key = 'sms_provider'), false) AS enabled),
        c AS (SELECT ARRAY(SELECT x FROM s, jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(s.j -> 'smsCallingCodes') = 'array' THEN s.j -> 'smsCallingCodes' ELSE '[]'::jsonb END) AS x
          WHERE x ~ '^[1-9][0-9]{0,3}$') AS codes)
      SELECT
        CASE WHEN (s.j ->> 'webhookSubscriptions') = 'true' THEN
          CASE WHEN (s.j ->> 'genericWebhookSubscriptions') = 'true' THEN ARRAY['discord', 'slack', 'teams', 'generic']
          ELSE ARRAY['discord', 'slack', 'teams'] END
        ELSE ARRAY[]::text[] END,
        p.enabled AND cardinality(c.codes) > 0
          AND ${b}.osp_sms_used_this_month() < coalesce(CASE WHEN (s.j ->> 'smsMonthlyBudget') ~ '^[0-9]{1,9}$'
            THEN (s.j ->> 'smsMonthlyBudget')::bigint END, 200),
        c.codes
      FROM s, p, c
    $$`);
  // SMS confirmation and manage messages: within the cap per hour and the monthly budget.
  out.push(`CREATE FUNCTION ${b}.osp_channel_message_allowed(p_channel text) RETURNS boolean LANGUAGE sql STABLE ${PIN} AS $$
      SELECT p_channel <> 'sms' OR (
        (SELECT count(*) FROM ${b}.channel_outbox o WHERE o.channel = 'sms' AND o.recipient_type = 'subscriber'
          AND o.event IN ('subscription.confirm', 'subscription.manage')
          AND o.created_at >= ${b}.osp_iso(clock_timestamp() - interval '1 hour'))
        < coalesce(CASE WHEN (${b}.osp_channel_settings() ->> 'smsConfirmationsPerHour') ~ '^[0-9]{1,9}$'
            THEN (${b}.osp_channel_settings() ->> 'smsConfirmationsPerHour')::bigint END, 20)
        AND (SELECT o.sms FROM ${b}.osp_channel_options() o))
    $$`);
  // Messages queued by the public role carry no content: the worker renders them.
  out.push(`CREATE FUNCTION ${b}.osp_queue_channel_message(p_channel text, p_subscriber_id text, p_event text, p_now text)
    RETURNS void LANGUAGE sql VOLATILE ${PIN} AS $$
      INSERT INTO ${b}.channel_outbox (id, channel, recipient_type, recipient_id, event, payload, status, attempts,
        next_attempt_at, status_code, last_error, last_attempt_at, created_at, sent_at)
      VALUES (md5(random()::text || clock_timestamp()::text || p_subscriber_id), p_channel, 'subscriber', p_subscriber_id,
        p_event, '', 'pending', 0, p_now, NULL, NULL, NULL, p_now, NULL);
    $$`);
  out.push(`CREATE FUNCTION ${b}.osp_channel_row(p_id text) RETURNS TABLE (${ROW_COLUMNS}) LANGUAGE sql STABLE ${PIN} AS $$
      SELECT s.id, s.channel, s.webhook_kind, s.target_hint, s.locale, s.all_services, s.confirmed_at IS NOT NULL,
        CASE WHEN s.all_services = 1 THEN ARRAY[]::text[] ELSE ARRAY(
          SELECT v.id FROM ${b}.channel_subscriber_services ss JOIN ${b}.services v ON v.id = ss.service_id
          WHERE ss.subscriber_id = s.id AND v.is_public = 1 ORDER BY v.sort_order, v.name) END
      FROM ${b}.channel_subscribers s WHERE s.id = p_id
    $$`);
  for (const helper of [
    'osp_channel_settings()',
    'osp_sms_used_this_month()',
    'osp_channel_options()',
    'osp_channel_message_allowed(text)',
    'osp_queue_channel_message(text, text, text, text)',
    'osp_channel_row(text)',
  ]) {
    out.push(`REVOKE ALL ON FUNCTION ${b}.${helper} FROM PUBLIC`);
  }
  return out;
}

/** Signatures of the osp_public functions (for REVOKE, GRANT and DROP). */
const FUNCTIONS = [
  'channel_options()',
  'channel_subscribe(text, text, text, text, text, text, text, text, boolean, text[], text, text, text, text)',
  'channel_confirm(text, text)',
  'channel_subscription_get(text, text)',
  'channel_subscription_update(text, text, text, boolean, text[])',
  'channel_subscription_delete(text, text)',
];

/** The functions of the public role in osp_public. Same behaviour as services/channels/subscriptions.ts. */
function publicStatements(b: string): string[] {
  const s = ident(PUBLIC_SCHEMA);
  const definer = `SECURITY DEFINER ${PIN}`;
  const out: string[] = [];
  out.push(`CREATE FUNCTION ${s}.channel_options() RETURNS TABLE (webhook_kinds text[], sms boolean, sms_calling_codes text[])
    LANGUAGE sql STABLE ${definer} AS $$
      SELECT o.webhook_kinds, o.sms, o.sms_calling_codes FROM ${b}.osp_channel_options() o
    $$`);
  out.push(`CREATE FUNCTION ${s}.channel_subscribe(p_id text, p_channel text, p_webhook_kind text, p_phone text,
      p_target_enc text, p_target_hash text, p_target_hint text, p_locale text, p_all_services boolean, p_service_ids text[],
      p_token_salt text, p_code_hash text, p_manage_token_hash text, p_token_key text)
    RETURNS void LANGUAGE plpgsql VOLATILE ${definer} AS $$
    DECLARE
      v_opts record;
      v_now text := ${b}.osp_iso(clock_timestamp());
      v_ids text[];
      v_sub ${b}.channel_subscribers;
      v_sends integer := 0;
      v_created text := v_now;
    BEGIN
      SELECT * INTO v_opts FROM ${b}.osp_channel_options();
      IF p_channel = 'webhook' THEN
        IF p_webhook_kind IS NULL OR NOT (p_webhook_kind = ANY (v_opts.webhook_kinds)) THEN
          RAISE EXCEPTION 'Channel not available' USING ERRCODE = '55000';
        END IF;
        IF p_phone IS NOT NULL THEN
          RAISE EXCEPTION 'Invalid phone' USING ERRCODE = '22023';
        END IF;
      ELSIF p_channel = 'sms' THEN
        IF NOT v_opts.sms THEN
          RAISE EXCEPTION 'Channel not available' USING ERRCODE = '55000';
        END IF;
        IF p_webhook_kind IS NOT NULL OR p_phone IS NULL OR p_phone !~ '^[+][1-9][0-9]{6,14}$' THEN
          RAISE EXCEPTION 'Invalid phone' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM unnest(v_opts.sms_calling_codes) c WHERE starts_with(p_phone, '+' || c)) THEN
          RAISE EXCEPTION 'Country not allowed' USING ERRCODE = '22023';
        END IF;
      ELSE
        RAISE EXCEPTION 'Invalid channel' USING ERRCODE = '22023';
      END IF;
      IF p_id IS NULL OR p_id !~ '^[A-Za-z0-9_-]{8,64}$' THEN
        RAISE EXCEPTION 'Invalid id' USING ERRCODE = '22023';
      END IF;
      IF p_target_enc IS NULL OR length(p_target_enc) > 8000 OR p_target_enc !~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]*$'
        OR p_target_hash IS NULL OR p_target_hash !~ '^[A-Za-z0-9_-]{43}$'
        OR p_target_hint IS NULL OR length(p_target_hint) NOT BETWEEN 1 AND 100 OR p_target_hint ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'Invalid target' USING ERRCODE = '22023';
      END IF;
      v_ids := ${b}.osp_check_subscription_input(p_locale, p_all_services, p_service_ids);
      IF p_token_salt IS NULL OR p_token_salt !~ '^[A-Za-z0-9_-]{16,64}$' THEN
        RAISE EXCEPTION 'Invalid token salt' USING ERRCODE = '22023';
      END IF;
      IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
        OR p_manage_token_hash IS NULL OR p_manage_token_hash !~ '^[0-9a-f]{64}$' OR p_code_hash = p_manage_token_hash THEN
        RAISE EXCEPTION 'Invalid token hash' USING ERRCODE = '22023';
      END IF;
      IF p_token_key IS NULL OR p_token_key !~ '^[A-Za-z0-9_-]{1,64}$' THEN
        RAISE EXCEPTION 'Invalid token key' USING ERRCODE = '22023';
      END IF;

      SELECT * INTO v_sub FROM ${b}.channel_subscribers c WHERE c.target_hash = p_target_hash FOR UPDATE;
      IF FOUND THEN
        -- One message per target and throttle period (an SMS costs money: longer).
        IF v_sub.code_sent_at IS NOT NULL AND v_sub.code_sent_at >= ${b}.osp_iso(clock_timestamp()
          - CASE WHEN v_sub.channel = 'sms' THEN interval '60 minutes' ELSE interval '10 minutes' END) THEN
          RETURN;
        END IF;
        IF v_sub.confirmed_at IS NOT NULL THEN
          -- Confirmed: preferences never change without the manage token; send the manage link.
          IF NOT ${b}.osp_channel_message_allowed(v_sub.channel) THEN
            RETURN;
          END IF;
          UPDATE ${b}.channel_subscribers c SET code_sent_at = v_now WHERE c.id = v_sub.id;
          PERFORM ${b}.osp_queue_channel_message(v_sub.channel, v_sub.id, 'subscription.manage', v_now);
          RETURN;
        END IF;
        IF v_sub.code_sends >= ${MAX_CODE_SENDS} THEN
          RETURN;
        END IF;
        -- Pending: a new code (and new attempts) under a new id; the sign-up time stays.
        v_sends := v_sub.code_sends;
        v_created := v_sub.created_at;
        DELETE FROM ${b}.channel_outbox o WHERE o.recipient_type = 'subscriber' AND o.recipient_id = v_sub.id AND o.status = 'pending';
        DELETE FROM ${b}.channel_subscribers c WHERE c.id = v_sub.id;
      END IF;
      IF NOT ${b}.osp_channel_message_allowed(p_channel) THEN
        RETURN;
      END IF;
      INSERT INTO ${b}.channel_subscribers (id, channel, webhook_kind, target_enc, target_hash, target_hint, locale,
        all_services, token_salt, code_hash, code_attempts, code_sends, code_sent_at, confirmed_at, manage_token_hash,
        token_key, created_at, updated_at)
      VALUES (p_id, p_channel, p_webhook_kind, p_target_enc, p_target_hash, p_target_hint, p_locale,
        CASE WHEN p_all_services THEN 1 ELSE 0 END, p_token_salt, p_code_hash, 0, v_sends + 1, v_now, NULL,
        p_manage_token_hash, p_token_key, v_created, v_now)
      ON CONFLICT DO NOTHING
      RETURNING * INTO v_sub;
      -- A concurrent request for the same target: that one queues the message.
      IF NOT FOUND THEN
        RETURN;
      END IF;
      INSERT INTO ${b}.channel_subscriber_services (subscriber_id, service_id) SELECT v_sub.id, unnest(v_ids);
      PERFORM ${b}.osp_queue_channel_message(p_channel, v_sub.id, 'subscription.confirm', v_now);
    END
    $$`);
  // The code is valid for 24 hours, MAX_CODE_ATTEMPTS wrong entries end it.
  out.push(`CREATE FUNCTION ${s}.channel_confirm(p_reference text, p_code text) RETURNS TABLE (${ROW_COLUMNS}, token_salt text)
    LANGUAGE plpgsql VOLATILE ${definer} AS $$
    DECLARE
      v_sub ${b}.channel_subscribers;
      v_now text := ${b}.osp_iso(clock_timestamp());
    BEGIN
      IF p_reference IS NULL OR p_reference !~ '^[A-Za-z0-9_-]{43}$' THEN
        RETURN;
      END IF;
      SELECT * INTO v_sub FROM ${b}.channel_subscribers c WHERE c.target_hash = p_reference FOR UPDATE;
      IF NOT FOUND OR v_sub.confirmed_at IS NOT NULL OR v_sub.code_attempts >= ${MAX_CODE_ATTEMPTS}
        OR v_sub.code_sent_at IS NULL OR v_sub.code_sent_at < ${b}.osp_iso(clock_timestamp() - interval '24 hours') THEN
        RETURN;
      END IF;
      IF p_code IS NULL OR p_code !~ '^[0-9]{6}$'
        OR encode(sha256(convert_to(v_sub.token_salt || ':' || p_code, 'UTF8')), 'hex') <> v_sub.code_hash THEN
        UPDATE ${b}.channel_subscribers c SET code_attempts = c.code_attempts + 1 WHERE c.id = v_sub.id;
        RETURN;
      END IF;
      UPDATE ${b}.channel_subscribers c SET confirmed_at = v_now, updated_at = v_now WHERE c.id = v_sub.id;
      -- The salt lets the caller (it knows the token key) derive the manage token for its answer.
      RETURN QUERY SELECT r.*, v_sub.token_salt FROM ${b}.osp_channel_row(v_sub.id) r;
    END
    $$`);
  out.push(`CREATE FUNCTION ${s}.channel_subscription_get(p_id text, p_token text) RETURNS TABLE (${ROW_COLUMNS}, token_salt text)
    LANGUAGE sql STABLE ${definer} AS $$
      SELECT r.*, c.token_salt FROM ${b}.channel_subscribers c CROSS JOIN LATERAL ${b}.osp_channel_row(c.id) r
      WHERE c.id = p_id AND ${b}.osp_token_matches(c.manage_token_hash, p_token)
    $$`);
  out.push(`CREATE FUNCTION ${s}.channel_subscription_update(p_id text, p_token text, p_locale text, p_all_services boolean,
      p_service_ids text[]) RETURNS TABLE (${ROW_COLUMNS}, token_salt text)
    LANGUAGE plpgsql VOLATILE ${definer} AS $$
    DECLARE
      v_sub ${b}.channel_subscribers;
      v_ids text[];
    BEGIN
      SELECT * INTO v_sub FROM ${b}.channel_subscribers c WHERE c.id = p_id FOR UPDATE;
      IF NOT FOUND OR NOT ${b}.osp_token_matches(v_sub.manage_token_hash, p_token) THEN
        RETURN;
      END IF;
      v_ids := ${b}.osp_check_subscription_input(p_locale, p_all_services, p_service_ids);
      UPDATE ${b}.channel_subscribers c
        SET locale = p_locale, all_services = CASE WHEN p_all_services THEN 1 ELSE 0 END,
          updated_at = ${b}.osp_iso(clock_timestamp())
        WHERE c.id = v_sub.id;
      DELETE FROM ${b}.channel_subscriber_services ss WHERE ss.subscriber_id = v_sub.id;
      INSERT INTO ${b}.channel_subscriber_services (subscriber_id, service_id) SELECT v_sub.id, unnest(v_ids);
      RETURN QUERY SELECT r.*, v_sub.token_salt FROM ${b}.osp_channel_row(v_sub.id) r;
    END
    $$`);
  out.push(`CREATE FUNCTION ${s}.channel_subscription_delete(p_id text, p_token text) RETURNS boolean
    LANGUAGE plpgsql VOLATILE ${definer} AS $$
    DECLARE
      v_id text;
    BEGIN
      DELETE FROM ${b}.channel_subscribers c WHERE c.id = p_id AND ${b}.osp_token_matches(c.manage_token_hash, p_token)
        RETURNING c.id INTO v_id;
      IF v_id IS NULL THEN
        RETURN false;
      END IF;
      DELETE FROM ${b}.channel_outbox o WHERE o.recipient_type = 'subscriber' AND o.recipient_id = v_id AND o.status = 'pending';
      RETURN true;
    END
    $$`);
  for (const fn of FUNCTIONS) out.push(`REVOKE ALL ON FUNCTION ${s}.${fn} FROM PUBLIC`);
  // Registered public roles get them at once (instances that migrate grant them on every start anyway).
  out.push(`DO $$ DECLARE r text; BEGIN
      FOR r IN SELECT role_name FROM ${b}.osp_public_roles LOOP
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
          ${FUNCTIONS.map((fn) => `EXECUTE format('GRANT EXECUTE ON FUNCTION ${s}.${fn} TO %I', r);`).join('\n          ')}
        END IF;
      END LOOP;
    END $$`);
  return out;
}

async function isPostgres(db: Kysely<any>): Promise<boolean> {
  return db.getExecutor().adapter instanceof PostgresAdapter;
}

async function baseSchema(db: Kysely<any>): Promise<string> {
  const { rows } = await sql<{ schema: string }>`select current_schema() as schema`.execute(db);
  return ident(rows[0]!.schema);
}

async function publicSchemaExists(db: Kysely<any>): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`select to_regnamespace(${PUBLIC_SCHEMA}) is not null as found`.execute(db);
  return rows[0]?.found === true;
}

/**
 * Creates the channel functions in osp_public (PostgreSQL). Called by the migration
 * when the schema exists and by ensurePublicSchema right after it created the schema.
 */
export async function createChannelFunctions(db: Kysely<any>): Promise<void> {
  for (const statement of publicStatements(await baseSchema(db))) {
    await sql.raw(statement).execute(db);
  }
}

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('notification_webhooks')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    // SecretBox (SECRET_KEY): the URL holds the secret of Discord, Slack and Teams webhooks.
    .addColumn('url_enc', 'text', (c) => c.notNull())
    .addColumn('host', 'text', (c) => c.notNull())
    // Generic webhooks: the HMAC signing secret (SecretBox).
    .addColumn('secret_enc', 'text')
    // JSON [{ name, value }] of extra headers (SecretBox); their names in clear for the UI.
    .addColumn('headers_enc', 'text')
    .addColumn('header_names', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('allow_http', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('all_services', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('consecutive_failures', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('disabled_reason', 'text')
    .addColumn('disabled_at', 'text')
    .addColumn('last_delivery_at', 'text')
    .addColumn('last_status_code', 'integer')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema
    .createTable('notification_webhook_services')
    .addColumn('webhook_id', 'text', (c) => c.notNull().references('notification_webhooks.id').onDelete('cascade'))
    .addColumn('service_id', 'text', (c) => c.notNull().references('services.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('notification_webhook_services_pk', ['webhook_id', 'service_id'])
    .execute();
  await db.schema
    .createIndex('notification_webhook_services_service_idx')
    .on('notification_webhook_services')
    .column('service_id')
    .execute();

  await db.schema
    .createTable('sms_recipients')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    // E.164.
    .addColumn('phone', 'text', (c) => c.notNull())
    .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('all_services', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema
    .createTable('sms_recipient_services')
    .addColumn('recipient_id', 'text', (c) => c.notNull().references('sms_recipients.id').onDelete('cascade'))
    .addColumn('service_id', 'text', (c) => c.notNull().references('services.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('sms_recipient_services_pk', ['recipient_id', 'service_id'])
    .execute();
  await db.schema.createIndex('sms_recipient_services_service_idx').on('sms_recipient_services').column('service_id').execute();

  await db.schema
    .createTable('channel_subscribers')
    .addColumn('id', 'text', (c) => c.primaryKey())
    // webhook | sms
    .addColumn('channel', 'text', (c) => c.notNull())
    .addColumn('webhook_kind', 'text')
    .addColumn('target_enc', 'text', (c) => c.notNull())
    .addColumn('target_hash', 'text', (c) => c.notNull().unique())
    .addColumn('target_hint', 'text', (c) => c.notNull())
    .addColumn('locale', 'text', (c) => c.notNull().defaultTo('en'))
    .addColumn('all_services', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('token_salt', 'text', (c) => c.notNull())
    // SHA-256 (hex) of "<token_salt>:<code>".
    .addColumn('code_hash', 'text', (c) => c.notNull())
    .addColumn('code_attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('code_sends', 'integer', (c) => c.notNull().defaultTo(0))
    // Last confirmation or manage message (throttle).
    .addColumn('code_sent_at', 'text')
    .addColumn('confirmed_at', 'text')
    .addColumn('manage_token_hash', 'text', (c) => c.notNull())
    .addColumn('token_key', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex('channel_subscribers_pending_idx')
    .on('channel_subscribers')
    .columns(['confirmed_at', 'created_at'])
    .execute();
  await db.schema
    .createTable('channel_subscriber_services')
    .addColumn('subscriber_id', 'text', (c) => c.notNull().references('channel_subscribers.id').onDelete('cascade'))
    .addColumn('service_id', 'text', (c) => c.notNull().references('services.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('channel_subscriber_services_pk', ['subscriber_id', 'service_id'])
    .execute();
  await db.schema
    .createIndex('channel_subscriber_services_service_idx')
    .on('channel_subscriber_services')
    .column('service_id')
    .execute();

  await db.schema
    .createTable('channel_outbox')
    .addColumn('id', 'text', (c) => c.primaryKey())
    // webhook | sms
    .addColumn('channel', 'text', (c) => c.notNull())
    // admin_webhook | sms_recipient | subscriber | test
    .addColumn('recipient_type', 'text', (c) => c.notNull())
    .addColumn('recipient_id', 'text')
    // incident.created, ..., subscription.confirm, subscription.manage, test, admin.notice
    .addColumn('event', 'text', (c) => c.notNull())
    // JSON of the event (public text only); '' for messages queued by the database functions.
    .addColumn('payload', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('pending'))
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'text', (c) => c.notNull())
    .addColumn('status_code', 'integer')
    .addColumn('last_error', 'text')
    .addColumn('last_attempt_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('sent_at', 'text')
    .execute();
  await db.schema.createIndex('channel_outbox_status_next_idx').on('channel_outbox').columns(['status', 'next_attempt_at']).execute();
  await db.schema
    .createIndex('channel_outbox_recipient_idx')
    .on('channel_outbox')
    .columns(['recipient_type', 'recipient_id', 'created_at'])
    .execute();
  await db.schema.createIndex('channel_outbox_channel_created_idx').on('channel_outbox').columns(['channel', 'created_at']).execute();

  if (!(await isPostgres(db))) return;
  const b = await baseSchema(db);
  for (const statement of baseStatements(b)) {
    await sql.raw(statement).execute(db);
  }
  if (await publicSchemaExists(db)) await createChannelFunctions(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  if (await isPostgres(db)) {
    const b = await baseSchema(db);
    for (const fn of FUNCTIONS) await sql.raw(`DROP FUNCTION IF EXISTS ${ident(PUBLIC_SCHEMA)}.${fn}`).execute(db);
    for (const fn of [
      'osp_channel_row(text)',
      'osp_queue_channel_message(text, text, text, text)',
      'osp_channel_message_allowed(text)',
      'osp_channel_options()',
      'osp_sms_used_this_month()',
      'osp_channel_settings()',
    ]) {
      await sql.raw(`DROP FUNCTION IF EXISTS ${b}.${fn}`).execute(db);
    }
  }
  for (const table of [...TABLES].reverse()) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
