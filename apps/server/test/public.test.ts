import { deserializeDocument, resourceType, type DataDocument } from '@openstatuspage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { adminClient, createTestApp, data, doc, errors, page, seedChecks, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Client;
let ids: {
  group: string;
  hiddenGroup: string;
  api: string;
  web: string;
  hidden: string;
  inHiddenGroup: string;
  fra: string;
  hiddenLocation: string;
  sourceId: string;
  checkIds: string[];
  incident: string;
  privateIncident: string;
  maintenance: string;
};

/** Strings that must never appear in any public response. */
const SECRETS = [
  'db-primary.internal.example.com',
  'web-07.internal.example.com',
  'PRIVATE_CHECK_NAME',
  'disk!/var/lib/postgresql',
  'CRITICAL - connection refused on 192.0.2.12',
  'Internal monitoring',
  'Hidden backend',
  'Hidden group',
  'Hidden location',
  'Private incident',
];

const get = (url: string) => t.app.inject({ method: 'GET', url });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const getData = async (url: string): Promise<Any> => data<Any>(await get(url));
const getPage = async (url: string) => page<Any>(await get(url));

beforeEach(async () => {
  t = await createTestApp();
  admin = await adminClient(t);

  const { sourceId, checkIds } = await seedChecks(t, [
    { externalId: 'db!pg', name: 'PRIVATE_CHECK_NAME', host: 'db-primary.internal.example.com', state: 'critical' },
    { externalId: 'disk!/var/lib/postgresql', name: 'Disk', host: 'web-07.internal.example.com', state: 'warning' },
  ]);
  await t.db
    .updateTable('monitor_checks')
    .set({ output: 'CRITICAL - connection refused on 192.0.2.12' })
    .execute();

  const group = (await admin.post('/api/admin/service-groups', { name: 'Platform' })).json().data.id;
  const hiddenGroup = (await admin.post('/api/admin/service-groups', { name: 'Hidden group', isPublic: false })).json().data.id;
  const fra = (await admin.post('/api/admin/locations', { name: 'Frankfurt', code: 'FRA-1', region: 'europe' })).json().data.id;
  const hiddenLocation = (await admin.post('/api/admin/locations', { name: 'Hidden location', region: 'europe', isPublic: false }))
    .json().data.id;

  const api = (
    await admin.post('/api/admin/services', {
      name: 'Public API',
      groupId: group,
      locationIds: [fra, hiddenLocation],
      checks: [{ checkId: checkIds['db!pg'] }],
    })
  ).json().data.id;
  const web = (
    await admin.post('/api/admin/services', {
      name: 'Website',
      kind: 'site',
      url: 'https://www.example.com',
      checks: [{ checkId: checkIds['disk!/var/lib/postgresql'] }],
    })
  ).json().data.id;
  const hidden = (
    await admin.post('/api/admin/services', {
      name: 'Hidden backend',
      isPublic: false,
      locationIds: [fra],
      checks: [{ checkId: checkIds['db!pg'] }],
    })
  ).json().data.id;
  const inHiddenGroup = (await admin.post('/api/admin/services', { name: 'Billing', groupId: hiddenGroup })).json().data.id;

  const incident = (
    await admin.post('/api/admin/incidents', {
      title: 'Database outage',
      message: 'We are investigating.',
      affectedServices: [
        { serviceId: api, status: 'major_outage' },
        { serviceId: hidden, status: 'major_outage' },
      ],
      locationIds: [fra, hiddenLocation],
    })
  ).json().data.id;
  const privateIncident = (
    await admin.post('/api/admin/incidents', { title: 'Private incident', message: 'internal', isPublic: false })
  ).json().data.id;
  const maintenance = (
    await admin.post('/api/admin/maintenances', {
      title: 'Network upgrade',
      scheduledStart: new Date(Date.now() + 86400_000).toISOString(),
      scheduledEnd: new Date(Date.now() + 90000_000).toISOString(),
      serviceIds: [web, hidden],
    })
  ).json().data.id;

  ids = {
    group,
    hiddenGroup,
    api,
    web,
    hidden,
    inHiddenGroup,
    fra,
    hiddenLocation,
    sourceId,
    checkIds: Object.values(checkIds),
    incident,
    privateIncident,
    maintenance,
  };
});
afterEach(async () => {
  await t.close();
});

function assertNoLeak(body: string) {
  for (const s of SECRETS) expect(body, `leaked "${s}"`).not.toContain(s);
  for (const id of [ids.sourceId, ...ids.checkIds, ids.hidden, ids.hiddenGroup, ids.hiddenLocation, ids.privateIncident]) {
    expect(body, `leaked id ${id}`).not.toContain(id);
  }
  for (const key of ['"checks"', '"host"', '"checkId"', '"sourceId"', '"output"', '"monitorStatus"', '"checkCount"']) {
    expect(body, `leaked key ${key}`).not.toContain(key);
  }
}

describe('public API privacy', () => {
  it('never exposes monitoring data or hidden entities', async () => {
    const urls = [
      '/api/public/summary',
      '/api/public/settings',
      '/api/public/services',
      `/api/public/services/${ids.api}`,
      '/api/public/services/website',
      '/api/public/locations',
      `/api/public/incidents/${ids.incident}`,
      `/api/public/maintenances/${ids.maintenance}`,
      '/api/public/history',
      `/api/public/history?filter[service]=${ids.api}`,
      `/api/public/history?filter[location]=${ids.fra}`,
      '/api/public/status',
      '/feed.rss',
      '/feed.atom',
    ];
    for (const url of urls) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('public, max-age=30');
      assertNoLeak(res.body);
    }
  });

  it('returns 404 for hidden entities', async () => {
    expect((await get(`/api/public/services/${ids.hidden}`)).statusCode).toBe(404);
    expect((await get(`/api/public/incidents/${ids.privateIncident}`)).statusCode).toBe(404);
    expect((await get('/api/public/incidents/does-not-exist')).statusCode).toBe(404);
    // Filtering by hidden entities yields nothing (does not reveal links).
    expect((await getPage(`/api/public/history?filter[service]=${ids.hidden}`)).total).toBe(0);
    expect((await getPage(`/api/public/history?filter[location]=${ids.hiddenLocation}`)).total).toBe(0);
    const missing = await get('/api/public/incidents/does-not-exist');
    expect(missing.headers['content-type']).toBe('application/vnd.api+json');
    expect(errors(missing)).toEqual([{ status: '404', code: 'not_found', title: 'Not Found', detail: 'Incident not found' }]);
  });
});

describe('public summary and services', () => {
  it('returns groups, statuses, incidents and maintenance', async () => {
    const res = await get('/api/public/summary');
    expect(res.headers['content-type']).toBe('application/vnd.api+json');
    expect(res.json()).toMatchObject({
      jsonapi: { version: '1.1' },
      data: { type: 'summaries', id: 'current' },
      links: { self: '/api/public/summary' },
    });
    const summary = data<Any>(res);
    expect(summary.overall).toBe('major_outage');
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]).toMatchObject({ id: ids.group, name: 'Platform', status: 'major_outage' });
    expect(summary.groups[0].services[0]).toMatchObject({
      id: ids.api,
      status: 'major_outage',
      locationIds: [ids.fra],
      uptimePercent: expect.any(Number),
    });
    expect(summary.groups[0].services[0].uptime).toHaveLength(90);
    // The service of the hidden group is listed as ungrouped, without revealing the group.
    expect(summary.ungrouped.map((s: { id: string; groupId: string | null }) => [s.id, s.groupId])).toEqual([
      [ids.inHiddenGroup, null],
      [ids.web, null],
    ]);
    expect(summary.activeIncidents).toHaveLength(1);
    expect(summary.activeIncidents[0].affectedServices).toEqual([
      { id: ids.api, name: 'Public API', status: 'major_outage' },
    ]);
    expect(summary.activeIncidents[0].locationIds).toEqual([ids.fra]);
    expect(summary.upcomingMaintenances).toHaveLength(1);
    expect(summary.upcomingMaintenances[0].affectedServices).toEqual([{ id: ids.web, name: 'Website' }]);
    expect(summary.page.siteName).toBe('Status');
  });

  it('lists services with counts and details', async () => {
    const doc = (await get('/api/public/services')).json() as DataDocument;
    expect(doc.meta).toEqual({
      total: 3,
      counts: { operational: 1, maintenance: 0, degraded: 1, partial_outage: 0, major_outage: 1 },
    });
    const { data: services, included } = deserializeDocument<Any[]>(doc);
    // Display order: grouped services first, then ungrouped ones.
    expect(services.map((s: Any) => s.id)).toEqual([ids.api, ids.inHiddenGroup, ids.web]);
    expect(services[0]).toMatchObject({ groupId: ids.group, locationIds: [ids.fra] });
    expect(included.map((g) => [resourceType(g), g.id, g.serviceIds])).toEqual([['service-groups', ids.group, [ids.api]]]);
    // Full linkage: a public group without public services is not part of `included`.
    expect((await admin.post('/api/admin/service-groups', { name: 'Empty', isPublic: true })).statusCode).toBe(201);
    const withEmpty = deserializeDocument<Any[]>((await get('/api/public/services')).json() as DataDocument);
    expect(withEmpty.included.map((g) => g.id)).toEqual([ids.group]);

    const detailRes = await get('/api/public/services/public-api');
    expect(detailRes.json().data.links).toEqual({ self: '/api/public/services/public-api' });
    const detail = data<Any>(detailRes);
    expect(detail).toMatchObject({ id: ids.api, groupId: ids.group, status: 'major_outage' });
    expect(detail.uptime).toHaveLength(90);
    expect(detail.incidents.map((i: { id: string }) => i.id)).toEqual([ids.incident]);
    expect(detail.incidents[0].updates).toEqual([
      expect.objectContaining({ status: 'investigating', message: 'We are investigating.' }),
    ]);
    expect(detail.maintenances).toEqual([]);

    const site = await getData('/api/public/services/website');
    expect(site.maintenances.map((m: { id: string }) => m.id)).toEqual([ids.maintenance]);

    // include limits the compound document; unsupported paths are rejected.
    const lean = (await get('/api/public/services/public-api?include=incidents')).json() as DataDocument;
    expect(lean.included?.map((r) => r.type)).toEqual(['incidents']);
    const bad = await get('/api/public/services/public-api?include=checks');
    expect(bad.statusCode).toBe(400);
    expect(errors(bad)[0]).toMatchObject({ code: 'unsupported_include', source: { parameter: 'include' } });
  });

  it('respects showUptime and uptimeDays', async () => {
    await admin.patch('/api/admin/settings', { siteName: 'Status', showUptime: false });
    const off = await getData('/api/public/services');
    expect(off[0].uptime).toBeUndefined();
    expect(off[0].uptimePercent).toBeNull();

    await admin.patch('/api/admin/settings', { showUptime: true, uptimeDays: 30 });
    const on = await getData('/api/public/services');
    expect(on[0].uptime).toHaveLength(30);
  });
});

describe('public locations', () => {
  it('derive status from public services only', async () => {
    const res = (await get('/api/public/locations')).json() as DataDocument;
    const locations = deserializeDocument<Any[]>(res).data;
    expect(locations).toHaveLength(1);
    // Hidden backend (major outage) is at FRA too but must not count; Public API is major_outage itself.
    expect(locations[0]).toMatchObject({ id: ids.fra, code: 'FRA-1', status: 'major_outage', serviceIds: [ids.api] });
    expect((res.meta?.counts as Any).major_outage).toBe(1);

    // Resolve the incident; the api's check is still critical, so move it to manual operational.
    await admin.post(`/api/admin/incidents/${ids.incident}/updates`, doc('incident-updates', { status: 'resolved', message: 'ok' }));
    await admin.patch(`/api/admin/services/${ids.api}`, { statusMode: 'manual', checks: [] });
    const after = await getData('/api/public/locations');
    // The hidden service is still in major outage, but the public location stays operational.
    expect(after[0].status).toBe('operational');

    await admin.patch(`/api/admin/locations/${ids.fra}`, { statusOverride: 'degraded' });
    expect((await getData('/api/public/locations'))[0].status).toBe('degraded');
  });
});

describe('public history', () => {
  it('paginates incidents and past maintenance, newest first', async () => {
    // Past completed maintenance.
    const past = (
      await admin.post('/api/admin/maintenances', {
        title: 'Past work',
        scheduledStart: '2026-01-10T10:00:00.000Z',
        scheduledEnd: '2026-01-10T12:00:00.000Z',
      })
    ).json().data;
    expect(past.attributes.status).toBe('completed');
    await admin.post('/api/admin/incidents', {
      title: 'January incident',
      message: 'x',
      status: 'resolved',
      startedAt: '2026-01-15T08:00:00.000Z',
    });

    const all = await getPage('/api/public/history');
    // Upcoming maintenance is excluded; private incident too.
    expect(all.total).toBe(3);
    expect(all.items.map((i) => resourceType(i))).toEqual(['incidents', 'incidents', 'maintenances']);
    expect(all.items[0].id).toBe(ids.incident);
    expect(all.items[0].updates).toHaveLength(1);

    const january = await getPage('/api/public/history?filter[month]=2026-01');
    expect(january.items.map((i) => i.startedAt ?? i.scheduledStart)).toEqual([
      '2026-01-15T08:00:00.000Z',
      '2026-01-10T10:00:00.000Z',
    ]);
    const maint = await getPage('/api/public/history?filter[type]=maintenance');
    expect(maint.items).toEqual([expect.objectContaining({ id: past.id, title: 'Past work' })]);

    const pagedRes = await get('/api/public/history?page[number]=2&page[size]=2');
    const paged = page(pagedRes);
    expect(paged).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(paged.items).toHaveLength(1);
    expect(pagedRes.json().links).toEqual({
      self: '/api/public/history?page[number]=2&page[size]=2',
      first: '/api/public/history?page[number]=1&page[size]=2',
      prev: '/api/public/history?page[number]=1&page[size]=2',
      next: null,
      last: '/api/public/history?page[number]=2&page[size]=2',
    });

    // Without updates in the compound document.
    expect((await get('/api/public/history?include=')).json()).not.toHaveProperty('included');

    expect((await getPage(`/api/public/history?filter[service]=${ids.api}`)).total).toBe(1);
    expect((await getPage(`/api/public/history?filter[location]=${ids.fra}`)).total).toBe(1);
    const badMonth = await get('/api/public/history?filter[month]=2026-13-01');
    expect(badMonth.statusCode).toBe(400);
    expect(errors(badMonth)[0]).toMatchObject({ status: '400', source: { parameter: 'filter[month]' } });
    expect((await get('/api/public/history?filter[secret]=1')).statusCode).toBe(400);
    expect((await get('/api/public/history?page[size]=1000')).statusCode).toBe(400);
  });
});

describe('public status', () => {
  it('returns the status as a JSON:API singleton with relationships', async () => {
    const res = await get('/api/public/status');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    const body = res.json();
    expect(body.jsonapi).toEqual({ version: '1.1' });
    expect(body.links).toEqual({ self: '/api/public/status' });
    expect(body.data).toMatchObject({
      type: 'statuses',
      id: 'current',
      attributes: { overall: 'major_outage' },
      links: { self: '/api/public/status' },
    });
    expect(body.data.attributes.updatedAt).toEqual(expect.any(String));
    // Display order: grouped services first, then ungrouped ones.
    expect(body.data.relationships.services.data).toEqual([
      { type: 'services', id: ids.api },
      { type: 'services', id: ids.inHiddenGroup },
      { type: 'services', id: ids.web },
    ]);
    expect(body.data.relationships.activeIncidents.data).toEqual([{ type: 'incidents', id: ids.incident }]);
    expect(body.data.relationships.activeMaintenances.data).toEqual([]);
    const included = body.included as { type: string; id: string; attributes?: Record<string, unknown> }[];
    expect(included.find((r) => r.type === 'service-groups' && r.id === ids.group)?.attributes).toMatchObject({ name: 'Platform' });
    expect(included.find((r) => r.type === 'services' && r.id === ids.api)?.attributes).toMatchObject({
      name: 'Public API',
      status: 'major_outage',
    });
    expect(included.find((r) => r.type === 'incidents' && r.id === ids.incident)?.attributes).toMatchObject({
      title: 'Database outage',
      status: 'investigating',
    });
  });
});

describe('feeds', () => {
  it('renders RSS and Atom with escaped content', async () => {
    await admin.post('/api/admin/incidents', { title: 'Errors <script>alert("x")</script> & more', message: 'a < b' });
    await admin.patch('/api/admin/settings', { siteName: 'Example & Co' });

    const rss = await get('/feed.rss');
    expect(rss.headers['content-type']).toContain('application/rss+xml');
    expect(rss.body).toContain('<rss version="2.0"');
    expect(rss.body).toContain('<title>Example &amp; Co</title>');
    expect(rss.body).toContain('Errors &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more');
    expect(rss.body).not.toContain('<script>');
    expect(rss.body).toContain(`<link>https://status.example.com/incidents/${ids.incident}</link>`);
    expect(rss.body).toContain(`https://status.example.com/maintenance/${ids.maintenance}`);
    expect(rss.body.match(/<item>/g)).toHaveLength(3);

    const atom = await get('/feed.atom');
    expect(atom.headers['content-type']).toContain('application/atom+xml');
    expect(atom.body).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(atom.body.match(/<entry>/g)).toHaveLength(3);
    expect(atom.body).not.toContain('<script>');
  });

  it('caps feeds at 50 items', async () => {
    const now = new Date().toISOString();
    await t.db
      .insertInto('incidents')
      .values(
        Array.from({ length: 60 }, (_, i) => ({
          id: newId(),
          title: `Bulk ${i}`,
          status: 'resolved' as const,
          impact: 'minor' as const,
          is_public: 1,
          source: 'manual' as const,
          started_at: now,
          resolved_at: now,
          created_by: null,
          created_at: now,
          updated_at: now,
        })),
      )
      .execute();
    const rss = await get('/feed.rss');
    expect(rss.body.match(/<item>/g)).toHaveLength(50);
  });
});
