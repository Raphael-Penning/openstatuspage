/**
 * deploy/postgres/harden.sql revokes CREATE on the schema "public" from PUBLIC. A
 * role that created its tables there only through that default grant (an app role
 * on PostgreSQL 14 or older set up without roles.sql) loses the right; the script
 * warns about it so the operator grants it back before the next migration.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, HARDEN_SQL, queryIn, type PgTestDatabase } from './setup.js';

let pgdb: PgTestDatabase;
let database: string;
const role = `osp_legacy_${randomBytes(4).toString('hex')}`;

/** Runs harden.sql as the superuser and returns the warnings it raised. */
async function harden(): Promise<string[]> {
  const client = new pg.Client({ connectionString: pgdb.ownerUrl });
  const warnings: string[] = [];
  client.on('notice', (notice) => {
    if (notice.severity === 'WARNING') warnings.push(notice.message ?? '');
  });
  await client.connect();
  try {
    await client.query(HARDEN_SQL);
  } finally {
    await client.end();
  }
  return warnings;
}

beforeAll(async () => {
  pgdb = await createTestDatabase();
  database = new URL(pgdb.ownerUrl).pathname.slice(1);
  // Like PostgreSQL 14: everybody may create objects in "public", and the app role
  // created its table through that grant only.
  await queryIn(
    process.env.PG_TEST_URL!,
    database,
    `grant create on schema public to public;
     create role ${role} nologin;
     set role ${role};
     create table public.legacy_table (id int);
     reset role;`,
  );
});

afterAll(async () => {
  await pgdb?.drop();
  await queryIn(process.env.PG_TEST_URL!, 'postgres', `drop role if exists ${role}`).catch(() => undefined);
});

describe('harden.sql', () => {
  it('warns about a table owner that loses CREATE on the schema public', async () => {
    const warnings = await harden();
    expect(warnings).toEqual([expect.stringContaining(`role ${role} owns tables in schema public`)]);
    expect(warnings[0]).toContain(`GRANT CREATE ON SCHEMA public TO ${role}`);
  });

  it('stays quiet once the role has its own grant', async () => {
    await queryIn(process.env.PG_TEST_URL!, database, `grant create on schema public to ${role}`);
    expect(await harden()).toEqual([]);
  });
});
