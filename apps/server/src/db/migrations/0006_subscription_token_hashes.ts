import type { Kysely } from 'kysely';

/**
 * SHA-256 hashes of the subscription confirm/manage tokens.
 *
 * The tokens themselves are still derived from SECRET_KEY and `token_salt` and
 * never stored. The hashes let the database check a token without knowing
 * SECRET_KEY and without revealing the salt: the functions of the restricted
 * public database role (0007_public_role) verify tokens this way. `token_key`
 * names the SECRET_KEY the hashes were derived from (a fingerprint, not the key),
 * so instances that know the key refresh outdated rows on start
 * (see syncSubscriptionTokenHashes).
 *
 * Portable column types only (see 0001_initial).
 */
export async function up(db: Kysely<any>): Promise<void> {
  // One column per statement: SQLite cannot add several columns in one ALTER TABLE.
  await db.schema.alterTable('subscribers').addColumn('confirm_token_hash', 'text').execute();
  await db.schema.alterTable('subscribers').addColumn('manage_token_hash', 'text').execute();
  await db.schema.alterTable('subscribers').addColumn('token_key', 'text').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('subscribers').dropColumn('token_key').execute();
  await db.schema.alterTable('subscribers').dropColumn('manage_token_hash').execute();
  await db.schema.alterTable('subscribers').dropColumn('confirm_token_hash').execute();
}
