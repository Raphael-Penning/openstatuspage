/**
 * Private pages on PostgreSQL (migration 0009_private_pages): the restricted
 * public role holds no privilege on the private page tables and reaches a page
 * only through the token-scoped SECURITY DEFINER functions of osp_public. Every
 * query of the "public" connection runs AS that role (search_path osp_public).
 */
import { PRIVATE_PAGE_TOKEN_HEADER } from '@openstatuspage/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { DB } from '../src/db/index.js';
import { privatePageTokenHash } from '../src/services/private-page-store.js';
import { newPrivatePageToken } from '../src/services/private-pages.js';
import { prepareDatabase } from '../src/startup.js';
import { createWebDir, renderFromSource, rootOf } from '../test/web-fixture.js';
import { createTestDatabase, type PgTestDatabase } from './setup.js';

const NOW = new Date().toISOString();
const DAY_AGO = new Date(Date.now() - 86_400_000).toISOString();
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

let pgdb: PgTestDatabase;
let owner: DB;
let pub: DB;
const log = { info: () => undefined, warn: () => undefined };

const ids = {
  service: 'svc-public',
  hidden: 'svc-hidden-a',
  otherHidden: 'svc-hidden-b',
  pageA: 'page-a',
  pageB: 'page-b',
  disabled: 'page-off',
  expired: 'page-old',
};
const tokens = {
  a: newPrivatePageToken(),
  b: newPrivatePageToken(),
  disabled: newPrivatePageToken(),
  expired: newPrivatePageToken(),
};

async function seed(db: DB): Promise<void> {
  const ts = { created_at: NOW, updated_at: NOW };
  await db.insertInto('settings').values({ key: 'page', value: JSON.stringify({ siteName: 'Example Status', uptimeDays: 7 }), updated_at: NOW }).execute();
  const service = (id: string, name: string, isPublic: number) => ({
    id,
    slug: id,
    name,
    description: null,
    kind: 'service' as const,
    url: null,
    group_id: null,
    sort_order: 0,
    is_public: isPublic,
    status_mode: 'auto' as const,
    manual_status: 'operational' as const,
    aggregation: 'worst' as const,
    current_status: isPublic ? ('operational' as const) : ('major_outage' as const),
    monitor_status: 'operational' as const,
    status_changed_at: null,
    ...ts,
  });
  await db
    .insertInto('services')
    .values([service(ids.service, 'Public API', 1), service(ids.hidden, 'Partner backend', 0), service(ids.otherHidden, 'Other secret', 0)] as never)
    .execute();
  await db
    .insertInto('service_status_history')
    .values([
      { id: 'h1', service_id: ids.service, status: 'operational', started_at: DAY_AGO, ended_at: null, source: 'live' },
      { id: 'h2', service_id: ids.hidden, status: 'major_outage', started_at: HOUR_AGO, ended_at: null, source: 'live' },
      { id: 'h3', service_id: ids.otherHidden, status: 'major_outage', started_at: HOUR_AGO, ended_at: null, source: 'live' },
    ])
    .execute();
  const incident = (id: string, title: string, isPublic: number) => ({
    id,
    title,
    status: 'investigating' as const,
    impact: 'major' as const,
    is_public: isPublic,
    source: 'manual' as const,
    started_at: HOUR_AGO,
    resolved_at: null,
    created_by: null,
    ...ts,
  });
  await db
    .insertInto('incidents')
    .values([incident('inc-a', 'Backend outage', 1), incident('inc-b', 'Other outage', 1), incident('inc-internal', 'Internal only', 0)])
    .execute();
  await db
    .insertInto('incident_services')
    .values([
      // Affects both hidden services: page A must only see its own link.
      { incident_id: 'inc-a', service_id: ids.hidden, status: 'major_outage' },
      { incident_id: 'inc-a', service_id: ids.otherHidden, status: 'major_outage' },
      { incident_id: 'inc-b', service_id: ids.otherHidden, status: 'major_outage' },
      { incident_id: 'inc-internal', service_id: ids.hidden, status: 'major_outage' },
    ])
    .execute();
  await db
    .insertInto('incident_updates')
    .values([
      { id: 'u-a', incident_id: 'inc-a', status: 'investigating', message: 'We are on it.', created_by: null, created_at: HOUR_AGO },
      { id: 'u-internal', incident_id: 'inc-internal', status: 'investigating', message: 'INTERNAL NOTE', created_by: null, created_at: HOUR_AGO },
    ])
    .execute();
  const page = (id: string, name: string, token: string, extra: { enabled?: number; expires_at?: string | null } = {}) => ({
    id,
    name,
    description: null,
    token_hash: privatePageTokenHash(token),
    token_created_at: NOW,
    expires_at: extra.expires_at ?? null,
    enabled: extra.enabled ?? 1,
    created_by: null,
    ...ts,
  });
  await db
    .insertInto('private_pages')
    .values([
      page(ids.pageA, 'Page A', tokens.a),
      page(ids.pageB, 'Page B', tokens.b),
      page(ids.disabled, 'Disabled', tokens.disabled, { enabled: 0 }),
      page(ids.expired, 'Expired', tokens.expired, { expires_at: DAY_AGO }),
    ])
    .execute();
  await db
    .insertInto('private_page_services')
    .values([
      { page_id: ids.pageA, service_id: ids.hidden, sort_order: 0 },
      { page_id: ids.pageA, service_id: ids.service, sort_order: 1 },
      { page_id: ids.pageB, service_id: ids.otherHidden, sort_order: 0 },
      { page_id: ids.disabled, service_id: ids.hidden, sort_order: 0 },
      { page_id: ids.expired, service_id: ids.hidden, sort_order: 0 },
    ])
    .execute();
}

async function attempt(query: string): Promise<string> {
  try {
    await sql.raw(query).execute(pub);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

/** Runs `query` AS the public role; `$1`, `$2` ... are the `values` in order. */
async function rows<T = Record<string, unknown>>(query: string, ...values: unknown[]): Promise<T[]> {
  const parts = query.split(/\$\d+/);
  const pieces = parts.flatMap((part, i) => (i < values.length ? [sql.raw(part), sql`${values[i]}`] : [sql.raw(part)]));
  return (await sql.join(pieces, sql.raw('')).execute(pub)).rows as T[];
}

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

describe('private page tables', () => {
  it('are not readable by the public role, neither directly nor through osp_public', async () => {
    for (const table of ['private_pages', 'private_page_services']) {
      expect(await attempt(`select * from public.${table}`), table).toBe('42501');
      expect(await attempt(`select count(*) from public.${table}`), table).toBe('42501');
      expect(await attempt(`select token_hash from public.private_pages`), table).toBe('42501');
      expect(await attempt(`select * from osp_public.${table}`), table).toBe('42P01');
    }
    // The helper that maps a token to its page is not callable either.
    expect(await attempt(`select public.osp_private_page_id('${tokens.a}')`)).toBe('42501');
  });

  it('keep hidden services out of the views of the public role', async () => {
    const services = await rows<{ id: string }>('select id from osp_public.services');
    expect(services.map((s) => s.id)).toEqual([ids.service]);
    expect(await rows('select * from osp_public.service_status_history where service_id = $1', ids.hidden)).toEqual([]);
  });
});

describe('token-scoped functions', () => {
  it('are SECURITY DEFINER with a pinned search_path, not executable by PUBLIC, executable by the public role', async () => {
    const fns = (
      await sql<{ name: string; definer: boolean; config: string[] | null; public_exec: boolean; role_exec: boolean }>`
        select p.proname as name, p.prosecdef as definer, p.proconfig as config,
          exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
          has_function_privilege(${pgdb.publicRole}, p.oid, 'EXECUTE') as role_exec
        from pg_proc p where p.pronamespace = 'osp_public'::regnamespace and p.proname like 'private_page%'
        order by p.proname`.execute(owner)
    ).rows;
    expect(fns.map((f) => f.name)).toEqual([
      'private_page',
      'private_page_corrections',
      'private_page_history',
      'private_page_incidents',
      'private_page_maintenances',
      'private_page_retroactive_maintenances',
      'private_page_services',
    ]);
    for (const f of fns) {
      expect(f.definer, f.name).toBe(true);
      expect(f.config?.some((c) => c.startsWith('search_path=')), f.name).toBe(true);
      expect(f.public_exec, f.name).toBe(false);
      expect(f.role_exec, f.name).toBe(true);
    }
  });

  it('return nothing for a wrong, malformed, disabled or expired token', async () => {
    for (const token of [newPrivatePageToken(), tokens.a.toUpperCase(), '', 'x'.repeat(300), tokens.disabled, tokens.expired]) {
      expect(await rows('select * from osp_public.private_page($1)', token), token).toEqual([]);
      expect(await rows('select * from osp_public.private_page_services($1)', token), token).toEqual([]);
      expect(await rows('select * from osp_public.private_page_history($1, $2, null)', token, DAY_AGO), token).toEqual([]);
      expect(await rows('select * from osp_public.private_page_incidents($1, $2)', token, DAY_AGO), token).toEqual([]);
      expect(await rows('select * from osp_public.private_page_maintenances($1, $2)', token, DAY_AGO), token).toEqual([]);
    }
  });

  it('return exactly the page’s services for the right token, hidden ones included', async () => {
    expect(await rows('select id, name from osp_public.private_page($1)', tokens.a)).toEqual([{ id: ids.pageA, name: 'Page A' }]);
    const services = await rows<{ id: string; display_order: number }>('select id, display_order from osp_public.private_page_services($1)', tokens.a);
    expect(services).toEqual([
      { id: ids.hidden, display_order: 0 },
      { id: ids.service, display_order: 1 },
    ]);
    const history = await rows<{ service_id: string }>('select service_id from osp_public.private_page_history($1, $2, null)', tokens.a, DAY_AGO);
    expect(new Set(history.map((h) => h.service_id))).toEqual(new Set([ids.hidden, ids.service]));
  });

  it('never return hidden services of other pages', async () => {
    const all = JSON.stringify([
      await rows('select * from osp_public.private_page_services($1)', tokens.a),
      await rows('select * from osp_public.private_page_history($1, $2, null)', tokens.a, DAY_AGO),
      await rows('select * from osp_public.private_page_corrections($1, $2, $3)', tokens.a, DAY_AGO, NOW),
      await rows('select * from osp_public.private_page_incidents($1, $2)', tokens.a, DAY_AGO),
      await rows('select * from osp_public.private_page_maintenances($1, $2)', tokens.a, DAY_AGO),
    ]);
    expect(all).not.toContain(ids.otherHidden);
    expect(all).not.toContain('Other secret');
    expect(all).not.toContain('Other outage');
    // Only public incidents, only their public text.
    expect(all).not.toContain('Internal only');
    expect(all).not.toContain('INTERNAL NOTE');
    const incidents = await rows<{ id: string; services: { id: string }[] }>('select id, services from osp_public.private_page_incidents($1, $2)', tokens.a, DAY_AGO);
    expect(incidents).toEqual([{ id: 'inc-a', services: [{ id: ids.hidden, name: 'Partner backend', status: 'major_outage' }] }]);

    const b = await rows<{ id: string }>('select id from osp_public.private_page_services($1)', tokens.b);
    expect(b.map((s) => s.id)).toEqual([ids.otherHidden]);
  });
});

describe('a public instance', () => {
  it('serves the private page API and page through the functions', async () => {
    const web = createWebDir();
    const app = await buildApp({ config: { ...pgdb.config('public'), WEB_DIST_DIR: web.dir }, db: pub, ssrModule: renderFromSource });
    try {
      await app.ready();
      const api = await app.inject({ url: '/api/public/private-page', headers: { [PRIVATE_PAGE_TOKEN_HEADER]: tokens.a } });
      expect(api.statusCode).toBe(200);
      const included = (api.json().included as { type: string; id: string }[]).filter((r) => r.type === 'services').map((r) => r.id);
      expect(included).toEqual([ids.hidden, ids.service]);
      expect(api.body).not.toContain(ids.otherHidden);

      const day = await app.inject({
        url: `/api/public/private-page/services/${ids.hidden}/days/${NOW.slice(0, 10)}`,
        headers: { [PRIVATE_PAGE_TOKEN_HEADER]: tokens.a },
      });
      expect(day.statusCode).toBe(200);
      expect(day.json().data.attributes.status).toBe('major_outage');

      // An incident of the page with only its own services, also with the token in upper case.
      const incident = await app.inject({ url: '/api/public/private-page/incidents/inc-a', headers: { [PRIVATE_PAGE_TOKEN_HEADER]: tokens.a.toUpperCase() } });
      expect(incident.statusCode).toBe(200);
      expect(incident.body).not.toContain(ids.otherHidden);
      expect(incident.json().data.attributes.title).toBe('Backend outage');
      for (const id of ['inc-b', 'inc-internal']) {
        expect((await app.inject({ url: `/api/public/private-page/incidents/${id}`, headers: { [PRIVATE_PAGE_TOKEN_HEADER]: tokens.a } })).statusCode, id).toBe(404);
      }
      const incidentPage = await app.inject({ url: `/p/${tokens.a}/incidents/inc-a` });
      expect(incidentPage.statusCode).toBe(200);
      expect(rootOf(incidentPage)).toContain('Backend outage');
      expect(rootOf(incidentPage)).not.toContain('Other secret');

      for (const token of [tokens.disabled, tokens.expired, newPrivatePageToken()]) {
        expect((await app.inject({ url: '/api/public/private-page', headers: { [PRIVATE_PAGE_TOKEN_HEADER]: token } })).statusCode).toBe(404);
      }

      const page = await app.inject({ url: `/p/${tokens.a}` });
      expect(page.statusCode).toBe(200);
      expect(rootOf(page)).toContain('Partner backend');
      expect(rootOf(page)).not.toContain('Other secret');
      expect(page.headers['cache-control']).toBe('private, no-store');
      // The main page of the same instance still does not show it.
      expect(rootOf(await app.inject({ url: '/services' }))).not.toContain('Partner backend');
    } finally {
      await app.close();
      web.remove();
    }
  });
});
