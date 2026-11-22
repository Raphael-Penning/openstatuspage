/**
 * PostgreSQL integration tests (pnpm --filter @openstatuspage/server test:pg).
 *
 *   PG_TEST_URL         a role that may CREATE DATABASE (e.g. the CI superuser); it
 *                       owns the tables, like an admin/worker instance
 *   PG_TEST_PUBLIC_URL  the restricted public role (deploy/postgres/roles.sql),
 *                       same server; its database name is ignored
 *
 * Every test file gets a fresh database, dropped afterwards.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, type DB } from '../src/db/index.js';

export const SECRET_KEY = 'pg-test-secret-key-that-is-long-enough-1234567890';
/** Key of the subscription tokens: the only key the public instance gets (no SECRET_KEY). */
export const TOKEN_KEY = 'pg-test-subscription-token-key-1234567890abcdef';
export const BASE_URL = 'https://status.example.com';

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The PostgreSQL tests need PG_TEST_URL (owner, may create databases) and ` +
        'PG_TEST_PUBLIC_URL (the restricted public role, see deploy/postgres/roles.sql).',
    );
  }
  return value;
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export const HARDEN_SQL = readFileSync(new URL('../../../deploy/postgres/harden.sql', import.meta.url), 'utf8');

/** Runs `text` in `database` as the user of `url`. */
export async function queryIn(url: string, database: string, text: string): Promise<void> {
  const client = new pg.Client({ connectionString: withDatabase(url, database) });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

/** The grant of deploy/postgres/roles.sql for an app role that is not a superuser. */
export const GRANT_ADVISORY_LOCKS = (role: string) => `
  DO $$ DECLARE f regprocedure; BEGIN
    FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
      WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname LIKE 'pg\_%advisory\_%' LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, '${role}');
    END LOOP;
  END $$`;

export interface PgTestDatabase {
  /** Owner connection URL of the test database. */
  ownerUrl: string;
  /** Public role connection URL of the test database. */
  publicUrl: string;
  /** Name of the public role (user of PG_TEST_PUBLIC_URL). */
  publicRole: string;
  config(role: Config['APP_ROLE'], extra?: Record<string, string>): Config;
  /** A connection like the one of an instance with this role (public: search_path osp_public). */
  connect(role: Config['APP_ROLE']): Promise<DB>;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<PgTestDatabase> {
  const adminUrl = env('PG_TEST_URL');
  const publicBase = env('PG_TEST_PUBLIC_URL');
  const name = `osp_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  // Like deploy/postgres/roles.sql: no advisory locks, large objects or temporary tables
  // for roles that are not granted them (the owner here is a superuser).
  await queryIn(adminUrl, name, HARDEN_SQL);

  const ownerUrl = withDatabase(adminUrl, name);
  const publicUrl = withDatabase(publicBase, name);
  const publicRole = decodeURIComponent(new URL(publicBase).username);
  const config = (role: Config['APP_ROLE'], extra: Record<string, string> = {}) =>
    loadConfig({
      NODE_ENV: 'test',
      APP_ROLE: role,
      DATABASE_URL: role === 'public' ? publicUrl : ownerUrl,
      DB_PUBLIC_ROLE: publicRole,
      // Like a split deployment: the public instance never holds SECRET_KEY.
      ...(role === 'public' ? {} : { SECRET_KEY }),
      SUBSCRIPTION_TOKEN_KEY: TOKEN_KEY,
      BASE_URL,
      MAIL_TRANSPORT: 'log',
      SMTP_FROM: 'Example Status <status@example.com>',
      LOG_LEVEL: 'silent',
      ...extra,
    });
  return {
    ownerUrl,
    publicUrl,
    publicRole,
    config,
    connect: (role) => createDb(config(role)),
    async drop() {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}
