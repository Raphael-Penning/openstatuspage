/**
 * Creates or updates a local user. Updating an existing user sets a new
 * password and role, signs the user out everywhere and revokes their API tokens.
 * Usage: create-user <email> [admin|editor] [name] [--unlink-oidc]
 * The password comes from OSP_USER_PASSWORD, a prompt or stdin (create-user-input.ts).
 */
import { loadConfig } from '../config.js';
import { createDb, migrateToLatest } from '../db/index.js';
import { createOrResetLocalUser } from '../services/users.js';
import { parseCreateUserArgs, readPassword } from './create-user-input.js';

const parsed = parseCreateUserArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  process.exit(1);
}
const { email, role, name, unlinkOidc } = parsed.args;
const password = await readPassword({ env: process.env, input: process.stdin, output: process.stderr }).catch(
  (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }),
);
if (!password.ok) {
  console.error(password.error);
  process.exit(1);
}

const db = await createDb(loadConfig(process.env, { allowMissingSecret: true }));
await migrateToLatest(db);
const result = await createOrResetLocalUser(db, { email, password: password.password, role, name }, { unlinkOidc });
await db.destroy();
if (!result.ok) {
  console.error(
    result.error === 'oidc_linked'
      ? `${email} is linked to a single sign-on identity. Nothing was changed. Check that this account ` +
          'belongs to the owner of the address, then run the command again with --unlink-oidc: it sets the ' +
          'password and role and removes the SSO link (the next SSO login links again by verified e-mail).'
      : `${email} is the last admin and cannot be demoted. Nothing was changed.`,
  );
  process.exit(1);
}
console.log(
  result.created
    ? `Created ${role} ${email}.`
    : `Updated user ${email}; existing sessions were ended and their API tokens revoked.`,
);
