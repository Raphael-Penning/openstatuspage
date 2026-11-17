import type { Config } from './config.js';
import type { DB } from './db/index.js';
import { newId } from './lib/ids.js';
import { hashPassword } from './lib/password.js';
import { nowIso } from './lib/time.js';

/** Creates the initial admin from ADMIN_EMAIL / ADMIN_PASSWORD when no user exists yet. */
export async function ensureInitialAdmin(db: DB, config: Config): Promise<'created' | 'exists' | 'skipped'> {
  const any = await db.selectFrom('users').select('id').limit(1).executeTakeFirst();
  if (any) return 'exists';
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) return 'skipped';
  const now = nowIso();
  await db
    .insertInto('users')
    .values({
      id: newId(),
      email: config.ADMIN_EMAIL.toLowerCase(),
      name: 'Administrator',
      role: 'admin',
      password_hash: await hashPassword(config.ADMIN_PASSWORD),
      oidc_subject: null,
      created_at: now,
      updated_at: now,
      last_login_at: null,
    })
    .execute();
  return 'created';
}
