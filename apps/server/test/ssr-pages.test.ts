/**
 * Server-side rendered public pages: every public page answers with the
 * rendered content of its data, the right status, head data and a state block
 * that parses; admin paths keep the client-rendered management UI (noindex).
 * Renders from the web sources (apps/web/src/entry-server.tsx), so no web build
 * is needed; the page template is a copy of what Vite writes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { PublicDocuments } from '../src/services/public-documents.js';
import { busyLanguage } from '../src/ssr/busy.js';
import { acceptsGzip, Limiter, RenderQueueFull, SsrPages, type RenderModule, type SsrPagesOptions } from '../src/ssr/pages.js';
import { adminClient, BASE_URL, createTestApp, seedChecks, type TestApp } from './helpers.js';

/** The web client's render entry, from source (a URL, so the server's typecheck does not compile the web sources). */
const ENTRY = new URL('../../web/src/entry-server.tsx', import.meta.url).href;
const renderFromSource = () => import(/* @vite-ignore */ ENTRY) as Promise<RenderModule>;

const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <meta name="description" content="Template description" />
    <meta name="color-scheme" content="light dark" />
    <title>Status</title>
    <script type="module" crossorigin src="/assets/public.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/shared.js">
    <link rel="stylesheet" crossorigin href="/assets/shared.css">
  </head>
  <body>
    <div id="root"></div>
    <!-- Public pages only -->
  </body>
</html>
`;

const MANIFEST = {
  'index.html': { file: 'assets/index.js', isEntry: true, imports: ['_shared.js'] },
  'public.html': { file: 'assets/public.js', isEntry: true, imports: ['_shared.js'] },
  '_shared.js': { file: 'assets/shared.js', css: ['assets/shared.css'] },
};

let webDir: string;

beforeAll(() => {
  webDir = mkdtempSync(join(tmpdir(), 'osp-ssr-'));
  mkdirSync(join(webDir, 'assets'));
  mkdirSync(join(webDir, '.vite'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>management</title><div id="root"></div>');
  writeFileSync(join(webDir, 'public.html'), TEMPLATE);
  writeFileSync(join(webDir, '.vite', 'manifest.json'), JSON.stringify(MANIFEST));
  mkdirSync(join(webDir, '.ssr'));
  for (const f of ['assets/index.js', 'assets/public.js', 'assets/shared.js', 'assets/shared.css', '.ssr/entry-server.mjs']) {
    writeFileSync(join(webDir, f), '');
  }
});
afterAll(() => rmSync(webDir, { recursive: true, force: true }));

let t: TestApp;
let ids: { apiSlug: string; incident: string; maintenance: string };

const INCIDENT_TITLE = 'Database latency </script><script>alert(1)</script>';

async function seed(app: TestApp) {
  const admin = await adminClient(app);
  const { checkIds } = await seedChecks(app, [{ externalId: 'db', name: 'db check', host: 'db.internal.example.com', state: 'warning' }]);
  const group = (await admin.post('/api/admin/service-groups', { name: 'Platform' })).json().data.id;
  const fra = (await admin.post('/api/admin/locations', { name: 'Frankfurt', code: 'FRA-1', region: 'europe' })).json().data.id;
  const api = (
    await admin.post('/api/admin/services', { name: 'Public API', groupId: group, locationIds: [fra], checks: [{ checkId: checkIds.db }] })
  ).json().data.id;
  await admin.post('/api/admin/services', { name: 'Website', kind: 'site', url: 'https://www.example.com' });
  await admin.post('/api/admin/services', { name: 'Hidden backend', isPublic: false });
  const incident = (
    await admin.post('/api/admin/incidents', {
      title: INCIDENT_TITLE,
      message: 'We are investigating.',
      affectedServices: [{ serviceId: api, status: 'degraded' }],
    })
  ).json().data.id;
  await admin.post('/api/admin/incidents', { title: 'Private incident', message: 'internal', isPublic: false });
  const maintenance = (
    await admin.post('/api/admin/maintenances', {
      title: 'Network upgrade',
      scheduledStart: new Date(Date.now() + 86400_000).toISOString(),
      scheduledEnd: new Date(Date.now() + 90000_000).toISOString(),
      serviceIds: [api],
    })
  ).json().data.id;
  const services = (await app.app.inject({ method: 'GET', url: '/api/public/services' })).json().data as {
    attributes: { name: string; slug: string };
  }[];
  const apiSlug = services.find((s) => s.attributes.name === 'Public API')!.attributes.slug;
  return { apiSlug, incident, maintenance };
}

const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers });

/**
 * GET with the request target exactly as given (backslashes, absolute form):
 * inject() and fetch() normalise it before sending, a hand-made request does not.
 */
async function getRaw(target: string): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: string }> {
  const address = t.app.server.listening ? null : await t.app.listen({ host: '127.0.0.1', port: 0 });
  const port = address ? Number(new URL(address).port) : (t.app.server.address() as { port: number }).port;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Parsed state block of a rendered page. */
function stateOf(res: LightMyRequestResponse): { lang: string; queries: { queries: { queryKey: unknown[]; state: { status: string } }[] } } {
  const match = /<script type="application\/json" id="osp-state">([^<]*)<\/script>/.exec(res.body);
  expect(match, 'state block').not.toBeNull();
  return JSON.parse(match![1]!);
}

const rootOf = (res: LightMyRequestResponse) => /<div id="root">([\s\S]*)<\/div><script type="application\/json"/.exec(res.body)?.[1] ?? '';

describe.each(['all', 'public'])('rendered public pages (APP_ROLE=%s)', (role) => {
  let seeder: TestApp;
  beforeEach(async () => {
    seeder = await createTestApp({}, { web: { dir: webDir, ssrModule: renderFromSource } });
    ids = await seed(seeder);
    // A public instance has no admin API: it serves the data seeded through an "all" app.
    t = role === 'all' ? seeder : { ...seeder, app: await publicApp(seeder) };
  });
  afterEach(async () => {
    if (t.app !== seeder.app) await t.app.close();
    await seeder.close();
  });

  it('renders the overview with services, status and incidents', async () => {
    const res = await get('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    const root = rootOf(res);
    for (const text of ['Public API', 'Website', 'Platform', 'Degraded performance', 'Database latency', 'Network upgrade']) {
      expect(root).toContain(text);
    }
    expect(res.body).not.toContain('Hidden backend');
    expect(res.body).not.toContain('Private incident');
    expect(res.body).not.toContain('db.internal.example.com');
    // Admin content is escaped in the markup and in the state block.
    expect(res.body).not.toContain('<script>alert(1)</script>');
    const state = stateOf(res);
    expect(state.queries.queries.map((q) => q.queryKey)).toEqual(
      expect.arrayContaining([
        ['public', 'settings'],
        ['public', 'summary'],
      ]),
    );
    expect(JSON.stringify(state)).toContain(INCIDENT_TITLE);
  });

  it('fills the template: language, head, assets, state', async () => {
    const res = await get('/services');
    expect(res.body.startsWith('<!doctype html>\n<html lang="en" dir="ltr">')).toBe(true);
    expect(res.body).toContain('<title>Services &amp; Sites · Status</title>');
    expect(res.body).toContain(`<link rel="canonical" href="${BASE_URL}/services" data-osp-head>`);
    expect(res.body).not.toContain('Template description');
    expect(res.body.match(/<title>/g)).toHaveLength(1);
    expect(res.body).toContain('<script type="module" crossorigin src="/assets/public.js"></script>');
    expect(res.body).toContain('<link rel="stylesheet" crossorigin href="/assets/shared.css">');
    expect(res.body).toContain('<link rel="alternate" type="application/rss+xml"');
    expect(rootOf(res)).toContain('Public API');
    expect(res.body).toContain('<!-- Public pages only -->');
  });

  it('renders every public page with its data', async () => {
    const pages: [url: string, texts: string[]][] = [
      ['/services', ['Public API', 'Website']],
      [`/services/${ids.apiSlug}`, ['Public API', 'Frankfurt', 'Database latency']],
      ['/locations', ['Frankfurt', 'FRA-1']],
      ['/history', ['Database latency']],
      ['/history?type=maintenance', []],
      [`/incidents/${ids.incident}`, ['Database latency', 'We are investigating.', 'Public API']],
      [`/maintenance/${ids.maintenance}`, ['Network upgrade', 'Public API']],
      ['/subscribe', []],
      ['/subscription/confirm?id=x', []],
      ['/subscription/manage?id=x', []],
    ];
    for (const [url, texts] of pages) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      const root = rootOf(res);
      expect(root, url).toContain('<main');
      for (const text of texts) expect(root, `${url}: ${text}`).toContain(text);
      expect(stateOf(res).lang).toBe('en');
    }
  });

  it('answers 404 for unknown pages, services and incidents', async () => {
    for (const url of ['/does-not-exist', '/services/missing', '/incidents/missing', '/maintenance/missing']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.body).toContain('<meta name="robots" content="noindex" data-osp-head>');
      expect(res.body).not.toContain('hreflang');
      expect(res.body).not.toContain('application/ld+json');
      expect(res.body).not.toContain('rel="canonical"');
      expect(rootOf(res)).toContain('Page not found');
    }
  });

  it('writes the page head: robots, language versions, link preview, JSON-LD', async () => {
    const res = await get(`/incidents/${ids.incident}`);
    const head = /<head>([\s\S]*)<\/head>/.exec(res.body)![1]!;
    const url = `${BASE_URL}/incidents/${ids.incident}`;
    expect(head).toContain('<meta name="robots" content="index, follow" data-osp-head>');
    expect(head).toContain(`<link rel="alternate" hreflang="de" href="${url}?lang=de" data-osp-head>`);
    expect(head).toContain(`<link rel="alternate" hreflang="x-default" href="${url}" data-osp-head>`);
    expect(head).toContain('<meta property="og:type" content="article" data-osp-head>');
    expect(head).toContain(`<meta property="og:url" content="${url}" data-osp-head>`);
    expect(head).toContain('<meta name="twitter:card" content="summary" data-osp-head>');
    expect(head).toContain('<meta property="og:description" content="We are investigating." data-osp-head>');
    // Admin content is escaped in attributes and in JSON-LD.
    expect(head).toContain('content="Database latency &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; · Status"');
    expect(head).not.toContain('<script>alert(1)');
    const blocks = [...head.matchAll(/<script type="application\/ld\+json" data-osp-head>([^<]*)<\/script>/g)].map(
      (m) => JSON.parse(m[1]!) as { '@type': string; headline?: string },
    );
    expect(blocks.map((b) => b['@type'])).toEqual(['Article', 'BreadcrumbList']);
    expect(blocks[0]!.headline).toBe(INCIDENT_TITLE);
    // The head elements come before the assets of the template.
    expect(res.body.indexOf('data-osp-head')).toBeLessThan(res.body.indexOf('/assets/public.js'));
  });

  it('renders in the language of the cookie, ?lang= or Accept-Language', async () => {
    const de = await get('/services', { 'accept-language': 'de-DE,de;q=0.9' });
    expect(de.body).toContain('<html lang="de" dir="ltr">');
    expect(stateOf(de).lang).toBe('de');
    expect((await get('/services?lang=de')).body).toContain('<html lang="de"');
    // An explicit ?lang= is that language version, whatever the cookie says.
    const cookie = await get('/services?lang=de', { cookie: 'osp-lang=en' });
    expect(cookie.body).toContain('<html lang="de"');
    expect((await get('/services', { cookie: 'osp-lang=de' })).body).toContain('<html lang="de"');
    expect(cookie.headers.vary).toBe('Accept-Language, Cookie, Accept-Encoding');
  });

  it('puts an explicit theme on <html>', async () => {
    expect((await get('/', { cookie: 'osp-theme=dark' })).body).toContain('<html lang="en" dir="ltr" data-theme="dark">');
  });

  it('renders the footer legal links, copyright notice and info link with UTM parameters', async () => {
    const admin = await adminClient(seeder, 'footer@example.com');
    const saved = await admin.patch('/api/admin/settings', {
      imprintUrl: 'https://www.example.com/imprint',
      privacyUrl: 'https://www.example.com/privacy?lang=en',
      privacyLabel: 'Data protection',
      accessibilityUrl: 'https://www.example.com/a11y?utm_source=kept',
      copyrightText: '© {year} Example <GmbH>',
      brandUrl: 'https://www.example.com/',
      showPoweredBy: false,
      infoLinkUrl: '/about',
      infoLinkLabel: 'What does the status mean?',
      supportUrl: `${BASE_URL}/help`,
      utmEnabled: true,
      utmSource: 'status',
      utmMedium: 'referral',
      utmCampaign: 'statuspage',
    });
    expect(saved.statusCode).toBe(200);
    const utm = 'utm_source=status&amp;utm_medium=referral&amp;utm_campaign=statuspage';
    const res = await get('/');
    const root = rootOf(res);
    const footer = /<footer[\s\S]*<\/footer>/.exec(root)?.[0] ?? '';
    // The legal links in their own navigation landmark, in a new tab and said so.
    expect(footer).toMatch(/<nav aria-label="Legal">/);
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /** An outbound link: new tab, rel, the text, and the screen reader hint. */
    const outbound = (href: string, text: string) =>
      new RegExp(`<a href="${esc(href)}"[^>]* target="_blank" rel="noopener noreferrer">${esc(text)}<svg[^]*?\\(opens in a new tab\\)</span></a>`);
    expect(footer).toMatch(outbound(`https://www.example.com/imprint?${utm}`, 'Imprint'));
    expect(footer).toMatch(outbound(`https://www.example.com/privacy?lang=en&amp;${utm}`, 'Data protection'));
    // Existing utm_ parameters are never overwritten or mixed.
    expect(footer).toMatch(outbound('https://www.example.com/a11y?utm_source=kept', 'Accessibility statement'));
    // Same-origin links get no UTM parameters and stay in the tab.
    expect(footer).toMatch(new RegExp(`<a href="${esc(BASE_URL)}/help" class="[^"]*">Support</a>`));
    // The notice as plain text with the year of the render, linked to the brand.
    expect(footer).toMatch(new RegExp(`<a href="${esc(`https://www.example.com/?${utm}`)}"[^>]* target="_blank" rel="noopener noreferrer">©`));
    expect(footer).toContain(`© ${new Date().getUTCFullYear()} Example &lt;GmbH&gt;`);
    expect(footer).not.toContain('Powered by OpenStatusPage');
    // The info link in the page navigation: a plain link to the path, no UTM, same tab.
    const nav = /<nav aria-label="Status page sections"[\s\S]*?<\/nav>/.exec(root)?.[0] ?? '';
    expect(nav).toMatch(/<a href="\/about" class="[^"]*">.*What does the status mean\?<\/a>/);
    // Service websites are outbound links as well.
    expect(root).toContain(`href="https://www.example.com/?${utm}" target="_blank"`);
    // JSON-LD: the brand link is the organization's sameAs (without UTM parameters).
    expect(res.body).toContain('"sameAs":["https://www.example.com/"]');
  });

  it('renders no legal navigation and the attribution by default', async () => {
    const root = rootOf(await get('/'));
    expect(root).not.toContain('aria-label="Legal"');
    expect(root).toContain('Powered by OpenStatusPage');
    expect(root).not.toContain('utm_');
  });

  it('links the API description in the footer and the head by default, without JavaScript', async () => {
    const res = await get('/');
    const footer = /<footer[\s\S]*<\/footer>/.exec(rootOf(res))?.[0] ?? '';
    expect(footer).toMatch(
      /<a href="\/api\/openapi.json" type="application\/json" class="[^"]*">API<span class="sr-only"> \(machine-readable OpenAPI description in JSON\)<\/span><\/a>/,
    );
    expect(res.body).toContain('<link rel="service-desc" type="application/openapi+json" href="/api/openapi.json"/>');
  });

  it('leaves the API description link out when the page does not publish it', async () => {
    const admin = await adminClient(seeder, 'api-link@example.com');
    expect((await admin.patch('/api/admin/settings', { publicApiDescription: false })).statusCode).toBe(200);
    const res = await get('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('/api/openapi.json');
    expect(rootOf(res)).toContain('Status API');
    // The state the client hydrates from agrees with the markup.
    expect(JSON.stringify(stateOf(res))).toContain('"publicApiDescription":false');
  });

  it('caches briefly with an ETag', async () => {
    const first = await get('/');
    expect(first.headers['cache-control']).toBe('public, max-age=10, stale-while-revalidate=60');
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\/"/);
    const again = await get('/', { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect((await get('/subscription/manage?id=x')).headers['cache-control']).toBe('private, no-store');
  });

  it('redirects other spellings of a page path to the preferred one (301)', async () => {
    for (const [url, location] of [
      ['/SERVICES', '/services'],
      ['/services/', '/services'],
      ['/History/?type=incident&page=2', '/history?type=incident&page=2'],
      ['//services//web', '/services/web'],
    ]) {
      const res = await get(url!);
      expect(res.statusCode, url).toBe(301);
      expect(res.headers.location, url).toBe(location);
    }
    expect((await get('/services')).statusCode).toBe(200);
    expect((await get('/')).statusCode).toBe(200);
  });

  it('never redirects off the site, whatever the request target', async () => {
    for (const target of ['/\\evil.example/', '/\\evil.example', '/%5Cevil.example/', 'http://evil.example/X', 'http://evil.example//X/']) {
      const res = await getRaw(target);
      expect(res.statusCode, target).toBe(404);
      expect(res.headers.location, target).toBeUndefined();
      expect(res.headers['cache-control'], target).toBe('no-store');
    }
  });

  it('answers other spellings of API paths with a 404, not a cacheable redirect', async () => {
    for (const url of ['/API/public/services', '/Api/admin/users/', '/%61PI/nope', '//api//public//nope']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers.location, url).toBeUndefined();
      expect(String(res.headers['cache-control'] ?? ''), url).not.toContain('public');
    }
  });

  it('never caches personal pages in another spelling of the path', async () => {
    // The router matches routes case-insensitively: these render the manage and confirm pages.
    for (const url of ['/SUBSCRIPTION/manage?id=x&token=y', '/Subscription/Confirm?id=x&token=y', '//subscription//manage?id=x']) {
      const res = await get(url);
      expect(res.headers['cache-control'], url).toBe('private, no-store');
      expect(res.headers['referrer-policy'], url).toBe('no-referrer');
    }
  });

  it('sends the page gzip-compressed to clients that accept it', async () => {
    const plain = await get('/services');
    expect(plain.headers['content-encoding']).toBeUndefined();
    const gzip = await get('/services', { 'accept-encoding': 'gzip, deflate, br' });
    expect(gzip.headers['content-encoding']).toBe('gzip');
    expect(gzip.headers.etag).toBe(plain.headers.etag);
    const body = gunzipSync(gzip.rawPayload);
    expect(body.toString('utf8')).toBe(plain.body);
    expect(gzip.rawPayload.length).toBeLessThan(body.length / 3);
  });

  it('serves no rendered page for API paths and files, and never the render bundle', async () => {
    expect((await get('/api/public/nope')).headers['content-type']).toContain('application/vnd.api+json');
    expect((await get('/missing.js')).statusCode).toBe(404);
    expect((await get('/assets/shared.css')).statusCode).toBe(200);
    expect((await get('/.ssr/entry-server.mjs')).statusCode).toBe(404);
  });
});

describe('management UI', () => {
  beforeEach(async () => {
    t = await createTestApp({}, { web: { dir: webDir, ssrModule: renderFromSource } });
  });
  afterEach(async () => {
    await t.close();
  });

  it('stays client-rendered and is never indexed', async () => {
    for (const url of ['/admin', '/admin/services', '/ADMIN/users']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('<title>management</title>');
      expect(res.headers['x-robots-tag'], url).toBe('noindex, nofollow');
    }
    expect((await get('/')).headers['x-robots-tag']).toBeUndefined();
  });
});

describe('render errors', () => {
  afterEach(async () => {
    await t.close();
  });

  it('falls back to the client-rendered page when the bundle cannot be loaded', async () => {
    const lines: string[] = [];
    t = await createTestApp(
      {},
      { web: { dir: webDir, ssrModule: () => Promise.reject(new Error('no bundle')) } },
    );
    t.app.log.error = ((obj: unknown, msg?: string) => lines.push(String(msg ?? obj))) as typeof t.app.log.error;
    const res = await get('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>management</title>');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('falls back when rendering throws', async () => {
    t = await createTestApp(
      {},
      {
        web: {
          dir: webDir,
          ssrModule: async () => ({ cacheKey: (i) => i.url, pageUrl: (u) => u, render: () => Promise.reject(new Error('boom')) }),
        },
      },
    );
    const res = await get('/services');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>management</title>');
  });
});

/** An APP_ROLE=public instance on the database of another test app. */
async function publicApp(other: TestApp) {
  const config = loadConfig(
    { NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', BASE_URL, APP_ROLE: 'public', WEB_DIST_DIR: webDir },
    { allowSqliteForAnyRole: true },
  );
  const app = await buildApp({ config, db: other.db, ssrModule: renderFromSource });
  await app.ready();
  return app;
}

describe('accepted encodings', () => {
  it('accepts gzip unless its quality is zero', () => {
    expect(acceptsGzip('gzip, deflate, br, zstd')).toBe(true);
    expect(acceptsGzip('br;q=1.0, gzip;q=0.8')).toBe(true);
    expect(acceptsGzip('*')).toBe(true);
    expect(acceptsGzip('gzip;q=0, *')).toBe(false);
    expect(acceptsGzip('br')).toBe(false);
    expect(acceptsGzip('identity')).toBe(false);
    expect(acceptsGzip(undefined)).toBe(false);
  });
});

describe('render limits', () => {
  it('runs at most `limit` renders at once and refuses beyond the queue', async () => {
    const limiter = new Limiter(2, 1);
    let active = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const task = () =>
      limiter.run(async () => {
        active++;
        most = Math.max(most, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
      });
    const runs = [task(), task(), task()];
    await expect(task()).rejects.toBeInstanceOf(RenderQueueFull);
    while (releases.length > 0 || active > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(runs);
    expect(most).toBe(2);
  });

  it('renders a page once per key while it is cached, and once for concurrent requests', async () => {
    let renders = 0;
    const real = await renderFromSource();
    t = await createTestApp(
      {},
      {
        web: {
          dir: webDir,
          ssrModule: async () => ({
            cacheKey: real.cacheKey,
            pageUrl: real.pageUrl,
            render: async (input) => {
              renders++;
              return real.render(input);
            },
          }),
        },
      },
    );
    await Promise.all([get('/services'), get('/services'), get('/services')]);
    expect(renders).toBe(1);
    await get('/services');
    expect(renders).toBe(1);
    await get('/services', { 'accept-language': 'de' });
    await get('/history');
    expect(renders).toBe(3);
    // Parameters no page reads share the render (cache busting, tracking).
    await Promise.all([get('/history?x=1'), get('/history?utm_source=a'), get('/history?x=2&y=3')]);
    expect(renders).toBe(3);
    await get('/history?page=2&x=1');
    expect(renders).toBe(4);
    await t.close();
  });

  it('sends the client-rendered page beyond the queue when no earlier version exists and logs that once, with a count', async () => {
    const real = await renderFromSource();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    t = await createTestApp(
      {},
      {
        web: {
          dir: webDir,
          ssrModule: async () => ({
            ...real,
            render: async (input) => {
              await blocked;
              return real.render(input);
            },
          }),
        },
      },
    );
    const warnings: unknown[] = [];
    t.app.log.warn = ((obj: unknown) => warnings.push(obj)) as typeof t.app.log.warn;
    // 1 renders, 4 wait, the rest gets the client-rendered entry page at once (no earlier
    // version of these pages, and the entry page costs no render).
    const pending = Array.from({ length: 10 }, (_, i) => get(`/services?q=${i}`));
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const pages = await Promise.all(pending);
    const plain = pages.filter((p) => !p.body.includes('id="osp-state"'));
    expect(plain).toHaveLength(5);
    for (const res of pages) expect(res.statusCode).toBe(200);
    for (const res of plain) {
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['content-type']).toContain('text/html');
    }
    expect(warnings).toEqual([{ requests: 1, stale: 0 }]);
    await t.close();
  });
});

describe('overload: stale pages, client-rendered pages and 503', () => {
  /** Render bundle stand-in: the page shows its URL and a version; `/block` holds the only render slot. */
  let version: number;
  let failing: boolean;
  let release: () => void;
  let blocked: Promise<void>;
  const module: RenderModule = {
    cacheKey: (input) => input.url,
    pageUrl: (url) => url,
    render: async (input) => {
      if (input.url === '/block') await blocked;
      if (failing) throw new Error('boom');
      return {
        status: input.url.startsWith('/missing') ? 404 : 200,
        html: `<main>${input.url} v${version}</main>`,
        hoisted: '',
        head: { title: 'Page' },
        lang: 'en',
        dir: 'ltr',
        theme: 'system',
        state: '{}',
      };
    },
  };

  let app: FastifyInstance;
  let ssr: SsrPages;
  let blocker: Promise<unknown> | null;

  async function start(options: Partial<SsrPagesOptions> = {}) {
    app = Fastify();
    ssr = new SsrPages({
      webDir,
      baseUrl: BASE_URL,
      docs: {} as PublicDocuments,
      log: app.log,
      loadModule: async () => module,
      concurrency: 1,
      maxWaiting: 0,
      cacheSeconds: 0.05,
      ...options,
    });
    app.get('/*', async (req, reply) => ((await ssr.send(req, reply)) ? reply : reply.type('text/html').send('plain page')));
    await app.ready();
  }

  const page = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Occupies the only render slot (no waiting places): every other render is refused. */
  async function overload() {
    blocker = page('/block');
    await sleep(10);
  }

  beforeEach(() => {
    version = 1;
    failing = false;
    blocked = new Promise<void>((resolve) => (release = resolve));
    blocker = null;
  });
  afterEach(async () => {
    release();
    await blocker;
    await app.close();
  });

  it('sends the expired page, marked stale, when no render slot is free', async () => {
    await start();
    const first = await page('/a');
    expect(first.headers['x-cache']).toBeUndefined();
    await sleep(80);
    version = 2;
    await overload();
    const stale = await page('/a');
    expect(stale.statusCode).toBe(200);
    expect(stale.body).toContain('/a v1');
    expect(stale.headers['x-cache']).toBe('STALE');
    expect(stale.headers['cache-control']).toBe('public, max-age=5');
    expect(stale.headers.etag).toBe(first.headers.etag);
    const notModified = await page('/a', { 'if-none-match': first.headers.etag as string });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.headers['x-cache']).toBe('STALE');
    // With a free slot again, the page is rendered fresh.
    release();
    await blocker;
    const fresh = await page('/a');
    expect(fresh.body).toContain('/a v2');
    expect(fresh.headers['x-cache']).toBeUndefined();
    expect(fresh.headers['cache-control']).toBe('public, max-age=10, stale-while-revalidate=60');
    expect(fresh.headers.etag).not.toBe(first.headers.etag);
  });

  it('sends the client-rendered page when there is no earlier version', async () => {
    await start();
    await overload();
    const res = await page('/b', { 'accept-language': 'de-DE,de;q=0.9' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('plain page');
  });

  it('sends the client-rendered page once the stale window is over', async () => {
    await start({ staleSeconds: 0.05 });
    await page('/a');
    await sleep(150);
    expect(ssr.cacheSize.entries).toBe(0);
    await overload();
    expect((await page('/a')).body).toBe('plain page');
  });

  it('prefers the stale page to the plain page when rendering fails', async () => {
    await start();
    await page('/a');
    await sleep(80);
    failing = true;
    const stale = await page('/a');
    expect(stale.body).toContain('/a v1');
    expect(stale.headers['x-cache']).toBe('STALE');
    // Without an earlier version, a render error still gets the plain page.
    expect((await page('/c')).body).toBe('plain page');
  });

  it.each([
    ['/subscription/manage?id=x&token=y', 'token=y'],
    ['/p/abcdefghijklmnopqrstuvwxyz234567', 'abcdefghijklmnopqrstuvwxyz234567'],
  ])('never keeps or answers personal pages stale (%s)', async (url, secret) => {
    await start();
    expect((await page(url)).headers['cache-control']).toBe('private, no-store');
    expect(ssr.cacheSize.entries).toBe(0);
    await overload();
    // A 503 busy page in the visitor's language, never the client-rendered page or a stale copy.
    const res = await page(url, { 'accept-language': 'de-DE,de;q=0.9' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.body).toContain('<html lang="de"');
    expect(res.body).toContain('<h1>Vorübergehend ausgelastet</h1>');
    expect(res.body).not.toContain('<script');
    expect(res.body).not.toContain(secret);
  });

  it('keeps no 404 renders, so unknown URLs cannot push real pages out', async () => {
    await start({ cacheEntries: 2 });
    await page('/a');
    for (let i = 0; i < 5; i++) expect((await page(`/missing-${i}`)).statusCode).toBe(404);
    expect(ssr.cacheSize.entries).toBe(1);
    await sleep(80);
    await overload();
    expect((await page('/a')).headers['x-cache']).toBe('STALE');
  });

  it('drops the least recently used page first', async () => {
    await start({ cacheEntries: 2, cacheSeconds: 5 });
    await page('/a');
    await page('/b');
    await page('/a');
    await page('/c');
    await overload();
    // /a was used after /b, so /b went when /c came in.
    expect((await page('/a')).body).toContain('/a v1');
    expect((await page('/c')).body).toContain('/c v1');
    expect((await page('/b')).body).toBe('plain page');
  });

  it('keeps stale pages within the byte limit, dropping the oldest', async () => {
    await start();
    await page('/p0');
    const perPage = ssr.cacheSize.bytes;
    await app.close();
    const cacheBytes = Math.floor(perPage * 2.5);
    await start({ cacheBytes });
    for (let i = 0; i < 5; i++) await page(`/p${i}`);
    await sleep(80);
    expect(ssr.cacheSize).toEqual({ entries: 2, bytes: expect.any(Number) });
    expect(ssr.cacheSize.bytes).toBeLessThanOrEqual(cacheBytes);
    await overload();
    expect((await page('/p4')).headers['x-cache']).toBe('STALE');
    expect((await page('/p3')).headers['x-cache']).toBe('STALE');
    expect((await page('/p0')).body).toBe('plain page');
  });
});

describe('busy page language', () => {
  it('follows ?lang=, the language cookie and Accept-Language, else English', () => {
    expect(busyLanguage('/?lang=de', undefined, 'en')).toBe('de');
    expect(busyLanguage('/', 'a=1; osp-lang=de', 'en')).toBe('de');
    expect(busyLanguage('/', undefined, 'fr-FR, de;q=0.8')).toBe('de');
    expect(busyLanguage('/', undefined, 'de;q=0, en')).toBe('en');
    expect(busyLanguage('/?lang=xx', 'osp-lang=fr', 'fr')).toBe('en');
  });
});
