// @vitest-environment jsdom
/**
 * robots.txt, the sitemaps and llms.txt (routes/discovery.ts): per role, valid
 * XML (parsed with the DOM's XML parser), absolute URLs and public data only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { renderLlmsFull, renderUrlset, sitemapPages } from '../src/routes/discovery.js';
import { SITEMAP_PAGE_SIZE } from '../src/services/site-index.js';
import { adminClient, BASE_URL, createTestApp, type TestApp } from './helpers.js';

let t: TestApp;
let ids: { apiSlug: string; incident: string; maintenance: string; hiddenIncident: string; hiddenService: string };

async function seed(app: TestApp) {
  const admin = await adminClient(app);
  await admin.patch('/api/admin/settings', { siteName: 'Example & Co', description: 'Status of <Example> services.', emailSubscriptionsEnabled: true });
  const hiddenGroup = (await admin.post('/api/admin/service-groups', { name: 'Internal', isPublic: false })).json().data.id;
  const api = (await admin.post('/api/admin/services', { name: 'Public API' })).json().data.id;
  await admin.post('/api/admin/services', { name: 'Grouped but public', groupId: hiddenGroup });
  const hiddenService = (await admin.post('/api/admin/services', { name: 'Hidden backend', isPublic: false })).json().data.id;
  const incident = (
    await admin.post('/api/admin/incidents', {
      title: 'Database [latency]\n## injected',
      message: 'We are investigating.\n## not a heading',
      affectedServices: [{ serviceId: api, status: 'degraded' }],
    })
  ).json().data.id;
  const hiddenIncident = (await admin.post('/api/admin/incidents', { title: 'Private incident', message: 'internal', isPublic: false })).json()
    .data.id;
  const maintenance = (
    await admin.post('/api/admin/maintenances', {
      title: 'Network upgrade',
      scheduledStart: new Date(Date.now() + 86400_000).toISOString(),
      scheduledEnd: new Date(Date.now() + 90000_000).toISOString(),
      serviceIds: [api],
    })
  ).json().data.id;
  await admin.post('/api/admin/maintenances', {
    title: 'Secret maintenance',
    scheduledStart: new Date(Date.now() + 86400_000).toISOString(),
    scheduledEnd: new Date(Date.now() + 90000_000).toISOString(),
    isPublic: false,
  });
  const apiSlug = (await app.app.inject({ method: 'GET', url: `/api/public/services/${api}` })).json().data.attributes.slug as string;
  return { apiSlug, incident, maintenance, hiddenIncident, hiddenService };
}

/** An instance of another role on the database of the test app. */
async function roleApp(role: 'public' | 'admin', other: TestApp) {
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      DATABASE_URL: 'sqlite::memory:',
      SECRET_KEY: 'test-secret-key-that-is-long-enough-1234567890',
      BASE_URL,
      APP_ROLE: role,
    },
    { allowSqliteForAnyRole: true },
  );
  const app = await buildApp({ config, db: other.db, serveWeb: false, mailer: new MemoryMailer() });
  await app.ready();
  return app;
}

// The DOM of the jsdom environment (the server's typecheck has no DOM types).
interface XmlElement {
  localName: string;
  namespaceURI: string | null;
  textContent: string | null;
}
interface XmlDocument {
  documentElement: XmlElement;
  getElementsByTagName(name: string): ArrayLike<XmlElement> & Iterable<XmlElement>;
}
declare const DOMParser: { new (): { parseFromString(source: string, type: string): XmlDocument } };

function parseXml(body: string): XmlDocument {
  const xml = new DOMParser().parseFromString(body, 'application/xml');
  expect(xml.getElementsByTagName('parsererror')).toHaveLength(0);
  return xml;
}

const locs = (xml: XmlDocument) => [...xml.getElementsByTagName('loc')].map((el) => el.textContent ?? '');

describe.each(['all', 'public'] as const)('discovery files (APP_ROLE=%s)', (role) => {
  let app: TestApp['app'];
  beforeEach(async () => {
    t = await createTestApp({}, { mailer: new MemoryMailer() });
    ids = await seed(t);
    app = role === 'all' ? t.app : await roleApp('public', t);
  });
  afterEach(async () => {
    if (app !== t.app) await app.close();
    await t.close();
  });

  const get = (url: string) => app.inject({ method: 'GET', url });

  it('robots.txt allows the public pages and points to the sitemap', async () => {
    const res = await get('/robots.txt');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    const lines = res.body.split('\n');
    expect(lines).toEqual(expect.arrayContaining(['User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /admin', 'Disallow: /subscription/', 'Disallow: /preferences/', 'Disallow: /pulse/']));
    expect(lines).toContain(`Sitemap: ${BASE_URL}/sitemap.xml`);
    expect(lines).not.toContain('Disallow: /');
    // llms.txt points agents to the public API: allowed, except the subscription endpoints.
    expect(lines).toEqual(expect.arrayContaining(['Allow: /api/public/', 'Disallow: /api/public/subscriptions']));
    // Only comments, fields and blank lines.
    expect(lines.every((l) => l === '' || l.startsWith('#') || /^(User-agent|Allow|Disallow|Sitemap): \S+$/.test(l))).toBe(true);
  });

  it('serves a sitemap index of valid sub-sitemaps', async () => {
    const res = await get('/sitemap.xml');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=900');
    const index = parseXml(res.body);
    expect(index.documentElement.localName).toBe('sitemapindex');
    expect(index.documentElement.namespaceURI).toBe('http://www.sitemaps.org/schemas/sitemap/0.9');
    expect(locs(index)).toEqual([`${BASE_URL}/sitemap-pages.xml`, `${BASE_URL}/sitemap-incidents-1.xml`, `${BASE_URL}/sitemap-services-1.xml`]);

    const urls: string[] = [];
    for (const loc of locs(index)) {
      const sub = await get(loc.slice(BASE_URL.length));
      expect(sub.statusCode, loc).toBe(200);
      const xml = parseXml(sub.body);
      expect(xml.documentElement.localName).toBe('urlset');
      urls.push(...locs(xml));
    }
    expect(urls).toEqual(
      expect.arrayContaining([
        `${BASE_URL}/`,
        `${BASE_URL}/services`,
        `${BASE_URL}/history`,
        `${BASE_URL}/locations`,
        `${BASE_URL}/subscribe`,
        `${BASE_URL}/incidents/${ids.incident}`,
        `${BASE_URL}/maintenance/${ids.maintenance}`,
        `${BASE_URL}/services/${ids.apiSlug}`,
      ]),
    );
    // Two public incidents/maintenance windows, two public services, five pages.
    expect(urls).toHaveLength(5 + 2 + 2);
    const all = urls.join('\n');
    expect(all).not.toContain(ids.hiddenIncident);
    expect(all).not.toContain(ids.hiddenService);
    expect(all).not.toMatch(/subscription|\/api\/|\/admin/);
    // Day pages (/services/<slug>/days/<date>) are thin and noindex: never in a sitemap.
    expect(all).not.toContain('/days/');
  });

  it('gives incidents and services a lastmod', async () => {
    const xml = parseXml((await get('/sitemap-incidents-1.xml')).body);
    const lastmods = [...xml.getElementsByTagName('lastmod')].map((el) => el.textContent ?? '');
    expect(lastmods).toHaveLength(2);
    for (const value of lastmods) expect(new Date(value).toISOString()).toBe(value);
    expect(parseXml((await get('/sitemap-services-1.xml')).body).getElementsByTagName('lastmod')).toHaveLength(2);
  });

  it('answers 404 for sitemap pages that do not exist', async () => {
    for (const url of ['/sitemap-incidents-2.xml', '/sitemap-incidents-0.xml', '/sitemap-services-x.xml']) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
  });

  it('llms.txt follows the llmstxt.org structure', async () => {
    const res = await get('/llms.txt');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    const lines = res.body.split('\n');
    expect(lines[0]).toBe('# Example & Co');
    expect(lines[2]).toBe('> Status of <Example> services.');
    const sections = lines.filter((l) => l.startsWith('## '));
    expect(sections).toEqual(['## Pages', '## API', '## Feeds', '## Optional']);
    // Every list entry is a Markdown link to an absolute URL.
    const items = lines.filter((l) => l.startsWith('- '));
    expect(items.length).toBeGreaterThan(8);
    for (const item of items) expect(item).toMatch(new RegExp(`^- \\[[^\\]]+\\]\\(${BASE_URL.replace(/\./g, '\\.')}/[^)]*\\)`));
    expect(res.body).toContain(`(${BASE_URL}/api/public/status)`);
    expect(res.body).toContain(`(${BASE_URL}/feed.rss)`);
    expect(res.body).toContain(`(${BASE_URL}/llms-full.txt)`);
    expect(res.body).toContain('with 2 public services');
    // The API description is published by default.
    expect(res.body).toContain(`- [API description](${BASE_URL}/api/openapi.json): `);
  });

  it('llms.txt leaves the API description out when the page does not publish it', async () => {
    await (await adminClient(t, 'settings@example.com')).patch('/api/admin/settings', { publicApiDescription: false });
    const res = await get('/llms.txt');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('/api/openapi.json');
    expect(res.body).toContain(`(${BASE_URL}/api/public/status)`);
  });

  it('llms-full.txt has the current status and public data only', async () => {
    const res = await get('/llms-full.txt');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    const body = res.body;
    expect(body.startsWith('# Example & Co: current status\n')).toBe(true);
    expect(body).toContain('> Overall status: Degraded performance.');
    // Admin text cannot add headings or break links.
    expect(body).toContain(`### [Database \\[latency\\] ## injected](${BASE_URL}/incidents/${ids.incident})`);
    expect(body).toContain('> ## not a heading');
    expect(body.split('\n').filter((l) => l.startsWith('## '))).toEqual([
      '## Active incidents',
      '## Maintenance in progress',
      '## Upcoming maintenance',
      '## Services',
      '## More',
    ]);
    expect(body).toContain(`[Network upgrade](${BASE_URL}/maintenance/${ids.maintenance})`);
    expect(body).toContain(`[Public API](${BASE_URL}/services/${ids.apiSlug}): Degraded performance`);
    expect(body).toContain('Grouped but public');
    for (const hidden of ['Hidden backend', 'Private incident', 'Secret maintenance', 'Internal']) expect(body).not.toContain(hidden);
  });
});

describe('discovery files of a management instance (APP_ROLE=admin)', () => {
  let app: TestApp['app'];
  beforeEach(async () => {
    t = await createTestApp();
    app = await roleApp('admin', t);
  });
  afterEach(async () => {
    await app.close();
    await t.close();
  });

  it('robots.txt disallows everything; no sitemap or llms.txt', async () => {
    const res = await app.inject({ method: 'GET', url: '/robots.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.body.split('\n')).toEqual(expect.arrayContaining(['User-agent: *', 'Disallow: /']));
    expect(res.body).not.toContain('Sitemap:');
    for (const url of ['/sitemap.xml', '/sitemap-pages.xml', '/llms.txt', '/llms-full.txt']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });
});

describe('discovery files of a worker', () => {
  it('serve nothing', async () => {
    t = await createTestApp({ APP_ROLE: 'worker' });
    expect((await t.app.inject({ method: 'GET', url: '/robots.txt' })).statusCode).toBe(404);
    await t.close();
  });
});

describe('sitemap rendering', () => {
  it('escapes URLs and splits beyond the page size', () => {
    const xml = parseXml(renderUrlset('https://s.example.com', [{ path: "/a?x=1&y='<>'", lastmod: '2026-01-01T00:00:00.000Z' }]));
    expect(locs(xml)).toEqual(["https://s.example.com/a?x=1&y='<>'"]);
    expect(sitemapPages(0)).toBe(0);
    expect(sitemapPages(SITEMAP_PAGE_SIZE)).toBe(1);
    expect(sitemapPages(SITEMAP_PAGE_SIZE + 1)).toBe(2);
    expect(SITEMAP_PAGE_SIZE).toBeLessThanOrEqual(50_000);
  });

  it('renders an empty status page', () => {
    const body = renderLlmsFull('https://s.example.com', {
      settings: { siteName: 'S', showUptime: true } as never,
      catalog: { services: [], groups: [], ungrouped: [], counts: {} as never },
      activeIncidents: [],
      activeMaintenances: [],
      upcomingMaintenances: [],
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(body).toContain('Overall status: No public services.');
    expect(body).toContain('No active incidents.');
  });
});
