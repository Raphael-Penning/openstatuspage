import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { adminClient, createTestApp, seedChecks, type Client, type TestApp } from './helpers.js';

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
  'CRITICAL - connection refused on 10.0.0.12',
  'Internal monitoring',
  'Hidden backend',
  'Hidden group',
  'Hidden location',
  'Private incident',
];

const get = (url: string) => t.app.inject({ method: 'GET', url });

beforeEach(async () => {
  t = await createTestApp();
  admin = await adminClient(t);

  const { sourceId, checkIds } = await seedChecks(t, [
    { externalId: 'db!pg', name: 'PRIVATE_CHECK_NAME', host: 'db-primary.internal.example.com', state: 'critical' },
    { externalId: 'disk!/var/lib/postgresql', name: 'Disk', host: 'web-07.internal.example.com', state: 'warning' },
  ]);
  await t.db
    .updateTable('monitor_checks')
    .set({ output: 'CRITICAL - connection refused on 10.0.0.12' })
    .execute();

  const group = (await admin.post('/api/admin/service-groups', { name: 'Platform' })).json().id;
  const hiddenGroup = (await admin.post('/api/admin/service-groups', { name: 'Hidden group', isPublic: false })).json().id;
  const fra = (await admin.post('/api/admin/locations', { name: 'Frankfurt', code: 'FRA-1', region: 'europe' })).json().id;
  const hiddenLocation = (await admin.post('/api/admin/locations', { name: 'Hidden location', region: 'europe', isPublic: false }))
    .json().id;

  const api = (
    await admin.post('/api/admin/services', {
      name: 'Public API',
      groupId: group,
      locationIds: [fra, hiddenLocation],
      checks: [{ checkId: checkIds['db!pg'] }],
    })
  ).json().id;
  const web = (
    await admin.post('/api/admin/services', {
      name: 'Website',
      kind: 'site',
      url: 'https://www.example.com',
      checks: [{ checkId: checkIds['disk!/var/lib/postgresql'] }],
    })
  ).json().id;
  const hidden = (
    await admin.post('/api/admin/services', {
      name: 'Hidden backend',
      isPublic: false,
      locationIds: [fra],
      checks: [{ checkId: checkIds['db!pg'] }],
    })
  ).json().id;
  const inHiddenGroup = (await admin.post('/api/admin/services', { name: 'Billing', groupId: hiddenGroup })).json().id;

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
  ).json().id;
  const privateIncident = (
    await admin.post('/api/admin/incidents', { title: 'Private incident', message: 'internal', isPublic: false })
  ).json().id;
  const maintenance = (
    await admin.post('/api/admin/maintenances', {
      title: 'Network upgrade',
      scheduledStart: new Date(Date.now() + 86400_000).toISOString(),
      scheduledEnd: new Date(Date.now() + 90000_000).toISOString(),
      serviceIds: [web, hidden],
    })
  ).json().id;

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
      `/api/public/history?serviceId=${ids.api}`,
      `/api/public/history?locationId=${ids.fra}`,
      '/api/public/status.json',
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
    expect((await get(`/api/public/history?serviceId=${ids.hidden}`)).json().total).toBe(0);
    expect((await get(`/api/public/history?locationId=${ids.hiddenLocation}`)).json().total).toBe(0);
  });
});

describe('public summary and services', () => {
  it('returns groups, statuses, incidents and maintenance', async () => {
    const res = await get('/api/public/summary');
    const summary = res.json();
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
    const res = (await get('/api/public/services')).json();
    expect(res.counts).toEqual({ operational: 1, maintenance: 0, degraded: 1, partial_outage: 0, major_outage: 1 });

    const detail = (await get('/api/public/services/public-api')).json();
    expect(detail).toMatchObject({ id: ids.api, groupId: ids.group, status: 'major_outage' });
    expect(detail.uptime).toHaveLength(90);
    expect(detail.incidents.map((i: { id: string }) => i.id)).toEqual([ids.incident]);
    expect(detail.maintenances).toEqual([]);

    const site = (await get('/api/public/services/website')).json();
    expect(site.maintenances.map((m: { id: string }) => m.id)).toEqual([ids.maintenance]);
  });

  it('respects showUptime and uptimeDays', async () => {
    await admin.put('/api/admin/settings', { siteName: 'Status', showUptime: false });
    const off = (await get('/api/public/services')).json();
    expect(off.groups[0].services[0].uptime).toBeUndefined();
    expect(off.groups[0].services[0].uptimePercent).toBeNull();

    await admin.put('/api/admin/settings', { siteName: 'Status', uptimeDays: 30 });
    const on = (await get('/api/public/services')).json();
    expect(on.groups[0].services[0].uptime).toHaveLength(30);
  });
});

describe('public locations', () => {
  it('derive status from public services only', async () => {
    const res = (await get('/api/public/locations')).json();
    expect(res.locations).toHaveLength(1);
    // Hidden backend (major outage) is at FRA too but must not count; Public API is major_outage itself.
    expect(res.locations[0]).toMatchObject({ id: ids.fra, code: 'FRA-1', status: 'major_outage', serviceIds: [ids.api] });
    expect(res.counts.major_outage).toBe(1);

    // Resolve the incident; the api's check is still critical, so move it to manual operational.
    await admin.post(`/api/admin/incidents/${ids.incident}/updates`, { status: 'resolved', message: 'ok' });
    await admin.put(`/api/admin/services/${ids.api}`, { name: 'Public API', statusMode: 'manual', locationIds: [ids.fra] });
    const after = (await get('/api/public/locations')).json();
    // The hidden service is still in major outage, but the public location stays operational.
    expect(after.locations[0].status).toBe('operational');

    await admin.put(`/api/admin/locations/${ids.fra}`, { name: 'Frankfurt', region: 'europe', statusOverride: 'degraded' });
    expect((await get('/api/public/locations')).json().locations[0].status).toBe('degraded');
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
    ).json();
    expect(past.status).toBe('completed');
    await admin.post('/api/admin/incidents', {
      title: 'January incident',
      message: 'x',
      status: 'resolved',
      startedAt: '2026-01-15T08:00:00.000Z',
    });

    const all = (await get('/api/public/history')).json();
    // Upcoming maintenance is excluded; private incident too.
    expect(all.total).toBe(3);
    expect(all.items.map((i: { type: string }) => i.type)).toEqual(['incident', 'incident', 'maintenance']);
    expect(all.items[0].incident.id).toBe(ids.incident);

    const january = (await get('/api/public/history?month=2026-01')).json();
    expect(january.items.map((i: { date: string }) => i.date)).toEqual([
      '2026-01-15T08:00:00.000Z',
      '2026-01-10T10:00:00.000Z',
    ]);
    const maint = (await get('/api/public/history?type=maintenance')).json();
    expect(maint.items).toEqual([expect.objectContaining({ type: 'maintenance', maintenance: expect.objectContaining({ id: past.id }) })]);

    const paged = (await get('/api/public/history?page=2&pageSize=2')).json();
    expect(paged).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(paged.items).toHaveLength(1);

    expect((await get(`/api/public/history?serviceId=${ids.api}`)).json().total).toBe(1);
    expect((await get(`/api/public/history?locationId=${ids.fra}`)).json().total).toBe(1);
    expect((await get('/api/public/history?month=2026-13-01')).statusCode).toBe(400);
  });
});

describe('status.json and feeds', () => {
  it('returns compact status', async () => {
    const res = (await get('/api/public/status.json')).json();
    expect(res.overall).toBe('major_outage');
    // Display order: grouped services first, then ungrouped ones.
    expect(res.services).toEqual([
      { id: ids.api, name: 'Public API', group: 'Platform', status: 'major_outage' },
      { id: ids.inHiddenGroup, name: 'Billing', group: null, status: 'operational' },
      { id: ids.web, name: 'Website', group: null, status: 'degraded' },
    ]);
    expect(res.activeIncidents).toEqual([{ id: ids.incident, title: 'Database outage', status: 'investigating', impact: 'minor' }]);
    expect(res.activeMaintenances).toEqual([]);
  });

  it('renders RSS and Atom with escaped content', async () => {
    await admin.post('/api/admin/incidents', { title: 'Errors <script>alert("x")</script> & more', message: 'a < b' });
    await admin.put('/api/admin/settings', { siteName: 'Example & Co' });

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
