/**
 * Creates or updates a local user. Updating an existing user sets a new
 * password and role and signs the user out everywhere.
 * Usage: create-user <email> <password> [admin|editor] [name]
 */
import { USER_ROLES, type UserRole } from '@openstatuspage/shared';
import { loadConfig } from '../config.js';
import { createDb, migrateToLatest } from '../db/index.js';
import { createOrResetLocalUser } from '../services/users.js';

const [email, password, roleArg = 'admin', name = 'Administrator'] = process.argv.slice(2);
if (!email || !password || password.length < 10 || !USER_ROLES.includes(roleArg as UserRole)) {
  console.error('Usage: create-user <email> <password (min. 10 chars)> [admin|editor] [name]');
  process.exit(1);
}

const db = await createDb(loadConfig(process.env, { allowMissingSecret: true }));
await migrateToLatest(db);
const normalized = email.trim().toLowerCase();
const result = await createOrResetLocalUser(db, { email: normalized, password, role: roleArg as UserRole, name });
await db.destroy();
if (!result.ok) {
  console.error(`${normalized} is the last admin and cannot be demoted. Nothing was changed.`);
  process.exit(1);
}
console.log(result.created ? `Created ${roleArg} ${normalized}.` : `Updated user ${normalized}; existing sessions were ended.`);
