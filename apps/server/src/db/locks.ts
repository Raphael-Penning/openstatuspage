/**
 * Database-level serialisation for work that must not interleave, also across
 * several instances: on PostgreSQL a transaction holding a transaction-scoped
 * advisory lock (pg_advisory_xact_lock), released on commit or rollback.
 * SQLite runs a single instance: the work runs directly on the connection,
 * unchanged.
 *
 * The work must only use the executor it is given (never the pool), so a
 * transaction waiting for the lock holds one connection and the holder never
 * needs a second one.
 */
import { PostgresAdapter, sql, type Kysely } from 'kysely';
import type { Database, DB } from './index.js';

/** Advisory lock keys of this application (one namespace for the whole database). */
export const LOCK_KEYS = {
  /** Applying history imports (services/history-import.ts). */
  historyImportApply: 4_711_005,
  /** Storing bundle evaluations (services/bundles.ts). */
  bundleRecompute: 4_711_006,
  /** Recomputing service status and its history (services/status-engine.ts). */
  statusEngine: 4_711_007,
} as const;

export function isPostgres(db: Kysely<Database>): boolean {
  return db.getExecutor().adapter instanceof PostgresAdapter;
}

/** Runs `fn` while holding the advisory lock `key` (PostgreSQL) or directly (SQLite). */
export async function serialized<T>(db: DB, key: number, fn: (q: Kysely<Database>) => Promise<T>): Promise<T> {
  if (!isPostgres(db)) return fn(db);
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${key})`.execute(trx);
    return fn(trx);
  });
}
