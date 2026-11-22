/**
 * The SECURITY DEFINER functions of the public role and their helpers resolve
 * built-ins in pg_catalog only (migration 0012_definer_search_path), and CREATE on
 * the table schema is taken away from a public role (0013_schema_create_hardening):
 * on PostgreSQL 14 and older (and clusters upgraded from them) PUBLIC may CREATE in
 * the schema "public" by default. Every query of the "public" connection runs AS
 * that role.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/index.js';
import { connectionRestricted } from '../src/db/public-role.js';
import { privatePageTokenHash } from '../src/services/private-page-store.js';
import { newPrivatePageToken } from '../src/services/private-pages.js';
import { subscriptionTokenHashes } from '../src/services/subscriptions.js';
import { prepareDatabase } from '../src/startup.js';
import { createTestDatabase, TOKEN_KEY, type PgTestDatabase } from './setup.js';

const NOW = new Date().toISOString();
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
const DAY_AGO = new Date(Date.now() - 86_400_000).toISOString();

let pgdb: PgTestDatabase;
let owner: DB;
let pub: DB;
const log = { info: () => undefined, warn: () => undefined };
const pageToken = newPrivatePageToken();

async function seed(db: DB): Promise<void> {
  const ts = { created_at: NOW, updated_at: NOW };
  await db
    .insertInto('settings')
    .values({ key: 'page', value: JSON.stringify({ siteName: 'Example Status', emailSubscriptionsEnabled: true }), updated_at: NOW })
    .execute();
  await db
    .insertInto('services')
    .values({
      id: 'svc-1',
      slug: 'api',
      name: 'API',
      description: null,
      kind: 'service',
      url: null,
      group_id: null,
      sort_order: 0,
      is_public: 1,
      status_mode: 'auto',
      manual_status: 'operational',
      aggregation: 'worst',
      current_status: 'operational',
      monitor_status: 'operational',
      status_changed_at: null,
      ...ts,
    } as never)
    .execute();
  await db
    .insertInto('incidents')
    .values({
      id: 'inc-1',
      title: 'Outage',
      status: 'investigating',
      impact: 'major',
      is_public: 1,
      source: 'manual',
      started_at: HOUR_AGO,
      resolved_at: null,
      created_by: null,
      ...ts,
    })
    .execute();
  await db.insertInto('incident_services').values({ incident_id: 'inc-1', service_id: 'svc-1', status: 'major_outage' }).execute();
  await db
    .insertInto('private_pages')
    .values({
      id: 'page-1',
      name: 'Page',
      description: null,
      token_hash: privatePageTokenHash(pageToken),
      token_created_at: NOW,
      expires_at: null,
      enabled: 1,
      created_by: null,
      ...ts,
    })
    .execute();
  await db.insertInto('private_page_services').values({ page_id: 'page-1', service_id: 'svc-1', sort_order: 0 }).execute();
}

const ownerRows = async <T = Record<string, unknown>>(query: string) => (await sql.raw<T>(query).execute(owner)).rows;

beforeAll(async () => {
  pgdb = await createTestDatabase();
  owner = await pgdb.connect('admin');
  await prepareDatabase(owner, pgdb.config('admin'), log);
  await seed(owner);
  pub = await pgdb.connect('public');
}, 60_000);

afterAll(async () => {
  await pub?.destroy();
  await owner?.destroy();
  await pgdb?.drop();
});

describe('functions of the public role', () => {
  it('all pin search_path to pg_catalog, pg_temp', async () => {
    const functions = await ownerRows<{ name: string; config: string[] | null; volatility: string }>(`
      select p.oid::regprocedure::text as name, p.proconfig as config, p.provolatile as volatility from pg_proc p
      where p.pronamespace = 'osp_public'::regnamespace
        or (p.pronamespace = current_schema()::regnamespace and p.proname like 'osp\\_%')`);
    expect(functions.length).toBeGreaterThan(20);
    expect(functions.filter((f) => !f.config?.includes('search_path=pg_catalog, pg_temp')).map((f) => f.name)).toEqual([]);
    // It reads clock_timestamp().
    expect(functions.find((f) => f.name.startsWith('osp_private_page_id'))?.volatility).toBe('v');
  });

  it('never call a function the table schema shadows a built-in with', async () => {
    // Exact-type overloads of the polymorphic built-ins the functions use, as a role with
    // CREATE on the table schema could place them. Calling one fails the query.
    await sql
      .raw(
        `create function public.cardinality(text[]) returns integer language plpgsql as $$
           begin raise exception 'shadow called'; end $$;
         create function public.osp_t_shadow(jsonb, jsonb) returns jsonb language plpgsql as $$
           begin raise exception 'shadow called'; end $$;
         create aggregate public.jsonb_agg(jsonb) (sfunc = public.osp_t_shadow, stype = jsonb);
         grant execute on function public.cardinality(text[]) to public;
         grant execute on function public.osp_t_shadow(jsonb, jsonb) to public;
         grant execute on function public.jsonb_agg(jsonb) to public`,
      )
      .execute(owner);
    try {
      const salt = 'shadow-subscriber-salt';
      const hashes = subscriptionTokenHashes(TOKEN_KEY, { id: 'sub-shadow', token_salt: salt });
      await sql`select osp_public.subscribe(${'sub-shadow'}, ${'shadow@example.com'}, ${'en'}, ${false}, ${['svc-1']}::text[],
        ${salt}, ${hashes.confirm_token_hash}, ${hashes.manage_token_hash}, ${hashes.token_key})`.execute(pub);
      expect(await ownerRows(`select service_id from subscriber_services where subscriber_id = 'sub-shadow'`)).toEqual([
        { service_id: 'svc-1' },
      ]);
      const { rows } = await sql<{ id: string; services: unknown }>`select id, services from osp_public.private_page_incidents(${pageToken}, ${DAY_AGO})`.execute(
        pub,
      );
      expect(rows).toEqual([{ id: 'inc-1', services: [{ id: 'svc-1', name: 'API', status: 'major_outage' }] }]);
    } finally {
      await sql
        .raw(
          `drop aggregate public.jsonb_agg(jsonb); drop function public.osp_t_shadow(jsonb, jsonb);
           drop function public.cardinality(text[])`,
        )
        .execute(owner);
    }
  });
});

describe('a public role that may create objects in the table schema', () => {
  const publicCreate = async (schema: string) =>
    (
      await ownerRows<{ found: boolean }>(`select exists (select 1 from pg_namespace n, aclexplode(n.nspacl) a
        where n.nspname = '${schema}' and a.grantee = 0 and a.privilege_type = 'CREATE') as found`)
    )[0]!.found;

  for (const schema of ['public', 'osp_public']) {
    it(`loses CREATE granted to PUBLIC on ${schema} when it is granted`, async () => {
      await sql.raw(`grant create on schema ${schema} to public`).execute(owner);
      expect(await publicCreate(schema)).toBe(true);
      const warnings: string[] = [];
      const collect = { info: () => undefined, warn: (_: object, msg: string) => warnings.push(msg) };
      // The migrating instance (a superuser here) takes it away and starts without a warning ...
      const { rows } = await sql<{ granted: boolean }>`select osp_grant_public_role(${pgdb.publicRole}) as granted`.execute(owner);
      expect(rows[0]!.granted).toBe(true);
      expect(await publicCreate(schema)).toBe(false);
      await prepareDatabase(owner, pgdb.config('admin'), collect);
      // ... and so does the public instance.
      expect(await connectionRestricted(pub)).toBe(true);
      await prepareDatabase(pub, pgdb.config('public'), collect);
      expect(warnings.filter((w) => !w.includes('superuser'))).toEqual([]);
    });
  }

  it('is granted after CREATE granted to the role itself is taken away', async () => {
    await sql.raw(`grant create on schema public to ${pgdb.publicRole}`).execute(owner);
    const { rows } = await sql<{ granted: boolean }>`select osp_grant_public_role(${pgdb.publicRole}) as granted`.execute(owner);
    expect(rows[0]!.granted).toBe(true);
    expect(await connectionRestricted(pub)).toBe(true);
  });
});
