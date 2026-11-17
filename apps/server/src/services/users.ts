import type { AdminUser, UserRole } from '@openstatuspage/shared';
import type { DB } from '../db/index.js';
import type { User } from '../db/types.js';
import { newId } from '../lib/ids.js';
import { hashPassword } from '../lib/password.js';
import { nowIso } from '../lib/time.js';
import { deleteUserSessions } from './sessions.js';

export function toAdminUser(u: User): AdminUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    hasPassword: u.password_hash !== null,
    oidcLinked: u.oidc_subject !== null,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

export async function countAdmins(db: DB): Promise<number> {
  const row = await db
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('role', '=', 'admin')
    .executeTakeFirstOrThrow();
  return Number(row.n);
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
    const user = await trx.selectFrom('users').select('role').where('id', '=', userId).executeTakeFirst();
    if (!user || user.role === role) return 'unchanged';
    const demotion = user.role === 'admin' && role !== 'admin';
    if (demotion && (await countAdmins(trx)) <= 1) return 'last_admin';
    await trx.updateTable('users').set({ role, updated_at: nowIso() }).where('id', '=', userId).execute();
    if (demotion) {
      await trx.deleteFrom('api_tokens').where('created_by', '=', userId).where('role', '=', 'admin').execute();
    }
    return 'changed';
  });
}

export type LocalUserResult = { ok: true; created: boolean } | { ok: false; error: 'last_admin' };

/**
 * Creates a local user or, when the e-mail exists, sets a new password and role
 * (create-user CLI). A reset is also the answer to a compromised account, so it
 * signs the user out everywhere.
 */
export async function createOrResetLocalUser(
  db: DB,
  input: { email: string; password: string; role: UserRole; name: string },
): Promise<LocalUserResult> {
  const email = input.email.trim().toLowerCase();
  const password_hash = await hashPassword(input.password);
  const now = nowIso();
  const existing = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
  if (existing) {
    // Role first: a refused demotion leaves the account untouched.
    if ((await changeUserRole(db, existing.id, input.role)) === 'last_admin') return { ok: false, error: 'last_admin' };
    await db.updateTable('users').set({ password_hash, updated_at: now }).where('id', '=', existing.id).execute();
    await deleteUserSessions(db, existing.id);
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
