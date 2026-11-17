import type { AdminUser } from '@openstatuspage/shared';
import type { DB } from '../db/index.js';
import type { User } from '../db/types.js';

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
