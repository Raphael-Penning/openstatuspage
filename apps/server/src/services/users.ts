import type { AdminUser, UserRole } from '@openstatuspage/shared';
import type { Kysely } from 'kysely';
import type { Database, DB } from '../db/index.js';
import { isPostgres } from '../db/locks.js';
import type { User } from '../db/types.js';
import { newId } from '../lib/ids.js';
import { hashPassword } from '../lib/password.js';
import { nowIso } from '../lib/time.js';
import { deleteUserSessions } from './sessions.js';

/** `linked`: the user has at least one SSO identity (see linkedUserIds). */
export function toAdminUser(u: User, linked: boolean): AdminUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    hasPassword: u.password_hash !== null,
    oidcLinked: linked,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

/** Ids of the users (of `userIds`, or all) linked to at least one SSO identity. */
export async function linkedUserIds(db: Kysely<Database>, userIds?: string[]): Promise<Set<string>> {
  if (userIds && userIds.length === 0) return new Set();
  let query = db.selectFrom('user_oidc_identities').select('user_id').distinct();
  if (userIds) query = query.where('user_id', 'in', userIds);
  return new Set((await query.execute()).map((r) => r.user_id));
}

export async function toAdminUserWithLinks(db: Kysely<Database>, u: User): Promise<AdminUser> {
  return toAdminUser(u, (await linkedUserIds(db, [u.id])).has(u.id));
}

/**
 * Number of admins, inside a transaction. On PostgreSQL the admin rows stay
 * locked until the transaction ends (always in id order, so concurrent callers
 * cannot deadlock): two admins demoting or deleting each other at the same
 * moment are serialised, and the second one sees the first one's change, so
 * the instance never ends up without an admin. SQLite runs every transaction
 * on its single connection, one after the other.
 */
async function lockAdmins(trx: Kysely<Database>): Promise<number> {
  const query = trx.selectFrom('users').select('id').where('role', '=', 'admin').orderBy('id');
  const rows = await (isPostgres(trx) ? query.forUpdate() : query).execute();
  return rows.length;
}

/** Role of a user inside a transaction, the row locked on PostgreSQL; undefined when missing. */
export async function lockUserRole(trx: Kysely<Database>, userId: string): Promise<UserRole | undefined> {
  const query = trx.selectFrom('users').select('role').where('id', '=', userId);
  return (await (isPostgres(trx) ? query.forUpdate() : query).executeTakeFirst())?.role;
}

export type RoleChangeResult = 'changed' | 'unchanged' | 'last_admin';

/**
 * Sets a user's role. Every role change (admin UI, OIDC group sync, CLI) goes
 * through here so the demotion rules hold everywhere:
 * - the last admin is never demoted (`last_admin`, nothing changes), so the
 *   instance always stays manageable;
 * - API tokens never outrank their creator: demotion revokes the user's admin
 *   tokens.
 */
export async function changeUserRole(db: DB, userId: string, role: UserRole): Promise<RoleChangeResult> {
  return db.transaction().execute(async (trx) => {
    // Admins first, then the user: the same lock order everywhere.
    const admins = await lockAdmins(trx);
    const current = await lockUserRole(trx, userId);
    if (!current || current === role) return 'unchanged';
    const demotion = current === 'admin' && role !== 'admin';
    if (demotion && admins <= 1) return 'last_admin';
    await trx.updateTable('users').set({ role, updated_at: nowIso() }).where('id', '=', userId).execute();
    if (demotion) {
      await trx.deleteFrom('api_tokens').where('created_by', '=', userId).where('role', '=', 'admin').execute();
    }
    return 'changed';
  });
}

/**
 * Stores an API token (admin API) owned by `createdBy`. The owner's admin role is
 * checked again in the insert transaction, with the user row locked on
 * PostgreSQL: a demotion that commits after the request was authorized either
 * makes this fail (false, nothing stored) or runs after it and revokes the new
 * token with the owner's other admin tokens.
 */
export async function insertApiToken(
  db: DB,
  token: { id: string; name: string; role: UserRole; tokenHash: string; createdBy: string | null; createdAt: string },
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    if (token.createdBy !== null && (await lockUserRole(trx, token.createdBy)) !== 'admin') return false;
    await trx
      .insertInto('api_tokens')
      .values({
        id: token.id,
        name: token.name,
        role: token.role,
        token_hash: token.tokenHash,
        created_by: token.createdBy,
        created_at: token.createdAt,
        last_used_at: null,
      })
      .execute();
    return true;
  });
}

export type DeleteUserResult = 'deleted' | 'not_found' | 'last_admin';

/**
 * Deletes a user and revokes the API tokens they created (sessions cascade;
 * authored records keep their content with created_by = NULL). The last admin
 * is never deleted; the check and the delete are one transaction (lockAdmins).
 */
export async function deleteUser(db: DB, userId: string): Promise<DeleteUserResult> {
  return db.transaction().execute(async (trx) => {
    const admins = await lockAdmins(trx);
    const role = await lockUserRole(trx, userId);
    if (!role) return 'not_found';
    if (role === 'admin' && admins <= 1) return 'last_admin';
    await trx.deleteFrom('api_tokens').where('created_by', '=', userId).execute();
    await trx.deleteFrom('users').where('id', '=', userId).execute();
    return 'deleted';
  });
}

export type LocalUserResult = { ok: true; created: boolean } | { ok: false; error: 'last_admin' | 'oidc_linked' };

/**
 * Ends every session of a user and revokes the API tokens they created: the
 * response to a password reset, which is also how a compromised account is
 * recovered. Tokens would otherwise keep working with the old credentials.
 */
export async function revokeUserCredentials(db: DB, userId: string, exceptSessionToken?: string | null): Promise<void> {
  await deleteUserSessions(db, userId, exceptSessionToken);
  await db.deleteFrom('api_tokens').where('created_by', '=', userId).execute();
}

/**
 * Creates a local user or, when the e-mail exists, sets a new password and role
 * (create-user CLI). A reset is also the answer to a compromised account, so it
 * signs the user out everywhere and revokes the API tokens they created.
 *
 * An account linked to an SSO identity is refused (`oidc_linked`) unless
 * `unlinkOidc` is set: the password and role would otherwise also reach whoever
 * holds that IdP identity, which is not necessarily the owner of the address.
 * With `unlinkOidc` the link is removed; the next SSO login links again only
 * through a verified e-mail.
 */
export async function createOrResetLocalUser(
  db: DB,
  input: { email: string; password: string; role: UserRole; name: string },
  options: { unlinkOidc?: boolean } = {},
): Promise<LocalUserResult> {
  const email = input.email.trim().toLowerCase();
  const password_hash = await hashPassword(input.password);
  const now = nowIso();
  const existing = await db.selectFrom('users').select(['id']).where('email', '=', email).executeTakeFirst();
  if (existing) {
    const linked = (await linkedUserIds(db, [existing.id])).has(existing.id);
    if (linked && !options.unlinkOidc) return { ok: false, error: 'oidc_linked' };
    // Role first: a refused demotion leaves the account untouched.
    if ((await changeUserRole(db, existing.id, input.role)) === 'last_admin') return { ok: false, error: 'last_admin' };
    await db.updateTable('users').set({ password_hash, updated_at: now }).where('id', '=', existing.id).execute();
    // Every SSO identity of every provider.
    if (linked) await db.deleteFrom('user_oidc_identities').where('user_id', '=', existing.id).execute();
    await revokeUserCredentials(db, existing.id);
    return { ok: true, created: false };
  }
  await db
    .insertInto('users')
    .values({
      id: newId(),
      email,
      name: input.name,
      role: input.role,
      password_hash,
      oidc_subject: null,
      created_at: now,
      updated_at: now,
      last_login_at: null,
    })
    .execute();
  return { ok: true, created: true };
}
