import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import { Migrator, type MigrationProvider } from 'kysely/migration';
import type { Config } from '../config.js';
import { migrations } from './migrations/index.js';
import type { Database } from './types.js';

export type DB = Kysely<Database>;

export async function createDb(config: Pick<Config, 'database'>): Promise<DB> {
  if (config.database.dialect === 'postgres') {
    const { default: pg } = await import('pg');
    return new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: config.database.connectionString, max: 10 }),
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

export type { Database } from './types.js';
