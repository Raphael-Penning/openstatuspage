/**
 * Creates or updates a local user.
 * Usage: create-user <email> <password> [admin|editor] [name]
 */
import { USER_ROLES, type UserRole } from '@openstatuspage/shared';
import { loadConfig } from '../config.js';
import { createDb, migrateToLatest } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { hashPassword } from '../lib/password.js';
import { nowIso } from '../lib/time.js';

const [email, password, roleArg = 'admin', name = 'Administrator'] = process.argv.slice(2);
if (!email || !password || password.length < 10 || !USER_ROLES.includes(roleArg as UserRole)) {
  console.error('Usage: create-user <email> <password (min. 10 chars)> [admin|editor] [name]');
  process.exit(1);
}

const db = await createDb(loadConfig(process.env, { allowMissingSecret: true }));
await migrateToLatest(db);
const now = nowIso();
const normalized = email.toLowerCase();
const existing = await db.selectFrom('users').select('id').where('email', '=', normalized).executeTakeFirst();
const password_hash = await hashPassword(password);
if (existing) {
  await db
    .updateTable('users')
    .set({ password_hash, role: roleArg as UserRole, updated_at: now })
    .where('id', '=', existing.id)
    .execute();
  console.log(`Updated user ${normalized}.`);
} else {
  await db
    .insertInto('users')
    .values({
      id: newId(),
      email: normalized,
      name,
      role: roleArg as UserRole,
      password_hash,
      oidc_subject: null,
      created_at: now,
      updated_at: now,
      last_login_at: null,
    })
    .execute();
  console.log(`Created ${roleArg} ${normalized}.`);
}
await db.destroy();
