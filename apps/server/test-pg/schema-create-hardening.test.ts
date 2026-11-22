/**
 * Migration 0013_schema_create_hardening: CREATE on the table schema is taken away
 * from PUBLIC and the public role without any manual step, whichever role
 * migrates, and what that role may not take away is a warning, not a refusal.
 * "PUBLIC may CREATE on public" is the default before PostgreSQL 15 and on
 * clusters upgraded from there; these tests grant it on PostgreSQL 17.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, EXPECTED_MIGRATION, migrateToLatest, schemaStatus, type DB } from '../src/db/index.js';
import { migrations } from '../src/db/migrations/index.js';
import { connectionRestricted, schemaCreateLeft } from '../src/db/public-role.js';
import { subscriptionTokenHashes } from '../src/services/subscriptions.js';
import { prepareDatabase } from '../src/startup.js';
import { createTestDatabase, GRANT_ADVISORY_LOCKS, queryIn, SECRET_KEY, TOKEN_KEY, type PgTestDatabase } from './setup.js';

const NOW = new Date().toISOString();
const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
});

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  warnings: string[];
}

function newLog(): Log {
  const warnings: string[] = [];
  return { warnings, info: () => undefined, warn: (_: object, msg: string) => warnings.push(msg) };
}

const databaseOf = (pgdb: PgTestDatabase) => new URL(pgdb.ownerUrl).pathname.slice(1);
const asSuperuser = (pgdb: PgTestDatabase, text: string) => queryIn(process.env.PG_TEST_URL!, databaseOf(pgdb), text);

async function testDatabase(): Promise<PgTestDatabase> {
  const pgdb = await createTestDatabase();
  cleanups.push(() => pgdb.drop());
  return pgdb;
}

async function connect(pgdb: PgTestDatabase, role: Config['APP_ROLE']): Promise<DB> {
  const db = await pgdb.connect(role);
  cleanups.push(() => db.destroy());
  return db;
}

/** A login that is not a superuser, set up like the app role of deploy/postgres/roles.sql. */
async function appRole(pgdb: PgTestDatabase, grants: string): Promise<{ name: string; url: string }> {
  const name = `osp_t_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  await asSuperuser(pgdb, `create role ${name} login password '${password}'; ${grants.replaceAll('{role}', name)}`);
  await asSuperuser(pgdb, GRANT_ADVISORY_LOCKS(name));
  cleanups.push(() => queryIn(process.env.PG_TEST_URL!, 'postgres', `drop role if exists ${name}`));
  const url = new URL(pgdb.ownerUrl);
  url.username = name;
  url.password = password;
  return { name, url: url.toString() };
}

function configFor(pgdb: PgTestDatabase, url: string, role: Config['APP_ROLE'] = 'all'): Config {
  return loadConfig({
    NODE_ENV: 'test',
    APP_ROLE: role,
    DATABASE_URL: url,
    DB_PUBLIC_ROLE: pgdb.publicRole,
    SECRET_KEY,
    SUBSCRIPTION_TOKEN_KEY: TOKEN_KEY,
    LOG_LEVEL: 'silent',
  });
}

/** Whether `grantee` ('public' for PUBLIC) holds CREATE on `schema` by an ACL entry of its own. */
async function holdsCreate(db: DB, schema: string, grantee: string): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`select exists (
      select 1 from pg_namespace n, aclexplode(n.nspacl) a
      where n.nspname = ${schema} and a.privilege_type = 'CREATE'
        and a.grantee = case when ${grantee} = 'public' then 0::oid else (select oid from pg_roles where rolname = ${grantee}) end
    ) as found`.execute(db);
  return rows[0]!.found;
}

async function mayCreate(db: DB, role: string, schema: string): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`select has_schema_privilege(${role}, ${schema}, 'CREATE') as ok`.execute(db);
  return rows[0]!.ok;
}

const withoutSuperuserNote = (warnings: string[]) => warnings.filter((w) => !w.includes('migrates as a superuser'));

describe('a) a superuser migrates while PUBLIC may CREATE on public', () => {
  it('the migration takes CREATE away from PUBLIC and the public role, without a warning', async () => {
    const pgdb = await testDatabase();
    const owner = await connect(pgdb, 'admin');
    await prepareDatabase(owner, pgdb.config('admin'), newLog());
    // Like PostgreSQL 14, plus a direct grant to the public role on osp_public. Then the migration
    // runs again (the functions are replaced, so it is idempotent).
    await sql
      .raw(`grant create on schema public to public; grant create on schema osp_public to ${pgdb.publicRole};
        delete from kysely_migration where name = '0013_schema_create_hardening'`)
      .execute(owner);
    expect(await mayCreate(owner, pgdb.publicRole, 'public')).toBe(true);
    await migrateToLatest(owner);
    expect(await holdsCreate(owner, 'public', 'public')).toBe(false);
    expect(await mayCreate(owner, pgdb.publicRole, 'public')).toBe(false);
    expect(await mayCreate(owner, pgdb.publicRole, 'osp_public')).toBe(false);
    const log = newLog();
    await prepareDatabase(owner, pgdb.config('admin'), log);
    expect(withoutSuperuserNote(log.warnings)).toEqual([]);
    expect(await schemaCreateLeft(owner, pgdb.publicRole)).toEqual([]);
  });
});

describe('b) PostgreSQL 15+ layout: the owner of the database (not a superuser) migrates while PUBLIC may CREATE on public', () => {
  it('takes CREATE away from PUBLIC and keeps its own (pg_database_owner owns the schema public)', async () => {
    const pgdb = await testDatabase();
    const app = await appRole(pgdb, `alter database ${databaseOf(pgdb)} owner to {role}; grant create on schema public to public`);
    const db = await createDb(configFor(pgdb, app.url));
    cleanups.push(() => db.destroy());
    const log = newLog();
    await prepareDatabase(db, configFor(pgdb, app.url), log);
    expect(log.warnings).toEqual([]);
    expect((await schemaStatus(db)).applied).toBe(EXPECTED_MIGRATION);
    expect(await holdsCreate(db, 'public', 'public')).toBe(false);
    expect(await mayCreate(db, pgdb.publicRole, 'public')).toBe(false);
    expect(await mayCreate(db, app.name, 'public')).toBe(true);
    const pub = await connect(pgdb, 'public');
    expect(await connectionRestricted(pub)).toBe(true);
    // It may not add an overload with a default argument next to a helper of the definer functions.
    await expect(
      sql.raw('create function public.osp_iso(timestamptz, integer default 0) returns text language sql as $$ select null $$').execute(pub),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('c) an app role that may not revoke (the schema belongs to a superuser) while PUBLIC may CREATE on public', () => {
  it('migrates, warns with the command, starts every role, and a shadowing function does not take over the functions', async () => {
    const pgdb = await testDatabase();
    // As deploy/postgres/roles.sql sets up osp_app, in a database a superuser owns.
    const app = await appRole(
      pgdb,
      `grant connect, create on database ${databaseOf(pgdb)} to {role}; grant usage, create on schema public to {role};
       grant create on schema public to public`,
    );
    const command = 'REVOKE CREATE ON SCHEMA public FROM PUBLIC;';
    for (const role of ['all', 'admin'] as const) {
      const config = configFor(pgdb, app.url, role);
      const db = await createDb(config);
      cleanups.push(() => db.destroy());
      const log = newLog();
      await prepareDatabase(db, config, log);
      expect(log.warnings).toEqual([expect.stringContaining(command)]);
      expect(log.warnings[0]).toContain(`"${pgdb.publicRole}"`);
      expect(await schemaCreateLeft(db, pgdb.publicRole)).toEqual([command]);
      expect(await holdsCreate(db, 'public', 'public')).toBe(true);
    }

    const pub = await connect(pgdb, 'public');
    const log = newLog();
    await prepareDatabase(pub, pgdb.config('public'), log);
    expect(log.warnings).toEqual([expect.stringContaining('may create objects in the table schema')]);
    expect(await connectionRestricted(pub)).toBe(true);

    // The public role places an exact-type overload of a built-in the definer functions call.
    const owner = await connect(pgdb, 'admin');
    await sql
      .raw(
        `insert into settings (key, value, updated_at) values ('page', '{"siteName":"S","emailSubscriptionsEnabled":true}', '${NOW}');
         insert into services (id, slug, name, kind, sort_order, is_public, status_mode, manual_status, aggregation,
           current_status, monitor_status, created_at, updated_at)
         values ('svc-1', 'api', 'API', 'service', 0, 1, 'auto', 'operational', 'worst', 'operational', 'operational',
           '${NOW}', '${NOW}')`,
      )
      .execute(owner);
    await sql
      .raw(
        `create function public.cardinality(text[]) returns integer language plpgsql as $$
           begin raise exception 'shadow called'; end $$`,
      )
      .execute(pub);
    const salt = 'shadow-subscriber-salt';
    const hashes = subscriptionTokenHashes(TOKEN_KEY, { id: 'sub-shadow', token_salt: salt });
    await sql`select osp_public.subscribe(${'sub-shadow'}, ${'shadow@example.com'}, ${'en'}, ${false}, ${['svc-1']}::text[],
      ${salt}, ${hashes.confirm_token_hash}, ${hashes.manage_token_hash}, ${hashes.token_key})`.execute(pub);
    const { rows } = await sql<{ service_id: string }>`select service_id from subscriber_services where subscriber_id = 'sub-shadow'`.execute(
      owner,
    );
    expect(rows).toEqual([{ service_id: 'svc-1' }]);
  });

  it('names the grant it needs when it created its tables only through PUBLIC', async () => {
    const pgdb = await testDatabase();
    const app = await appRole(pgdb, `grant connect, create on database ${databaseOf(pgdb)} to {role}; grant create on schema public to public`);
    const config = configFor(pgdb, app.url);
    const db = await createDb(config);
    cleanups.push(() => db.destroy());
    const log = newLog();
    await prepareDatabase(db, config, log);
    const command = `GRANT CREATE ON SCHEMA public TO ${app.name}; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`;
    expect(log.warnings).toEqual([expect.stringContaining(command)]);
    // It did not take CREATE away from itself.
    expect(await mayCreate(db, app.name, 'public')).toBe(true);
  });
});

describe('c2) PostgreSQL 14 layout: the app role owns the database, a superuser the schema public', () => {
  /** pg_namespace row version of the schema public: changes on every write of its ACL. */
  async function rowVersion(db: DB): Promise<string> {
    const { rows } = await sql<{ xmin: string }>`select xmin::text as xmin from pg_namespace where nspname = 'public'`.execute(db);
    return rows[0]!.xmin;
  }

  it('stays in the warning state without writing the schema row, also for parallel starts', async () => {
    const pgdb = await testDatabase();
    // CREATE DATABASE ... OWNER app on PostgreSQL 14: public belongs to the bootstrap superuser
    // and PUBLIC may CREATE there.
    const app = await appRole(
      pgdb,
      `alter database ${databaseOf(pgdb)} owner to {role}; alter schema public owner to current_user;
       grant create on schema public to public`,
    );
    const asApp = (text: string) => queryIn(app.url, databaseOf(pgdb), text);
    const config = configFor(pgdb, app.url, 'admin');
    const first = await createDb(config);
    cleanups.push(() => first.destroy());
    await prepareDatabase(first, config, newLog());
    const command = `GRANT CREATE ON SCHEMA public TO ${app.name}; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`;
    expect(await schemaCreateLeft(first, pgdb.publicRole)).toEqual([command]);
    // The hardening runs no statement that would change nothing (it wrote the row on every call).
    const before = await rowVersion(first);
    await sql`select osp_harden_schema_create(${pgdb.publicRole})`.execute(first);
    expect(await rowVersion(first)).toBe(before);
    // 30 calls at once from separate connections: none fails with "tuple concurrently updated".
    await Promise.all(Array.from({ length: 30 }, () => asApp(`select osp_harden_schema_create('${pgdb.publicRole}')`)));

    // Admin and worker restarting together after a rollout, several times over.
    const dbs: DB[] = [];
    for (let i = 0; i < 6; i++) {
      const db = await createDb(configFor(pgdb, app.url, i % 2 === 0 ? 'admin' : 'worker'));
      cleanups.push(() => db.destroy());
      dbs.push(db);
    }
    const logs = dbs.map(() => newLog());
    for (let round = 0; round < 3; round++) {
      await Promise.all(dbs.map((db, i) => prepareDatabase(db, configFor(pgdb, app.url, i % 2 === 0 ? 'admin' : 'worker'), logs[i]!)));
    }
    for (const log of logs) {
      expect(log.warnings.length).toBe(3);
      for (const warning of log.warnings) expect(warning).toContain(command);
    }
    expect(await holdsCreate(first, 'public', 'public')).toBe(true);

    const pub = await connect(pgdb, 'public');
    expect(await connectionRestricted(pub)).toBe(true);

    // Closing it with the command from the warning, as a superuser, ends the warning.
    await asSuperuser(pgdb, command);
    const log = newLog();
    await prepareDatabase(first, config, log);
    expect(log.warnings).toEqual([]);
    expect(await mayCreate(first, app.name, 'public')).toBe(true);
  });

  it('the public role may still break its own functions with an overload while the warning lasts', async () => {
    const pgdb = await testDatabase();
    const app = await appRole(
      pgdb,
      `alter database ${databaseOf(pgdb)} owner to {role}; alter schema public owner to current_user;
       grant create on schema public to public`,
    );
    const config = configFor(pgdb, app.url, 'admin');
    const db = await createDb(config);
    cleanups.push(() => db.destroy());
    await prepareDatabase(db, config, newLog());
    // Not a takeover (search_path pinned, the overload is never called), but an ambiguous call:
    // the reason the warning asks for the command instead of calling this harmless.
    const pub = await connect(pgdb, 'public');
    await sql
      .raw('create function public.osp_is_public_role(name, integer default 0) returns boolean language sql as $$ select false $$')
      .execute(pub);
    await expect(connectionRestricted(pub)).rejects.toThrow(/is not unique/);
    // Only its own functions: the policies hold the helper by oid, and admin and worker still start.
    await prepareDatabase(db, config, newLog());
  });
});

describe('down to 0012', () => {
  it('restores the refusal of osp_grant_public_role and connection_restricted', async () => {
    const pgdb = await testDatabase();
    const owner = await connect(pgdb, 'admin');
    await prepareDatabase(owner, pgdb.config('admin'), newLog());
    const migrator = new Migrator({ db: owner, provider: { getMigrations: async () => migrations } });
    expect((await migrator.migrateTo('0012_definer_search_path')).error).toBeUndefined();
    const pub = await connect(pgdb, 'public');
    expect(await connectionRestricted(pub)).toBe(true);
    await sql.raw('grant create on schema public to public').execute(owner);
    expect(await connectionRestricted(pub)).toBe(false);
    await expect(sql`select osp_grant_public_role(${pgdb.publicRole})`.execute(owner)).rejects.toThrow(
      /may create objects .*REVOKE CREATE ON SCHEMA public FROM PUBLIC/,
    );
    // And up again: fixed without a manual step.
    await migrateToLatest(owner);
    expect(await holdsCreate(owner, 'public', 'public')).toBe(false);
    expect(await connectionRestricted(pub)).toBe(true);
  });
});

describe('d) upgrade from 0.2.x while PUBLIC may CREATE on public', () => {
  it('migrates from the 0.2.0 schema to the newest in one go without a manual step', async () => {
    const pgdb = await testDatabase();
    const owner = await connect(pgdb, 'admin');
    await sql.raw('grant create on schema public to public').execute(owner);
    const migrator = new Migrator({ db: owner, provider: { getMigrations: async () => migrations } });
    expect((await migrator.migrateTo('0009_private_pages')).error).toBeUndefined();
    // What a 0.2.0 admin instance did on start.
    await sql`select osp_grant_public_role(${pgdb.publicRole})`.execute(owner);
    const log = newLog();
    await prepareDatabase(owner, pgdb.config('admin'), log);
    expect(withoutSuperuserNote(log.warnings)).toEqual([]);
    expect((await schemaStatus(owner)).applied).toBe(EXPECTED_MIGRATION);
    expect(await holdsCreate(owner, 'public', 'public')).toBe(false);
    const pub = await connect(pgdb, 'public');
    const publicLog = newLog();
    await prepareDatabase(pub, pgdb.config('public'), publicLog);
    expect(publicLog.warnings).toEqual([]);
  });

  it('recovers a database where 0.3.0 refused to start (0012 applied)', async () => {
    const pgdb = await testDatabase();
    const owner = await connect(pgdb, 'admin');
    await sql.raw('grant create on schema public to public').execute(owner);
    const migrator = new Migrator({ db: owner, provider: { getMigrations: async () => migrations } });
    expect((await migrator.migrateTo('0012_definer_search_path')).error).toBeUndefined();
    await expect(sql`select osp_grant_public_role(${pgdb.publicRole})`.execute(owner)).rejects.toThrow(/may create objects/);
    const log = newLog();
    await prepareDatabase(owner, pgdb.config('admin'), log);
    expect(withoutSuperuserNote(log.warnings)).toEqual([]);
    expect(await holdsCreate(owner, 'public', 'public')).toBe(false);
  });
});

describe('e) fresh install', () => {
  it('has nothing to do and warns about nothing', async () => {
    const pgdb = await testDatabase();
    const owner = await connect(pgdb, 'admin');
    const log = newLog();
    await prepareDatabase(owner, pgdb.config('admin'), log);
    expect(withoutSuperuserNote(log.warnings)).toEqual([]);
    expect(await schemaCreateLeft(owner, pgdb.publicRole)).toEqual([]);
    const pub = await connect(pgdb, 'public');
    const publicLog = newLog();
    await prepareDatabase(pub, pgdb.config('public'), publicLog);
    expect(publicLog.warnings).toEqual([]);
  });

  it('leaves PUBLIC alone without a public role (APP_ROLE=all)', async () => {
    const pgdb = await testDatabase();
    const owner = await connect(pgdb, 'admin');
    await sql.raw('grant create on schema public to public').execute(owner);
    const config = loadConfig({
      NODE_ENV: 'test',
      APP_ROLE: 'all',
      DATABASE_URL: pgdb.ownerUrl,
      DB_PUBLIC_ROLE: `osp_t_missing_${randomBytes(4).toString('hex')}`,
      SECRET_KEY,
      LOG_LEVEL: 'silent',
    });
    const db = await createDb(config);
    cleanups.push(() => db.destroy());
    const log = newLog();
    await prepareDatabase(db, config, log);
    expect(log.warnings).toEqual([]);
    expect((await schemaStatus(db)).applied).toBe(EXPECTED_MIGRATION);
    expect(await holdsCreate(db, 'public', 'public')).toBe(true);
  });
});
