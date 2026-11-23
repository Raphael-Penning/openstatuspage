/**
 * The restricted PostgreSQL role of APP_ROLE=public instances (migration
 * 0007_public_role, docs/security-model.md). Nothing here applies to SQLite.
 */
import { sql } from 'kysely';
import type { DB } from './index.js';
import { createPublicSchema } from './migrations/0007_public_role.js';
import { createPrivatePageFunctions } from './migrations/0009_private_pages.js';
import { hardenPublicSchema } from './migrations/0012_definer_search_path.js';
import { relaxPublicSchema } from './migrations/0013_schema_create_hardening.js';
import { createChannelFunctions } from './migrations/0015_notification_channels.js';

/** Schema with the views and functions of the public role; its search_path. */
export const PUBLIC_SCHEMA = 'osp_public';

/** `missing`: the role does not exist; `no-schema`: the schema osp_public does not exist (see ensurePublicSchema). */
export type PublicRoleGrant = 'granted' | 'missing' | 'no-schema';

/** `missing`: the migrating role may not create schemas (CREATE on the database). */
export type PublicSchemaState = 'exists' | 'created' | 'missing';

async function publicSchemaExists(db: DB): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`select to_regnamespace(${PUBLIC_SCHEMA}) is not null as found`.execute(db);
  return rows[0]?.found === true;
}

/**
 * Creates the schema osp_public when migration 0007 had to skip it because the
 * migrating role could not create schemas then (safe for concurrent starts).
 * Instances that migrate call it on every start.
 */
export async function ensurePublicSchema(db: DB): Promise<PublicSchemaState> {
  if (await publicSchemaExists(db)) return 'exists';
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext('osp_create_public_schema'))`.execute(trx);
    if (await publicSchemaExists(trx)) return 'exists';
    if (!(await createPublicSchema(trx))) return 'missing';
    // Later migrations that add to osp_public (they skip it while the schema is missing).
    await createPrivatePageFunctions(trx);
    await hardenPublicSchema(trx);
    await relaxPublicSchema(trx);
    await createChannelFunctions(trx);
    return 'created';
  });
}

/**
 * Registers `role` as public role and grants it exactly the osp_public schema
 * (idempotent, safe for concurrent starts). Returns `missing` when the role does
 * not exist yet and `no-schema` when osp_public does not exist. Fails when the
 * role is the connecting role, a superuser, has BYPASSRLS or is a member of any
 * role. It also takes CREATE on the table schema and on osp_public away from the
 * role and from PUBLIC where the migrating role may (0013_schema_create_hardening);
 * schemaCreateLeft reports what is left. Needs the table owner.
 */
export async function grantPublicRole(db: DB, role: string): Promise<PublicRoleGrant> {
  if (!(await publicSchemaExists(db))) return 'no-schema';
  const { rows } = await sql<{ granted: boolean }>`select osp_grant_public_role(${role}) as granted`.execute(db);
  return rows[0]?.granted ? 'granted' : 'missing';
}

/**
 * Read only: the commands (for the schema owner or a superuser) that would take
 * CREATE on the table schema and osp_public away from `role` where grantPublicRole
 * could not. Empty when the role may create nothing there.
 */
export async function schemaCreateLeft(db: DB, role: string): Promise<string[]> {
  const { rows } = await sql<{ left: string[] | null }>`select osp_schema_create_left(${role}) as left`.execute(db);
  return rows[0]?.left ?? [];
}

/** Warning for the log of an instance that migrates when schemaCreateLeft found something. */
export function schemaCreateHint(role: string, commands: string[]): string {
  return (
    `the public database role "${role}" may still create objects in the table schema or in ${PUBLIC_SCHEMA}, ` +
    'and this instance may not take that away. Such objects cannot take over the functions it may call ' +
    '(search_path pinned), but the role can still break those functions with an overload, and the sessions of ' +
    'admin and worker instances have the table schema on their search_path. To close it, run once as the schema ' +
    `owner or a superuser: ${commands.join(' ')} (see docs/security-model.md)`
  );
}

/** Hint for the log when osp_public could not be created. */
export function publicSchemaHint(): string {
  return (
    `the schema ${PUBLIC_SCHEMA} does not exist because the database role of this instance may not create schemas. ` +
    'It is only needed for APP_ROLE=public instances: to use them, run ' +
    '`GRANT CREATE ON DATABASE <database> TO <this role>` as a superuser and restart this instance ' +
    '(see docs/security-model.md)'
  );
}

/**
 * On a public instance: whether its login is a registered public role, i.e. the
 * database itself limits what it can read and write.
 */
export async function connectionRestricted(db: DB): Promise<boolean> {
  const { rows } = await sql<{ restricted: boolean }>`select ${sql.id(PUBLIC_SCHEMA)}.connection_restricted() as restricted`.execute(db);
  return rows[0]?.restricted === true;
}

/**
 * On a public instance: the schemas (table schema, osp_public) its login may still
 * create objects in. Empty when it may not, or when the check is not possible yet
 * (the next start of an instance that migrates grants it).
 */
export async function connectionCreateSchemas(db: DB): Promise<string[]> {
  try {
    const { rows } = await sql<{ schemas: string[] | null }>`select ${sql.id(PUBLIC_SCHEMA)}.connection_create_schemas() as schemas`.execute(db);
    return rows[0]?.schemas ?? [];
  } catch {
    return [];
  }
}

export interface PublicRoleSetup {
  schema: PublicSchemaState;
  grant: PublicRoleGrant;
  /** Whether the role exists (also when the grant could not be made). */
  roleExists: boolean;
  /**
   * The migrating role is a superuser: it owns the SECURITY DEFINER functions the public
   * role may call, so a bug in one of them would run with superuser rights.
   */
  ownerIsSuperuser: boolean;
  /** When granted: the commands that would take CREATE away where this role could not (schemaCreateLeft). */
  createLeft: string[];
}

/** On the start of every instance that migrates: ensurePublicSchema, then grantPublicRole. */
export async function setUpPublicRole(db: DB, role: string): Promise<PublicRoleSetup> {
  const schema = await ensurePublicSchema(db);
  const grant = await grantPublicRole(db, role);
  const createLeft = grant === 'granted' ? await schemaCreateLeft(db, role) : [];
  const { rows } = await sql<{ found: boolean; superuser: boolean }>`
    select exists (select 1 from pg_roles where rolname = ${role}) as found,
      (select rolsuper from pg_roles where rolname = current_user) as superuser`.execute(db);
  return { schema, grant, roleExists: rows[0]?.found === true, ownerIsSuperuser: rows[0]?.superuser === true, createLeft };
}
