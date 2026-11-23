import { PostgresAdapter, sql, type Kysely } from 'kysely';

/**
 * Themes of the public pages (services/themes.ts, docs/themes.md).
 *
 * - themes: the themes uploaded in the management UI: the theme file as JSON
 *   text and the optional extra CSS. Built-in themes and the themes folder
 *   (THEMES_DIR) have no row.
 * - active_theme: one row (slot `active`) with the id of the active theme,
 *   whatever its source, and whether an admin accepted that it fails WCAG AA.
 *   Starts with the built-in `default`.
 *
 * The accent colour of 0.3.x page settings becomes an override of the theme's
 * accent: kept when an admin chose one, removed when it is the old default
 * (#7c6cf2, the accent of the built-in default theme), so other themes show
 * their own accent.
 *
 * On PostgreSQL both tables get the row level security of the private tables
 * (0007_public_role). The restricted public role reads them through two views
 * in osp_public that run with the owner's rights (security_barrier): the
 * `active_theme` row, and `themes` with the active theme only (no other
 * theme, no `created_by`). Nothing else of them is visible to it, and it can
 * change nothing. When osp_public does not exist yet, ensurePublicSchema
 * (db/public-role.ts) creates the views together with the schema.
 *
 * Portable column types only (see 0001_initial).
 */

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The accent of 0.3.x settings that equals the built-in default theme. */
const OLD_DEFAULT_ACCENT = '#7c6cf2';

const VIEWS = ['active_theme', 'themes'];

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
export async function createThemeViews(db: Kysely<any>): Promise<void> {
  const b = await baseSchema(db);
  const s = ident('osp_public');
  const statements = [
    `CREATE VIEW ${s}.active_theme WITH (security_barrier = true) AS
      SELECT slot, theme_id, contrast_accepted, updated_at FROM ${b}.active_theme WHERE slot = 'active'`,
    `CREATE VIEW ${s}.themes WITH (security_barrier = true) AS
      SELECT t.id, t.name, t.definition, t.css, t.created_at, t.updated_at FROM ${b}.themes t
      WHERE t.id = (SELECT a.theme_id FROM ${b}.active_theme a WHERE a.slot = 'active')`,
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
  await db.schema
    .createTable('themes')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('definition', 'text', (c) => c.notNull())
    .addColumn('css', 'text')
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('active_theme')
    .addColumn('slot', 'text', (c) => c.primaryKey())
    .addColumn('theme_id', 'text', (c) => c.notNull())
    .addColumn('contrast_accepted', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  const now = new Date().toISOString();
  await db.insertInto('active_theme').values({ slot: 'active', theme_id: 'default', contrast_accepted: 0, updated_at: now }).execute();

  // The old default accent is the accent of the default theme: no override.
  const page = await db.selectFrom('settings').select('value').where('key', '=', 'page').executeTakeFirst();
  if (page) {
    let value: Record<string, unknown> | null = null;
    try {
      value = JSON.parse(page.value as string) as Record<string, unknown>;
    } catch {
      value = null;
    }
    if (value && typeof value.accentColor === 'string' && value.accentColor.toLowerCase() === OLD_DEFAULT_ACCENT) {
      delete value.accentColor;
      await db.updateTable('settings').set({ value: JSON.stringify(value), updated_at: now }).where('key', '=', 'page').execute();
    }
  }

  if (!(await isPostgres(db))) return;
  const b = await baseSchema(db);
  const restricted = `(SELECT ${b}.osp_is_public_role(current_user)) IS NOT TRUE`;
  for (const table of ['themes', 'active_theme']) {
    await sql.raw(`REVOKE ALL ON ${b}.${table} FROM PUBLIC`).execute(db);
    await sql.raw(`ALTER TABLE ${b}.${table} ENABLE ROW LEVEL SECURITY`).execute(db);
    await sql.raw(`CREATE POLICY osp_access ON ${b}.${table} USING (true) WITH CHECK (true)`).execute(db);
    await sql
      .raw(`CREATE POLICY osp_public_role ON ${b}.${table} AS RESTRICTIVE USING (${restricted}) WITH CHECK (${restricted})`)
      .execute(db);
  }
  if (await publicSchemaExists(db)) await createThemeViews(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  if (await isPostgres(db)) {
    for (const view of VIEWS) await sql.raw(`DROP VIEW IF EXISTS ${ident('osp_public')}.${ident(view)}`).execute(db);
  }
  // Back to an explicit accent: the 0.3.x pages always have one.
  const page = await db.selectFrom('settings').select('value').where('key', '=', 'page').executeTakeFirst();
  if (page) {
    try {
      const value = JSON.parse(page.value as string) as Record<string, unknown>;
      if (typeof value.accentColor !== 'string') {
        value.accentColor = OLD_DEFAULT_ACCENT;
        await db.updateTable('settings').set({ value: JSON.stringify(value) }).where('key', '=', 'page').execute();
      }
    } catch {
      // leave unreadable settings alone
    }
  }
  await db.schema.dropTable('active_theme').ifExists().execute();
  await db.schema.dropTable('themes').ifExists().execute();
}
