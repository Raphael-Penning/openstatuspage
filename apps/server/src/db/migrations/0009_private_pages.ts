import { PostgresAdapter, sql, type Kysely } from 'kysely';

/**
 * Private (secret) status pages at /p/<token> (services/private-pages.ts).
 *
 * - private_pages: name, description, enabled flag, optional expiry and the
 *   SHA-256 hash of the link token (the token itself is never stored, like the
 *   subscription tokens of 0006). `token_created_at` is when the current link
 *   was made (creation or the last regeneration).
 * - private_page_services: the services of a page in display order. Any
 *   service, also one hidden from the main page.
 *
 * On PostgreSQL both tables get the row level security of the private tables
 * (0007_public_role): the restricted public role sees no row and holds no
 * privilege on them. It reads a page only through SECURITY DEFINER functions in
 * osp_public that take the token, hash it inside the function and return the
 * rows of that one page: its services (also hidden ones), their history and
 * corrections for the uptime bars and day pages, and the public incidents and
 * maintenance windows that affect them (public text only, links limited to the
 * page's services). A wrong, expired or disabled token returns nothing. When
 * osp_public does not exist yet the functions are created by ensurePublicSchema
 * (db/public-role.ts) together with the schema.
 *
 * Portable column types only (see 0001_initial).
 */

/** Columns of the services a private page shows (the public columns of the services view, without the group). */
const SERVICE_COLUMNS = 'id text, slug text, name text, description text, kind text, url text, current_status text, position integer';

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The osp_public functions of the private pages for base schema `b` (quoted). */
function functionStatements(b: string): string[] {
  const s = ident('osp_public');
  const pin = `SET search_path = ${b}, pg_temp`;
  const definer = `STABLE SECURITY DEFINER ${pin}`;
  /** Ids of the services of the page with this token (none for a wrong, disabled or expired one). */
  const pageServices = `SELECT ps.service_id FROM ${b}.private_page_services ps WHERE ps.page_id = ${b}.osp_private_page_id(p_token)`;
  const out: string[] = [];

  out.push(`CREATE FUNCTION ${s}.private_page(p_token text) RETURNS TABLE (id text, name text, description text)
    LANGUAGE sql ${definer} AS $$
      SELECT p.id, p.name, p.description FROM ${b}.private_pages p WHERE p.id = ${b}.osp_private_page_id(p_token)
    $$`);

  out.push(`CREATE FUNCTION ${s}.private_page_services(p_token text) RETURNS TABLE (${SERVICE_COLUMNS})
    LANGUAGE sql ${definer} AS $$
      SELECT v.id, v.slug, v.name, v.description, v.kind, v.url, v.current_status, ps.sort_order
      FROM ${b}.private_page_services ps JOIN ${b}.services v ON v.id = ps.service_id
      WHERE ps.page_id = ${b}.osp_private_page_id(p_token)
      ORDER BY ps.sort_order, v.name
    $$`);

  // History of the page's services overlapping [p_from, p_to) (p_to null: up to now).
  out.push(`CREATE FUNCTION ${s}.private_page_history(p_token text, p_from text, p_to text)
    RETURNS TABLE (service_id text, status text, started_at text, ended_at text)
    LANGUAGE sql ${definer} AS $$
      SELECT h.service_id, h.status, h.started_at, h.ended_at FROM ${b}.service_status_history h
      WHERE h.service_id IN (${pageServices})
        AND (h.ended_at IS NULL OR h.ended_at >= p_from)
        AND (p_to IS NULL OR h.started_at < p_to)
      ORDER BY h.started_at
    $$`);

  // Corrections of the page's services overlapping [p_from, p_to); the note only when it is public.
  out.push(`CREATE FUNCTION ${s}.private_page_corrections(p_token text, p_from text, p_to text)
    RETURNS TABLE (service_id text, id text, starts_at text, ends_at text, status text, show_public integer,
      public_note text, created_at text)
    LANGUAGE sql ${definer} AS $$
      SELECT cs.service_id, c.id, c.starts_at, c.ends_at, c.status, c.show_public,
        CASE WHEN c.show_public = 1 THEN c.public_note END, c.created_at
      FROM ${b}.status_corrections c JOIN ${b}.status_correction_services cs ON cs.correction_id = c.id
      WHERE cs.service_id IN (${pageServices}) AND c.starts_at < p_to AND c.ends_at > p_from
    $$`);

  // Public retroactive maintenance windows of the page's services that started before p_to (corrected history).
  out.push(`CREATE FUNCTION ${s}.private_page_retroactive_maintenances(p_token text, p_to text)
    RETURNS TABLE (service_id text, id text, status text, scheduled_start text, scheduled_end text,
      actual_start text, actual_end text, created_at text)
    LANGUAGE sql ${definer} AS $$
      SELECT ms.service_id, m.id, m.status, m.scheduled_start, m.scheduled_end, m.actual_start, m.actual_end, m.created_at
      FROM ${b}.maintenances m JOIN ${b}.maintenance_services ms ON ms.maintenance_id = m.id
      WHERE ms.service_id IN (${pageServices}) AND m.retroactive = 1 AND m.is_public = 1
        AND m.status IN ('in_progress', 'completed') AND m.scheduled_start < p_to
    $$`);

  // Public incidents of the page's services: unresolved, or started or resolved since p_since.
  // Only their public text; the affected services are limited to the page's services.
  out.push(`CREATE FUNCTION ${s}.private_page_incidents(p_token text, p_since text)
    RETURNS TABLE (id text, title text, status text, impact text, started_at text, resolved_at text,
      created_at text, updated_at text, services jsonb, updates jsonb)
    LANGUAGE sql ${definer} AS $$
      WITH page AS (${pageServices})
      SELECT i.id, i.title, i.status, i.impact, i.started_at, i.resolved_at, i.created_at, i.updated_at,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'status', x.status) ORDER BY v.sort_order, v.name), '[]'::jsonb)
          FROM ${b}.incident_services x JOIN ${b}.services v ON v.id = x.service_id
          WHERE x.incident_id = i.id AND x.service_id IN (SELECT service_id FROM page)),
        (SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'status', u.status, 'message', u.message, 'created_at', u.created_at)
            ORDER BY u.created_at DESC, u.id DESC), '[]'::jsonb)
          FROM ${b}.incident_updates u WHERE u.incident_id = i.id)
      FROM ${b}.incidents i
      WHERE i.is_public = 1
        AND EXISTS (SELECT 1 FROM ${b}.incident_services x WHERE x.incident_id = i.id AND x.service_id IN (SELECT service_id FROM page))
        AND (i.status <> 'resolved' OR i.started_at >= p_since OR i.resolved_at >= p_since)
      ORDER BY i.started_at DESC, i.id
    $$`);

  // Public, not cancelled maintenance windows of the page's services: scheduled, running, or ended since p_since.
  out.push(`CREATE FUNCTION ${s}.private_page_maintenances(p_token text, p_since text)
    RETURNS TABLE (id text, title text, description text, status text, scheduled_start text, scheduled_end text,
      actual_start text, actual_end text, created_at text, updated_at text, services jsonb, updates jsonb)
    LANGUAGE sql ${definer} AS $$
      WITH page AS (${pageServices})
      SELECT m.id, m.title, m.description, m.status, m.scheduled_start, m.scheduled_end, m.actual_start, m.actual_end,
        m.created_at, m.updated_at,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name) ORDER BY v.sort_order, v.name), '[]'::jsonb)
          FROM ${b}.maintenance_services x JOIN ${b}.services v ON v.id = x.service_id
          WHERE x.maintenance_id = m.id AND x.service_id IN (SELECT service_id FROM page)),
        (SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'status', u.status, 'message', u.message, 'created_at', u.created_at)
            ORDER BY u.created_at DESC, u.id DESC), '[]'::jsonb)
          FROM ${b}.maintenance_updates u WHERE u.maintenance_id = m.id)
      FROM ${b}.maintenances m
      WHERE m.is_public = 1 AND m.status <> 'cancelled'
        AND EXISTS (SELECT 1 FROM ${b}.maintenance_services x WHERE x.maintenance_id = m.id AND x.service_id IN (SELECT service_id FROM page))
        AND (m.status IN ('scheduled', 'in_progress') OR coalesce(m.actual_end, m.scheduled_end) >= p_since)
      ORDER BY m.scheduled_start, m.id
    $$`);

  for (const fn of FUNCTIONS) out.push(`REVOKE ALL ON FUNCTION ${s}.${fn} FROM PUBLIC`);
  // Registered public roles get them at once (instances that migrate grant them on every start anyway).
  out.push(`DO $$ DECLARE r text; BEGIN
      FOR r IN SELECT role_name FROM ${b}.osp_public_roles LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          ${FUNCTIONS.map((fn) => `EXECUTE format('GRANT EXECUTE ON FUNCTION ${s}.${fn} TO %I', r);`).join('\n          ')}
        END IF;
      END LOOP;
    END $$`);
  return out;
}

/** Signatures of the osp_public functions (for REVOKE, GRANT and DROP). */
const FUNCTIONS = [
  'private_page(text)',
  'private_page_services(text)',
  'private_page_history(text, text, text)',
  'private_page_corrections(text, text, text)',
  'private_page_retroactive_maintenances(text, text)',
  'private_page_incidents(text, text)',
  'private_page_maintenances(text, text)',
];

async function isPostgres(db: Kysely<any>): Promise<boolean> {
  return db.getExecutor().adapter instanceof PostgresAdapter;
}

async function baseSchema(db: Kysely<any>): Promise<string> {
  const { rows } = await sql<{ schema: string }>`select current_schema() as schema`.execute(db);
  return ident(rows[0]!.schema);
}

async function publicSchemaExists(db: Kysely<any>): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`select to_regnamespace('osp_public') is not null as found`.execute(db);
  return rows[0]?.found === true;
}

/**
 * Creates the private page functions in osp_public (PostgreSQL). Called by the
 * migration when the schema exists and by ensurePublicSchema right after it
 * created the schema.
 */
export async function createPrivatePageFunctions(db: Kysely<any>): Promise<void> {
  for (const statement of functionStatements(await baseSchema(db))) {
    await sql.raw(statement).execute(db);
  }
}

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('private_pages')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    // SHA-256 (hex) of the link token.
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('token_created_at', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text')
    .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('private_page_services')
    .addColumn('page_id', 'text', (c) => c.notNull().references('private_pages.id').onDelete('cascade'))
    .addColumn('service_id', 'text', (c) => c.notNull().references('services.id').onDelete('cascade'))
    .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
    .addPrimaryKeyConstraint('private_page_services_pk', ['page_id', 'service_id'])
    .execute();
  await db.schema.createIndex('private_page_services_service_idx').on('private_page_services').column('service_id').execute();

  if (!(await isPostgres(db))) return;
  const b = await baseSchema(db);
  const restricted = `(SELECT ${b}.osp_is_public_role(current_user)) IS NOT TRUE`;
  for (const table of ['private_pages', 'private_page_services']) {
    await sql.raw(`ALTER TABLE ${b}.${table} ENABLE ROW LEVEL SECURITY`).execute(db);
    await sql.raw(`CREATE POLICY osp_access ON ${b}.${table} USING (true) WITH CHECK (true)`).execute(db);
    await sql
      .raw(`CREATE POLICY osp_public_role ON ${b}.${table} AS RESTRICTIVE USING (${restricted}) WITH CHECK (${restricted})`)
      .execute(db);
  }
  // The page of a token: enabled, not expired, hash matches. Not callable by the public role.
  await sql
    .raw(
      `CREATE FUNCTION ${b}.osp_private_page_id(p_token text) RETURNS text
        LANGUAGE sql STABLE SET search_path = ${b}, pg_temp AS $$
          SELECT p.id FROM ${b}.private_pages p
          WHERE p_token ~ '^[a-z2-7]{32}$'
            AND p.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
            AND p.enabled = 1
            AND (p.expires_at IS NULL OR p.expires_at > ${b}.osp_iso(clock_timestamp()))
        $$`,
    )
    .execute(db);
  await sql.raw(`REVOKE ALL ON FUNCTION ${b}.osp_private_page_id(text) FROM PUBLIC`).execute(db);
  if (await publicSchemaExists(db)) await createPrivatePageFunctions(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  if (await isPostgres(db)) {
    const b = await baseSchema(db);
    for (const fn of FUNCTIONS) await sql.raw(`DROP FUNCTION IF EXISTS ${ident('osp_public')}.${fn}`).execute(db);
    await sql.raw(`DROP FUNCTION IF EXISTS ${b}.osp_private_page_id(text)`).execute(db);
  }
  await db.schema.dropTable('private_page_services').ifExists().execute();
  await db.schema.dropTable('private_pages').ifExists().execute();
}
