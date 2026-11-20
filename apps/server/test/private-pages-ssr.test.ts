/**
 * Server-rendered private pages (/p/<token>): only the page's services (hidden
 * ones too), complete without JavaScript, never indexed, cached, followed by
 * analytics or leaked through the referrer; wrong links are a plain 404 that
 * looks the same whatever the reason.
 */
import { request, type IncomingHttpHeaders } from 'node:http';
import { shiftUptimeDay, uptimeDayOf } from '@openstatuspage/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newPrivatePageToken } from '../src/services/private-pages.js';
import { adminClient, createTestApp, data, type Client, type TestApp } from './helpers.js';
import { createWebDir, elements, renderFromSource, rootOf } from './web-fixture.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let web: ReturnType<typeof createWebDir>;
beforeAll(() => {
  web = createWebDir();
});
afterAll(() => web.remove());

let t: TestApp;
let admin: Client;
let page: { id: string; token: string };
let ids: { hidden: string; hiddenSlug: string; other: string };

const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers });

/**
 * GET with the path exactly as given (like `curl --path-as-is`): inject() and
 * fetch() resolve dot segments before sending, a hand-made request does not.
 */
async function getAsIs(path: string): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: string }> {
  const address = t.app.server.listening ? null : await t.app.listen({ host: '127.0.0.1', port: 0 });
  const port = address ? Number(new URL(address).port) : (t.app.server.address() as { port: number }).port;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const today = () => uptimeDayOf(Date.now());

beforeEach(async () => {
  t = await createTestApp({ UMAMI_URL: 'http://umami.invalid' }, { web: { dir: web.dir, ssrModule: renderFromSource } });
  admin = await adminClient(t);
  await admin.patch('/api/admin/settings', {
    siteName: 'Example Status',
    uptimeDays: 7,
    analyticsEnabled: true,
    analyticsWebsiteId: '3f1c7c2e-8a7b-4c1e-9d55-0f6a1d2b3c4d',
  });
  await admin.post('/api/admin/services', { name: 'Public API' });
  const hidden = data<Any>(await admin.post('/api/admin/services', { name: 'Partner backend', isPublic: false }));
  const other = data<Any>(await admin.post('/api/admin/services', { name: 'Other secret', isPublic: false }));
  ids = { hidden: hidden.id, hiddenSlug: hidden.slug, other: other.id };
  const created = data<Any>(await admin.post('/api/admin/private-pages', { name: 'ACME status', description: 'For ACME', serviceIds: [ids.hidden] }));
  page = { id: created.id, token: created.token };
  await admin.post('/api/admin/private-pages', { name: 'Other page', serviceIds: [ids.other] });
});
afterEach(() => t.close());

describe('private page', () => {
  it('renders the page’s services, hidden ones too, with private headers and without analytics', async () => {
    const res = await get(`/p/${page.token}`);
    expect(res.statusCode).toBe(200);
    const root = rootOf(res);
    expect(root).toContain('ACME status');
    expect(root).toContain('Partner backend');
    expect(root).not.toContain('Other secret');
    expect(root).not.toContain('Public API');

    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const head = /<head>[\s\S]*<\/head>/.exec(res.body)?.[0] ?? '';
    expect(elements(head, 'meta').find((m) => m.name === 'robots')?.content).toBe('noindex, nofollow');
    expect(elements(head, 'link').filter((l) => l.rel === 'canonical' || l.rel === 'alternate')).toEqual([]);
    expect(head).not.toContain('application/ld+json');
    expect(res.body).not.toContain('/pulse/');
    // The analytics choice of the footer makes no sense where analytics never runs.
    expect(root).not.toContain('/preferences/analytics');
    // The main page's analytics still run (the setting is on).
    expect((await get('/')).body).toContain('/pulse/p.js');
  });

  it('works without JavaScript: service, bar day and back links stay on the private page', async () => {
    const base = `/p/${page.token}`;
    const root = rootOf(await get(base));
    const hrefs = elements(root, 'a').map((a) => a.href!);
    expect(hrefs).toContain(`${base}/services/${ids.hiddenSlug}`);
    expect(hrefs).toContain(`${base}/services/${ids.hiddenSlug}/days/${today()}`);
    expect(hrefs.filter((h) => h.startsWith('/services') || h === '/history')).toEqual([]);

    const service = await get(`${base}/services/${ids.hiddenSlug}`);
    expect(service.statusCode).toBe(200);
    expect(service.headers['cache-control']).toBe('private, no-store');
    const serviceLinks = elements(rootOf(service), 'a').map((a) => a.href!);
    expect(serviceLinks).toContain(base);
    expect(serviceLinks).toContain(`${base}/services/${ids.hiddenSlug}/days/${today()}`);

    const yesterday = shiftUptimeDay(today(), -1);
    const day = await get(`${base}/services/${ids.hiddenSlug}/days/${yesterday}`);
    expect(day.statusCode).toBe(200);
    const dayLinks = elements(rootOf(day), 'a').map((a) => a.href!);
    expect(dayLinks).toContain(`${base}/services/${ids.hiddenSlug}`);
    expect(dayLinks).toContain(`${base}/services/${ids.hiddenSlug}/days/${today()}`);
    expect(elements(day.body, 'meta').find((m) => m.name === 'robots')?.content).toBe('noindex, nofollow');

    expect((await get(`${base}/services/${ids.other}`)).statusCode).toBe(404);
    expect((await get(`${base}/services/${ids.hiddenSlug}/days/2001-01-01`)).statusCode).toBe(404);
  });

  it('is rendered for every request, never from a cache', async () => {
    expect(rootOf(await get(`/p/${page.token}`))).toContain('ACME status');
    await admin.patch(`/api/admin/private-pages/${page.id}`, { name: 'Renamed page' });
    expect(rootOf(await get(`/p/${page.token}`))).toContain('Renamed page');
    await admin.patch(`/api/admin/private-pages/${page.id}`, { enabled: false });
    expect((await get(`/p/${page.token}`)).statusCode).toBe(404);
  });

  it('answers wrong, disabled, expired and malformed links with the same 404 page', async () => {
    const expired = data<Any>(
      await admin.post('/api/admin/private-pages', { name: 'Old', serviceIds: [ids.hidden], expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    const disabled = data<Any>(await admin.post('/api/admin/private-pages', { name: 'Off', serviceIds: [ids.hidden], enabled: false }));
    const pages: string[] = [];
    for (const token of [newPrivatePageToken(), expired.token, disabled.token, 'not-a-token']) {
      const res = await get(`/p/${token}`);
      expect(res.statusCode, token).toBe(404);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(res.body).not.toContain('/pulse/');
      // The same page apart from the link itself (the logo and the forms return to it).
      pages.push(rootOf(res).replaceAll(token, 'TOKEN'));
    }
    expect(new Set(pages).size).toBe(1);
    expect(pages[0]).not.toContain('Partner backend');
  });

  it('keeps the hidden service off the main pages, the sitemaps and llms.txt', async () => {
    await admin.patch('/api/admin/settings', { analyticsEnabled: false });
    for (const url of ['/', '/services', '/history', '/sitemap.xml', '/sitemap-pages.xml', '/sitemap-services-1.xml', '/llms.txt', '/llms-full.txt']) {
      const res = await get(url);
      expect(res.body, url).not.toContain('Partner backend');
      expect(res.body, url).not.toContain(ids.hidden);
      expect(res.body, url).not.toContain('/p/');
    }
    expect((await get(`/services/${ids.hiddenSlug}`)).statusCode).toBe(404);
    const robots = (await get('/robots.txt')).body.split('\n');
    expect(robots).toContain('Disallow: /p/');
    expect(robots).toContain('Disallow: /api/public/private-page');
  });

  it('limits page views per client', async () => {
    const token = newPrivatePageToken();
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await get(`/p/${token}`)).statusCode;
    expect(last).toBe(429);
  });

  it('answers paths with dot segments with a plain, uncached 404 that renders nothing', async () => {
    const paths = [`/./p/${page.token}`, `/a/../p/${page.token}`, `/%2e/p/${page.token}`, `/x/%2E%2E/p/${page.token}/services/${ids.hiddenSlug}`];
    for (const path of paths) {
      const res = await getAsIs(path);
      expect(res.statusCode, path).toBe(404);
      expect(res.body, path).not.toContain('Partner backend');
      expect(res.body, path).not.toContain('ACME status');
      expect(res.headers['cache-control'], path).toBe('no-store');
      expect(res.headers['referrer-policy'], path).toBe('no-referrer');
      expect(res.headers['x-robots-tag'], path).toBe('noindex, nofollow');
    }
    // Nothing of them ends up in the render cache: the real page still renders per request.
    await admin.patch(`/api/admin/private-pages/${page.id}`, { enabled: false });
    expect((await get(`/p/${page.token}`)).statusCode).toBe(404);
  });

  it('counts every spelling of a private path against the same limit', async () => {
    const token = newPrivatePageToken();
    for (let i = 0; i < 60; i++) await get(`/P/${token}`);
    expect((await get(`/p/${token}`)).statusCode).toBe(429);
    // A dot-segment path never reaches the page (and so cannot be used to guess either).
    expect((await getAsIs(`/./p/${token}`)).statusCode).toBe(404);
  });
});
