/**
 * Migrating as a role that may not create schemas, as in many existing
 * APP_ROLE=all installations: it only has USAGE and CREATE on the schema "public".
 * The migrations must still succeed; the schema osp_public follows once the role
 * gets CREATE on the database.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb, EXPECTED_MIGRATION, schemaStatus, type DB } from '../src/db/index.js';
import { connectionRestricted } from '../src/db/public-role.js';
import { prepareDatabase } from '../src/startup.js';
import { createTestDatabase, GRANT_ADVISORY_LOCKS, SECRET_KEY, type PgTestDatabase } from './setup.js';

let pgdb: PgTestDatabase;
let db: DB;
let config: ReturnType<typeof loadConfig>;
const role = `osp_t_${randomBytes(4).toString('hex')}`;
const password = randomBytes(12).toString('hex');
const logs: string[] = [];
const log = { info: (_: object, msg: string) => logs.push(msg), warn: (_: object, msg: string) => logs.push(`WARN ${msg}`) };

async function asSuperuser(database: string, text: string): Promise<void> {
  const url = new URL(process.env.PG_TEST_URL!);
  url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  pgdb = await createTestDatabase();
  const database = new URL(pgdb.ownerUrl).pathname.slice(1);
  await asSuperuser(database, `create role ${role} login password '${password}'`);
  await asSuperuser(database, `grant usage, create on schema public to ${role}`);
  // As deploy/postgres/roles.sql does for the app role (the migrations take an advisory lock).
  await asSuperuser(database, GRANT_ADVISORY_LOCKS(role));
  const url = new URL(pgdb.ownerUrl);
  url.username = role;
  url.password = password;
  config = loadConfig({
    NODE_ENV: 'test',
    APP_ROLE: 'all',
    DATABASE_URL: url.toString(),
    DB_PUBLIC_ROLE: pgdb.publicRole,
    SECRET_KEY,
    LOG_LEVEL: 'silent',
  });
  db = await createDb(config);
  await prepareDatabase(db, config, log);
}, 60_000);

afterAll(async () => {
  await db?.destroy();
  await pgdb?.drop();
  await asSuperuser('postgres', `drop role if exists ${role}`).catch(() => undefined);
});

describe('a migrating role without CREATE on the database', () => {
  it('applies every migration and leaves out only the schema osp_public', async () => {
    expect((await schemaStatus(db)).applied).toBe(EXPECTED_MIGRATION);
    const { rows } = await sql<{ found: boolean }>`select to_regnamespace('osp_public') is not null as found`.execute(db);
    expect(rows[0]!.found).toBe(false);
    // Row level security is in place anyway.
    const rls = await sql<{ on: boolean }>`select relrowsecurity as on from pg_class where relname = 'subscribers'`.execute(db);
    expect(rls.rows[0]!.on).toBe(true);
    expect(logs.find((l) => l.includes('may not create schemas'))).toMatch(/^WARN .*GRANT CREATE ON DATABASE/);
  });

  it('creates the schema and grants the public role once the privilege is granted', async () => {
    const database = new URL(pgdb.ownerUrl).pathname.slice(1);
    await asSuperuser(database, `grant create on database ${database} to ${role}`);
    logs.length = 0;
    await prepareDatabase(db, config, log);
    expect(logs).toContain('public schema created');
    expect(logs).toContain('public database role granted');
    const pub = await pgdb.connect('public');
    try {
      expect(await connectionRestricted(pub)).toBe(true);
      expect((await schemaStatus(pub)).applied).toBe(EXPECTED_MIGRATION);
    } finally {
      await pub.destroy();
    }
  });
});
