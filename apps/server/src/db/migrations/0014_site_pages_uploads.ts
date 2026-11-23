import { randomUUID } from 'node:crypto';
import { PostgresAdapter, sql, type Kysely } from 'kysely';

/**
 * Content pages and uploaded images (services/site-pages.ts, services/uploads.ts).
 *
 * - site_pages: the four system pages (about, legal-notice, privacy,
 *   accessibility; created here, unpublished, so the external links of the
 *   settings keep working until an admin publishes the internal page) and any
 *   number of custom pages. Title, description and Markdown body per language.
 * - uploads: images (PNG, JPEG, WebP, ICO, at most 1 MiB) with their SHA-256,
 *   type, size in pixels and the bytes themselves (bytea on PostgreSQL, blob on
 *   SQLite), so every instance of a split deployment serves the same files.
 *
 * On PostgreSQL both tables get the row level security of the private tables
 * (0007_public_role): the restricted public role holds no privilege on them and
 * sees no row. It reads them through two views in osp_public that run with the
 * owner's rights (security_barrier, like the views of 0007 that blank columns):
 * `site_pages` with the published pages only and without `created_by`, and
 * `uploads` without `created_by` and the original file name. Every upload is a
 * public asset by design (it is served without login). The registered public
 * roles get SELECT on the views at once; instances that migrate grant it on every
 * start anyway (osp_grant_public_role: SELECT on every view of osp_public). When
 * osp_public does not exist yet, ensurePublicSchema (db/public-role.ts) creates
 * the views together with the schema.
 *
 * Portable column types only (see 0001_initial), except the bytes.
 */

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The system pages with their default titles (shown in the admin; the public page uses the settings labels). */
export const SYSTEM_PAGES = [
  { key: 'about', en: 'About this page', de: 'Über diese Seite', order: 0 },
  { key: 'legal-notice', en: 'Legal notice', de: 'Impressum', order: 1 },
  { key: 'privacy', en: 'Privacy policy', de: 'Datenschutzerklärung', order: 2 },
  { key: 'accessibility', en: 'Accessibility statement', de: 'Erklärung zur Barrierefreiheit', order: 3 },
] as const;

/** Columns of the view osp_public.site_pages (not: created_by). */
const PAGE_COLUMNS = [
  'id',
  'system_key',
  'slug',
  'title_en',
  'title_de',
  'description_en',
  'description_de',
  'body_en',
  'body_de',
  'published',
  'show_in_footer',
  'show_in_nav',
  'sort_order',
  'created_at',
  'updated_at',
];

/** Columns of the view osp_public.uploads (not: filename, created_by). */
const UPLOAD_COLUMNS = ['id', 'hash', 'extension', 'content_type', 'byte_size', 'width', 'height', 'data', 'created_at'];

const VIEWS = ['site_pages', 'uploads'];

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
 * Creates the views of this migration in osp_public (PostgreSQL). Called by the
 * migration when the schema exists and by ensurePublicSchema right after it
 * created the schema.
 */
export async function createContentViews(db: Kysely<any>): Promise<void> {
  const b = await baseSchema(db);
  const s = ident('osp_public');
  const statements = [
    `CREATE VIEW ${s}.site_pages WITH (security_barrier = true) AS
      SELECT ${PAGE_COLUMNS.join(', ')} FROM ${b}.site_pages WHERE published = 1`,
    `CREATE VIEW ${s}.uploads WITH (security_barrier = true) AS
      SELECT ${UPLOAD_COLUMNS.join(', ')} FROM ${b}.uploads`,
    ...VIEWS.map((v) => `REVOKE ALL ON ${s}.${v} FROM PUBLIC`),
    // Registered public roles get them at once (instances that migrate grant them on every start anyway).
    `DO $$ DECLARE r text; BEGIN
      FOR r IN SELECT role_name FROM ${b}.osp_public_roles LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          ${VIEWS.map((v) => `EXECUTE format('GRANT SELECT ON ${s}.${v} TO %I', r);`).join('\n          ')}
        END IF;
      END LOOP;
    END $$`,
  ];
  for (const statement of statements) await sql.raw(statement).execute(db);
}

export async function up(db: Kysely<any>): Promise<void> {
  const pg = await isPostgres(db);

  await db.schema
    .createTable('site_pages')
    .addColumn('id', 'text', (c) => c.primaryKey())
    // about, legal-notice, privacy, accessibility; null for custom pages.
    .addColumn('system_key', 'text', (c) => c.unique())
    .addColumn('slug', 'text', (c) => c.notNull().unique())
    .addColumn('title_en', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('title_de', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('description_en', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('description_de', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('body_en', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('body_de', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('published', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('show_in_footer', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('show_in_nav', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  const now = new Date().toISOString();
  await db
    .insertInto('site_pages')
    .values(
      SYSTEM_PAGES.map((p) => ({
        id: randomUUID(),
        system_key: p.key,
        slug: p.key,
        title_en: p.en,
        title_de: p.de,
        sort_order: p.order,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();

  await db.schema
    .createTable('uploads')
    .addColumn('id', 'text', (c) => c.primaryKey())
    // SHA-256 (hex) of the bytes: the name of the file at /uploads/<hash>.<extension>.
    .addColumn('hash', 'text', (c) => c.notNull().unique())
    .addColumn('extension', 'text', (c) => c.notNull())
    .addColumn('content_type', 'text', (c) => c.notNull())
    .addColumn('byte_size', 'integer', (c) => c.notNull())
    .addColumn('width', 'integer', (c) => c.notNull())
    .addColumn('height', 'integer', (c) => c.notNull())
    .addColumn('data', pg ? 'bytea' : 'blob', (c) => c.notNull())
    .addColumn('filename', 'text')
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  if (!pg) return;
  const b = await baseSchema(db);
  const restricted = `(SELECT ${b}.osp_is_public_role(current_user)) IS NOT TRUE`;
  for (const table of ['site_pages', 'uploads']) {
    await sql.raw(`ALTER TABLE ${b}.${table} ENABLE ROW LEVEL SECURITY`).execute(db);
    await sql.raw(`CREATE POLICY osp_access ON ${b}.${table} USING (true) WITH CHECK (true)`).execute(db);
    await sql
      .raw(`CREATE POLICY osp_public_role ON ${b}.${table} AS RESTRICTIVE USING (${restricted}) WITH CHECK (${restricted})`)
      .execute(db);
  }
  if (await publicSchemaExists(db)) await createContentViews(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  if (await isPostgres(db)) {
    for (const view of VIEWS) await sql.raw(`DROP VIEW IF EXISTS ${ident('osp_public')}.${ident(view)}`).execute(db);
  }
  await db.schema.dropTable('uploads').ifExists().execute();
  await db.schema.dropTable('site_pages').ifExists().execute();
}
