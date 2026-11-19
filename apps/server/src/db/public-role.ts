/**
 * The restricted PostgreSQL role of APP_ROLE=public instances (migration
 * 0007_public_role, docs/security-model.md). Nothing here applies to SQLite.
 */
import { sql } from 'kysely';
import type { DB } from './index.js';

/** Schema with the views and functions of the public role; its search_path. */
export const PUBLIC_SCHEMA = 'osp_public';

export type PublicRoleGrant = 'granted' | 'missing';

/**
 * Registers `role` as public role and grants it exactly the osp_public schema
 * (idempotent, safe for concurrent starts). Returns `missing` when the role does
 * not exist yet. Fails when the role is the connecting role, a superuser, has
 * BYPASSRLS or is a member of the connecting role. Needs the table owner.
 */
export async function grantPublicRole(db: DB, role: string): Promise<PublicRoleGrant> {
  const { rows } = await sql<{ granted: boolean }>`select osp_grant_public_role(${role}) as granted`.execute(db);
  return rows[0]?.granted ? 'granted' : 'missing';
}

/**
 * On a public instance: whether its login is a registered public role, i.e. the
 * database itself limits what it can read and write.
 */
export async function connectionRestricted(db: DB): Promise<boolean> {
  const { rows } = await sql<{ restricted: boolean }>`select ${sql.id(PUBLIC_SCHEMA)}.connection_restricted() as restricted`.execute(db);
  return rows[0]?.restricted === true;
}
