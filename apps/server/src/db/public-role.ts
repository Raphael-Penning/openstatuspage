/**
 * The restricted PostgreSQL role of APP_ROLE=public instances (migration
 * 0007_public_role, docs/security-model.md). Nothing here applies to SQLite.
 */
import { sql } from 'kysely';
import type { DB } from './index.js';
import { createPublicSchema } from './migrations/0007_public_role.js';

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
    return (await createPublicSchema(trx)) ? 'created' : 'missing';
  });
}

/**
 * Registers `role` as public role and grants it exactly the osp_public schema
 * (idempotent, safe for concurrent starts). Returns `missing` when the role does
 * not exist yet and `no-schema` when osp_public does not exist. Fails when the
 * role is the connecting role, a superuser, has BYPASSRLS or is a member of any
 * role. Needs the table owner.
 */
export async function grantPublicRole(db: DB, role: string): Promise<PublicRoleGrant> {
  if (!(await publicSchemaExists(db))) return 'no-schema';
  const { rows } = await sql<{ granted: boolean }>`select osp_grant_public_role(${role}) as granted`.execute(db);
  return rows[0]?.granted ? 'granted' : 'missing';
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

export interface PublicRoleSetup {
  schema: PublicSchemaState;
  grant: PublicRoleGrant;
  /** Whether the role exists (also when the grant could not be made). */
  roleExists: boolean;
}

/** On the start of every instance that migrates: ensurePublicSchema, then grantPublicRole. */
export async function setUpPublicRole(db: DB, role: string): Promise<PublicRoleSetup> {
  const schema = await ensurePublicSchema(db);
  const grant = await grantPublicRole(db, role);
  const { rows } = await sql<{ found: boolean }>`select exists (select 1 from pg_roles where rolname = ${role}) as found`.execute(db);
  return { schema, grant, roleExists: rows[0]?.found === true };
}
