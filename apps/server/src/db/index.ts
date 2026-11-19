import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Kysely, PostgresDialect, sql, SqliteDialect } from 'kysely';
import { Migrator, type MigrationProvider } from 'kysely/migration';
import type { Config } from '../config.js';
import { migrations } from './migrations/index.js';
import { PUBLIC_SCHEMA } from './public-role.js';
import type { Database } from './types.js';

export type DB = Kysely<Database>;

/**
 * Opens the database. On PostgreSQL an APP_ROLE=public instance uses search_path
 * osp_public: its unchanged queries then read the views of public rows and columns
 * instead of the tables (0007_public_role, docs/security-model.md).
 */
export async function createDb(config: Pick<Config, 'database'> & Partial<Pick<Config, 'APP_ROLE'>>): Promise<DB> {
  if (config.database.dialect === 'postgres') {
    const { default: pg } = await import('pg');
    return new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          connectionString: config.database.connectionString,
          max: 10,
          ...(config.APP_ROLE === 'public' ? { options: `-c search_path=${PUBLIC_SCHEMA}` } : {}),
        }),
      }),
    });
  }

  const { default: SQLite } = await import('better-sqlite3');
  const filename = config.database.filename;
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const sqlite = new SQLite(filename);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}

const provider: MigrationProvider = {
  getMigrations: async () => migrations,
};

export async function migrateToLatest(db: DB): Promise<void> {
  const migrator = new Migrator({ db, provider });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Error') throw new Error(`Migration ${r.migrationName} failed`);
  }
  if (error) throw error;
}

/** Name of the newest migration this build knows; the schema version it expects. */
export const EXPECTED_MIGRATION: string = Object.keys(migrations).at(-1)!;

export interface SchemaStatus {
  /** Newest applied migration, null when none is applied (or the table does not exist yet). */
  applied: string | null;
  expected: string;
  /** `current`: as expected; `behind`: migrations are missing; `ahead`: the database is newer than this build. */
  state: 'current' | 'behind' | 'ahead';
}

/**
 * Reads the applied schema version from Kysely's migration table (`kysely_migration`,
 * resolved through the connection's search_path) without changing anything.
 * Errors other than a missing table (e.g. no privilege) are thrown.
 */
export async function schemaStatus(db: DB): Promise<SchemaStatus> {
  let applied: string | null = null;
  try {
    const { rows } = await sql<{ name: string }>`select name from kysely_migration order by name desc limit 1`.execute(db);
    applied = rows[0]?.name ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/no such table|does not exist/i.test(message)) throw err;
  }
  const expected = EXPECTED_MIGRATION;
  const state = applied === expected ? 'current' : applied !== null && !(applied in migrations) ? 'ahead' : 'behind';
  return { applied, expected, state };
}

export interface WaitForSchemaOptions {
  /** Give up after this many milliseconds (0 = check once). */
  timeoutMs: number;
  /** Delay between checks. */
  intervalMs?: number;
  /** Called before every wait (logging). */
  onWait?: (status: SchemaStatus | null, error: unknown) => void;
}

/**
 * For instances that never migrate (APP_ROLE=public): waits until another instance
 * has migrated the database to EXPECTED_MIGRATION. Throws a clear error when the
 * schema is newer than this build or still behind after the timeout.
 */
export async function waitForSchema(db: DB, options: WaitForSchemaOptions): Promise<SchemaStatus> {
  const deadline = Date.now() + options.timeoutMs;
  const interval = options.intervalMs ?? 2000;
  for (;;) {
    let status: SchemaStatus | null = null;
    let error: unknown = null;
    try {
      status = await schemaStatus(db);
    } catch (err) {
      error = err;
    }
    if (status?.state === 'current') return status;
    if (status?.state === 'ahead') {
      throw new Error(
        `Database schema ${status.applied} is newer than this build expects (${status.expected}). Update this instance.`,
      );
    }
    if (Date.now() >= deadline) {
      const reason = status
        ? `the database is at ${status.applied ?? 'no migration'}, this build expects ${status.expected}`
        : `the schema version could not be read (${error instanceof Error ? error.message : String(error)})`;
      throw new Error(
        `Database schema is not ready: ${reason}. This instance never runs migrations (APP_ROLE=public): ` +
          'start an admin or worker instance (or run `db:migrate`) first, or raise SCHEMA_WAIT_SECONDS.',
      );
    }
    options.onWait?.(status, error);
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
  }
}

export type { Database } from './types.js';
