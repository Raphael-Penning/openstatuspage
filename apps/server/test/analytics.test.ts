/**
 * Umami analytics: the proxy routes (/pulse/p.js, /pulse/api/send) against a
 * fake Umami server, the script tag of rendered pages, the opt-out form and the
 * render cache that keeps pages with and without the script apart.
 */
import { gunzipSync } from 'node:zlib';
import { ANALYTICS_PATHS, SettingsInput, type PublicPageSettings } from '@openstatuspage/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanEvent,
  MAX_IN_FLIGHT,
  MAX_IN_FLIGHT_PER_CLIENT,
  registerAnalyticsRoutes,
  SCRIPT_MAX_BYTES,
  SCRIPT_RETRY_MS,
  SCRIPT_TTL_MS,
  ScriptCache,
  SEND_BODY_LIMIT,
  type Upstream,
} from '../src/routes/analytics.js';
import { saveSettings } from '../src/services/settings.js';
import { adminClient, BASE_URL, createTestApp, data, errors, type TestApp } from './helpers.js';
import { createWebDir, renderFromSource, rootOf } from './web-fixture.js';

const WEBSITE = '4f3c2b1a-1234-4abc-8def-0123456789ab';
const SCRIPT = '!function(){/* umami tracker */}();';
const ON: Partial<PublicPageSettings> = { analyticsEnabled: true, analyticsWebsiteId: WEBSITE };

// --- A fake Umami server ---------------------------------------------------------

interface Received {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

type Handler = (req: FastifyRequest, reply: FastifyReply) => unknown;

class FakeUmami {
  server: FastifyInstance = Fastify();
  url = '';
  received: Received[] = [];
  script: Handler = (_req, reply) => reply.type('application/javascript').send(SCRIPT);
  send: Handler = (_req, reply) => reply.send({ cache: 'header.payload.signature' });

  async start(): Promise<this> {
    const record = (req: FastifyRequest) => this.received.push({ url: req.url, headers: { ...req.headers }, body: req.body });
    this.server.get('/script.js', (req, reply) => {
      record(req);
      return this.script(req, reply);
    });
    this.server.post('/api/send', (req, reply) => {
      record(req);
      return this.send(req, reply);
    });
    this.server.all('/*', (req, reply) => {
      record(req);
      return reply.status(200).type('application/javascript').send('/* elsewhere */');
    });
    this.url = await this.server.listen({ host: '127.0.0.1', port: 0 });
    return this;
  }

  hits(path: string): number {
    return this.received.filter((r) => r.url === path).length;
  }

  close(): Promise<void> {
    return this.server.close();
  }
}

let umami: FakeUmami;
let elsewhere: FakeUmami;
beforeAll(async () => {
  umami = await new FakeUmami().start();
  elsewhere = await new FakeUmami().start();
});
afterAll(async () => {
  await umami.close();
  await elsewhere.close();
});
beforeEach(() => {
  for (const s of [umami, elsewhere]) {
    s.received = [];
    s.script = (_req, reply) => reply.type('application/javascript').send(SCRIPT);
    s.send = (_req, reply) => reply.send({ cache: 'header.payload.signature' });
  }
});

let web: ReturnType<typeof createWebDir>;
beforeAll(() => {
  web = createWebDir();
});
afterAll(() => web.remove());

const settings = (extra: Partial<PublicPageSettings> = {}) => SettingsInput.parse({ siteName: 'Example Status', ...extra });

const event = (payload: Record<string, unknown> = {}) => ({
  type: 'event',
  payload: { website: WEBSITE, hostname: 'status.example.com', url: '/history', referrer: '', title: 'History', ...payload },
});

/** A bare app with only the proxy routes (short timeouts, settings without a database). */
async function proxyApp(page: () => PublicPageSettings, options: { sendTimeoutMs?: number; scriptTimeoutMs?: number } = {}) {
  const app = Fastify();
  await registerAnalyticsRoutes(app, { upstream: umami.url, baseUrl: BASE_URL, settings: async () => page(), ...options });
  await app.ready();
  return app;
}

const send = (app: FastifyInstance, body: unknown, headers: Record<string, string> = {}, remoteAddress?: string) =>
  app.inject({
    method: 'POST',
    url: ANALYTICS_PATHS.send,
    ...(remoteAddress ? { remoteAddress } : {}),
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Test', ...headers },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });

// --- Proxy routes ----------------------------------------------------------------

describe('analytics proxy without UMAMI_URL', () => {
  it('serves neither the script nor the event endpoint, whatever the settings say', async () => {
    const t = await createTestApp();
    try {
      await saveSettings(t.db, settings(ON));
      expect((await t.app.inject({ method: 'GET', url: ANALYTICS_PATHS.script })).statusCode).toBe(404);
      expect((await send(t.app, event())).statusCode).toBe(404);
      expect(data<{ analyticsEnabled: boolean }>(await t.app.inject({ method: 'GET', url: '/api/public/settings' })).analyticsEnabled).toBe(
        false,
      );
      expect(umami.received).toEqual([]);
    } finally {
      await t.close();
    }
  });
});

describe('GET /pulse/p.js', () => {
  let page: PublicPageSettings;
  let app: FastifyInstance;
  beforeEach(async () => {
    page = settings(ON);
    app = await proxyApp(() => page);
  });
  afterEach(() => app.close());
  const getScript = (headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: ANALYTICS_PATHS.script, headers });

  it('serves the Umami script from memory, fetched once', async () => {
    const first = await getScript();
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(first.headers['cache-control']).toBe('public, max-age=3600, stale-while-revalidate=86400');
    expect(first.body).toBe(SCRIPT);
    const second = await getScript({ 'accept-encoding': 'gzip' });
    expect(second.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(second.rawPayload).toString()).toBe(SCRIPT);
    expect((await getScript({ 'if-none-match': first.headers.etag as string })).statusCode).toBe(304);
    expect(umami.hits('/script.js')).toBe(1);
    // Nothing of the visitor goes upstream.
    expect(umami.received[0]!.headers['user-agent']).toBe('OpenStatusPage');
    expect(umami.received[0]!.headers.cookie).toBeUndefined();
  });

  it('is not served while analytics is off in the settings', async () => {
    page = settings();
    expect((await getScript()).statusCode).toBe(404);
    expect(umami.received).toEqual([]);
  });

  it('answers an empty script, never an error, when Umami fails', async () => {
    umami.script = (_req, reply) => reply.status(500).send('internal details');
    const res = await getScript();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toBe('/* analytics unavailable */\n');
    expect(res.body).not.toContain('internal');
  });

  it('never follows a redirect', async () => {
    umami.script = (_req, reply) => reply.redirect(`${elsewhere.url}/script.js`, 302);
    expect((await getScript()).body).toBe('/* analytics unavailable */\n');
    expect(elsewhere.received).toEqual([]);
  });

  it('refuses scripts that are too large or not JavaScript', async () => {
    umami.script = (_req, reply) => reply.type('application/javascript').send('x'.repeat(SCRIPT_MAX_BYTES + 1));
    expect((await getScript()).body).toBe('/* analytics unavailable */\n');
    const html = await proxyApp(() => page);
    try {
      umami.script = (_req, reply) => reply.type('text/html').send('<html>login</html>');
      expect((await html.inject({ method: 'GET', url: ANALYTICS_PATHS.script })).body).toBe('/* analytics unavailable */\n');
    } finally {
      await html.close();
    }
  });

  it('gives up on a slow Umami after the timeout', async () => {
    const slow = await proxyApp(() => page, { scriptTimeoutMs: 100 });
    try {
      umami.script = async (_req, reply) => {
        await new Promise((r) => setTimeout(r, 1000));
        return reply.type('application/javascript').send(SCRIPT);
      };
      const started = Date.now();
      expect((await slow.inject({ method: 'GET', url: ANALYTICS_PATHS.script })).body).toBe('/* analytics unavailable */\n');
      expect(Date.now() - started).toBeLessThan(900);
    } finally {
      await slow.close();
    }
  });
});

describe('ScriptCache', () => {
  const log = { warn: () => {} };

  it('refetches after the TTL, keeps the old copy while Umami fails and waits before retrying', async () => {
    let calls = 0;
    let fail = false;
    const upstream: Upstream = async () => {
      calls++;
      if (fail) throw new Error('down');
      return { status: 200, type: 'application/javascript', body: Buffer.from(`v${calls}`) };
    };
    const cache = new ScriptCache('http://umami.invalid/script.js', upstream, 1000, log);
    expect((await cache.get(0))?.body.toString()).toBe('v1');
    expect((await cache.get(SCRIPT_TTL_MS - 1))?.body.toString()).toBe('v1');
    expect(calls).toBe(1);
    // Expired: the old copy answers at once, the refresh runs behind it.
    fail = true;
    expect((await cache.get(SCRIPT_TTL_MS))?.body.toString()).toBe('v1');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    // After a failure the next try waits.
    await cache.get(SCRIPT_TTL_MS + SCRIPT_RETRY_MS - 1);
    expect(calls).toBe(2);
    fail = false;
    await cache.get(SCRIPT_TTL_MS + SCRIPT_RETRY_MS);
    await new Promise((r) => setTimeout(r, 0));
    expect((await cache.get(SCRIPT_TTL_MS + SCRIPT_RETRY_MS + 1))?.body.toString()).toBe('v3');
  });

  it('shares one fetch between concurrent first requests', async () => {
    let calls = 0;
    const upstream: Upstream = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { status: 200, type: 'text/javascript', body: Buffer.from(SCRIPT) };
    };
    const cache = new ScriptCache('http://umami.invalid/script.js', upstream, 1000, log);
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(calls).toBe(1);
  });
});

describe('POST /pulse/api/send', () => {
  let page: PublicPageSettings;
  let app: FastifyInstance;
  beforeEach(async () => {
    page = settings(ON);
    app = await proxyApp(() => page, { sendTimeoutMs: 200 });
  });
  afterEach(() => app.close());

  it("forwards the event with the visitor's user agent, and Umami's answer back", async () => {
    const res = await send(app, event(), {
      cookie: 'osp-theme=dark; session=secret',
      'x-umami-cache': 'a.b.c',
      'x-forwarded-for': '203.0.113.9',
      'accept-language': 'de',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cache: 'header.payload.signature' });
    expect(res.headers['cache-control']).toBe('no-store');
    const [got] = umami.received;
    expect(got!.url).toBe('/api/send');
    expect(got!.body).toEqual(event());
    expect(got!.headers['user-agent']).toBe('Mozilla/5.0 Test');
    expect(got!.headers['x-umami-cache']).toBe('a.b.c');
    expect(got!.headers['content-type']).toBe('application/json');
    // Never cookies, and by default no IP address of the visitor.
    expect(got!.headers['accept-language']).not.toBe('de');
    for (const name of ['cookie', 'x-forwarded-for', 'x-real-ip', 'forwarded']) {
      expect(got!.headers[name], name).toBeUndefined();
    }
  });

  it('passes the IP address only when the settings allow it', async () => {
    page = settings({ ...ON, analyticsForwardIp: true });
    expect((await send(app, event(), { 'x-forwarded-for': '203.0.113.9' })).statusCode).toBe(200);
    // The client address as Fastify sees it (TRUST_PROXY decides), never the header the client sent.
    expect(umami.received[0]!.headers['x-forwarded-for']).toBe('127.0.0.1');
  });

  it('drops events of another website, of personal pages and malformed ones', async () => {
    for (const body of [
      event({ website: '00000000-0000-4000-8000-000000000000' }),
      event({ url: '/subscription/manage?id=1&token=abc' }),
      event({ url: `${BASE_URL}/SUBSCRIPTION/confirm?id=1` }),
      { type: 'event' },
      { type: 'other', payload: event().payload },
      [event()],
    ]) {
      expect((await send(app, body)).statusCode, JSON.stringify(body)).toBe(204);
    }
    expect(umami.received).toEqual([]);
  });

  it('removes tokens from page and referrer URLs', async () => {
    await send(app, event({ url: '/history?token=abc&type=incident', referrer: `${BASE_URL}/subscription/manage?id=1&token=abc` }));
    await send(app, event({ url: '/', referrer: 'https://mail.example.com/read?Token=x&id=2' }));
    expect(umami.received.map((r) => (r.body as { payload: { url: string; referrer: string } }).payload)).toMatchObject([
      { url: '/history?type=incident', referrer: `${BASE_URL}/` },
      { url: '/', referrer: 'https://mail.example.com/read' },
    ]);
  });

  it('removes fragments, tokens in custom data and fields the tracker never sends', async () => {
    await send(
      app,
      event({ url: '/history?a=1#token=3', referrer: 'https://ex.com/r?id=7#token=1', data: { token: 's', step: 2 }, cookie: 'x', ip: '1.2.3.4' }),
    );
    const { payload } = umami.received[0]!.body as { payload: Record<string, unknown> };
    expect(payload).toEqual({
      website: WEBSITE,
      hostname: 'status.example.com',
      url: '/history?a=1',
      referrer: 'https://ex.com/r?id=7',
      title: 'History',
      data: { step: 2 },
    });
    expect((await send(app, event({ data: 'token=1' }))).statusCode).toBe(204);
  });

  it('sends nothing for Do Not Track and Global Privacy Control unless told otherwise', async () => {
    expect((await send(app, event(), { dnt: '1' })).statusCode).toBe(204);
    expect((await send(app, event(), { 'sec-gpc': '1' })).statusCode).toBe(204);
    expect(umami.received).toEqual([]);
    page = settings({ ...ON, analyticsRespectDnt: false });
    expect((await send(app, event(), { dnt: '1' })).statusCode).toBe(200);
  });

  it('drops events while analytics is off in the settings', async () => {
    page = settings();
    expect((await send(app, event())).statusCode).toBe(204);
    expect(umami.received).toEqual([]);
  });

  it('accepts only JSON of limited size', async () => {
    expect((await send(app, JSON.stringify(event()), { 'content-type': 'text/plain' })).statusCode).toBe(415);
    expect((await send(app, 'a=1', { 'content-type': 'application/x-www-form-urlencoded' })).statusCode).toBe(415);
    const big = event({ data: { x: 'x'.repeat(SEND_BODY_LIMIT) } });
    expect((await send(app, big)).statusCode).toBe(413);
    expect((await send(app, '{not json')).statusCode).toBe(400);
    expect(umami.received).toEqual([]);
  });

  it('answers 204 at once when Umami fails, is slow or redirects, without its details', async () => {
    umami.send = (_req, reply) => reply.status(500).send({ error: 'database password wrong' });
    let res = await send(app, event());
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    umami.send = (_req, reply) => reply.redirect(`${elsewhere.url}/api/send`, 307);
    expect((await send(app, event())).statusCode).toBe(204);
    expect(elsewhere.received).toEqual([]);

    umami.send = async (_req, reply) => {
      await new Promise((r) => setTimeout(r, 1000));
      return reply.send({});
    };
    const started = Date.now();
    res = await send(app, event());
    expect(res.statusCode).toBe(204);
    expect(Date.now() - started).toBeLessThan(900);

    // Headers at once, then the answer stalls: cut off at the timeout, never passed on half.
    umami.send = (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'application/json' });
      reply.raw.write('{"cache":');
    };
    const stalled = Date.now();
    res = await send(app, event());
    expect(res.statusCode).toBe(204);
    expect(Date.now() - stalled).toBeLessThan(900);
  });

  it('forwards at most a few events at a time, and fewer per client', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    umami.send = async (_req, reply) => {
      await gate;
      return reply.send({});
    };
    const slow = await proxyApp(() => page, { sendTimeoutMs: 5000 });
    const held = async (n: number) => {
      for (let i = 0; i < 100 && umami.received.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    };
    try {
      // One client: its excess events are dropped at once, without waiting for Umami.
      const own = Array.from({ length: MAX_IN_FLIGHT_PER_CLIENT }, () => send(slow, event(), {}, '198.51.100.1'));
      await held(MAX_IN_FLIGHT_PER_CLIENT);
      expect((await send(slow, event(), {}, '198.51.100.1')).statusCode).toBe(204);
      // Other clients still get through, up to the limit of the instance.
      const others = Array.from({ length: MAX_IN_FLIGHT - MAX_IN_FLIGHT_PER_CLIENT }, (_, i) => send(slow, event(), {}, `198.51.100.${10 + i}`));
      await held(MAX_IN_FLIGHT);
      expect((await send(slow, event(), {}, '198.51.100.99')).statusCode).toBe(204);
      release();
      expect((await Promise.all([...own, ...others])).map((r) => r.statusCode)).toEqual(Array(MAX_IN_FLIGHT).fill(200));
      expect(umami.hits('/api/send')).toBe(MAX_IN_FLIGHT);
      // The slots are free again.
      expect((await send(slow, event(), {}, '198.51.100.1')).statusCode).toBe(200);
    } finally {
      release();
      await slow.close();
    }
  });

  it("passes on the plain-text session token of older Umami versions, nothing else", async () => {
    umami.send = (_req, reply) => reply.type('text/plain').send('header.payload.signature');
    const res = await send(app, event());
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.body).toBe('header.payload.signature');

    for (const [type, body] of [
      ['text/plain', '<script>alert(1)</script>'],
      ['text/html', 'header.payload.signature'],
    ]) {
      umami.send = (_req, reply) => reply.type(type!).send(body);
      const other = await send(app, event());
      expect(other.statusCode, type).toBe(204);
      expect(other.body).toBe('');
    }
  });
});

describe('cleanEvent', () => {
  it('keeps absolute page URLs absolute and paths paths', () => {
    expect(cleanEvent(event({ url: `${BASE_URL}/x?token=1#a` }), WEBSITE, BASE_URL)?.payload.url).toBe(`${BASE_URL}/x`);
    expect(cleanEvent(event({ url: '/x?a=1' }), WEBSITE, BASE_URL)?.payload.url).toBe('/x?a=1');
    expect(cleanEvent(event({ website: WEBSITE.toUpperCase() }), WEBSITE, BASE_URL)).not.toBeNull();
    expect(cleanEvent(event({ url: 42 }), WEBSITE, BASE_URL)).toBeNull();
  });
});

describe('rate limit of the proxy routes', () => {
  it('limits events per client', async () => {
    const t = await createTestApp({ UMAMI_URL: umami.url }, { web: { dir: web.dir, ssrModule: renderFromSource } });
    try {
      await saveSettings(t.db, settings(ON));
      umami.send = (_req, reply) => reply.send({});
      const codes = new Set<number>();
      for (let i = 0; i < 125; i++) codes.add((await send(t.app, event())).statusCode);
      expect([...codes].sort()).toEqual([200, 429]);
    } finally {
      await t.close();
    }
  });
});

// --- Rendered pages and the opt-out ----------------------------------------------

const TAG = new RegExp(
  `<script defer src="/pulse/p\\.js" data-website-id="${WEBSITE}" data-host-url="/pulse" data-exclude-hash="true"( data-domains="[^"]*")?( data-do-not-track="true")?></script>`,
);

describe.each(['all', 'public'])('analytics on rendered pages (APP_ROLE=%s)', (role) => {
  let t: TestApp;
  const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers });

  async function start(env: Record<string, string>, page: Partial<PublicPageSettings>) {
    t = await createTestApp({ APP_ROLE: role, ...env }, { web: { dir: web.dir, ssrModule: renderFromSource } });
    await saveSettings(t.db, settings(page));
  }
  afterEach(() => t.close());

  it('carry the deferred script tag in the head when analytics is on', async () => {
    await start({ UMAMI_URL: umami.url }, { ...ON, analyticsDomains: 'status.example.com' });
    const res = await get('/');
    const head = /<head>[\s\S]*<\/head>/.exec(res.body)?.[0] ?? '';
    expect(head).toMatch(TAG);
    expect(head).toContain('data-domains="status.example.com" data-do-not-track="true"');
    // Never a script from another origin: the CSP stays 'self'.
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(res.headers.vary).toContain('Cookie');
    // The footer offers to turn it off.
    const footer = /<footer[\s\S]*<\/footer>/.exec(rootOf(res))?.[0] ?? '';
    expect(footer).toContain('<nav aria-label="Legal">');
    expect(footer).toContain('action="/preferences/analytics"');
    expect(footer).toContain('name="analytics" value="off"');
    expect(footer).toContain('Disable statistics');
  });

  it('leave out Do Not Track and domains when not configured', async () => {
    await start({ UMAMI_URL: umami.url }, { ...ON, analyticsRespectDnt: false });
    const tag = TAG.exec((await get('/history')).body);
    expect(tag?.[0]).toBe(
      `<script defer src="/pulse/p.js" data-website-id="${WEBSITE}" data-host-url="/pulse" data-exclude-hash="true"></script>`,
    );
  });

  it('carry no script without UMAMI_URL or with analytics off', async () => {
    await start({}, ON);
    let res = await get('/');
    expect(res.body).not.toContain('/pulse/');
    expect(rootOf(res)).not.toContain('aria-label="Legal"');
    await t.close();
    await start({ UMAMI_URL: umami.url }, {});
    res = await get('/');
    expect(res.body).not.toContain('/pulse/');
  });

  it('carry no script on subscription links', async () => {
    await start({ UMAMI_URL: umami.url }, { ...ON, emailSubscriptionsEnabled: true });
    expect((await get('/subscribe')).body).toMatch(TAG);
    for (const url of ['/subscription/manage?id=x&token=abc', '/subscription/confirm?id=x&token=abc', '/Subscription/manage']) {
      expect((await get(url)).body, url).not.toContain('/pulse/');
    }
  });

  it('carry no script for visitors who opted out, and the cache never mixes both', async () => {
    await start({ UMAMI_URL: umami.url }, ON);
    const optedOut = { cookie: 'osp-theme=dark; osp-analytics=off' };
    // Rendered with the script first, then within the cache lifetime for an opted-out visitor.
    expect((await get('/services')).body).toMatch(TAG);
    const off = await get('/services', optedOut);
    expect(off.body).not.toContain('/pulse/');
    expect(rootOf(off)).toContain('Statistics are disabled.');
    expect(rootOf(off)).toContain('name="analytics" value="on"');
    expect(off.body).toContain('"analyticsOff":true');
    // And the other way round, from the cache.
    expect((await get('/services', optedOut)).body).not.toContain('/pulse/');
    expect((await get('/services')).body).toMatch(TAG);
    expect((await get('/services', { cookie: 'osp-theme=dark' })).body).toMatch(TAG);
  });
});

describe('POST /preferences/analytics', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp({}, { web: { dir: web.dir, ssrModule: renderFromSource } });
  });
  afterEach(() => t.close());

  const post = (body: string, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) =>
    t.app.inject({
      method: 'POST',
      url: '/preferences/analytics',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload: body,
    });

  it('sets the opt-out cookie and sends the visitor back', async () => {
    const res = await post('analytics=off&return=%2Fhistory%3Ftype%3Dincident');
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/history?type=incident');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(String(res.headers['set-cookie'])).toMatch(/^osp-analytics=off; Path=\/; Max-Age=\d{8}; SameSite=Lax$/);
  });

  it('removes the cookie to turn analytics on again', async () => {
    const res = await post('analytics=on&return=/');
    expect(res.statusCode).toBe(303);
    expect(String(res.headers['set-cookie'])).toBe('osp-analytics=; Path=/; Max-Age=0; SameSite=Lax');
  });

  it('ignores other values, never redirects elsewhere and rejects other sites', async () => {
    const odd = await post('analytics=maybe&return=//evil.example');
    expect(odd.headers['set-cookie']).toBeUndefined();
    expect(odd.headers.location).toBe('/');
    for (const headers of <Record<string, string>[]>[{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://evil.example' }]) {
      const res = await post('analytics=off&return=/', headers);
      expect(res.statusCode).toBe(403);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });
});

describe('analytics settings over JSON:API', () => {
  it('validate the website ID and the domains, and need UMAMI_URL to be reported as enabled', async () => {
    const t = await createTestApp({ UMAMI_URL: `${umami.url}/` });
    try {
      const admin = await adminClient(t);
      expect(t.config.UMAMI_URL).toBe(umami.url);
      for (const [attrs, field] of <[Record<string, unknown>, string][]>[
        [{ analyticsEnabled: true }, 'analyticsWebsiteId'],
        [{ analyticsWebsiteId: 'not-a-uuid' }, 'analyticsWebsiteId'],
        [{ analyticsDomains: 'https://status.example.com' }, 'analyticsDomains'],
        [{ analyticsForwardIp: 'yes' }, 'analyticsForwardIp'],
      ]) {
        const res = await admin.patch('/api/admin/settings', attrs);
        expect(res.statusCode, JSON.stringify(attrs)).toBe(400);
        expect(errors(res)[0]).toMatchObject({ source: { pointer: `/data/attributes/${field}` } });
      }
      const saved = await admin.patch('/api/admin/settings', { ...ON, analyticsDomains: 'Status.Example.com ' });
      expect(saved.statusCode).toBe(200);
      expect(data(saved)).toMatchObject({ ...ON, analyticsDomains: 'status.example.com', analyticsRespectDnt: true, analyticsForwardIp: false });
      expect(data(await t.app.inject({ method: 'GET', url: '/api/public/settings' }))).toMatchObject(ON);
    } finally {
      await t.close();
    }
  });

  it('tell the management UI whether the instance has UMAMI_URL, read-only', async () => {
    for (const [extra, available] of [
      [{ UMAMI_URL: umami.url }, true],
      [{}, false],
    ] as const) {
      const t = await createTestApp(extra);
      try {
        const admin = await adminClient(t);
        expect(data(await admin.get('/api/admin/settings')), JSON.stringify(extra)).toMatchObject({ analyticsAvailable: available });
        const saved = await admin.patch('/api/admin/settings', { ...ON, analyticsAvailable: !available });
        expect(saved.statusCode).toBe(200);
        expect(data(saved)).toMatchObject({ ...ON, analyticsAvailable: available });
        expect(data(await t.app.inject({ method: 'GET', url: '/api/public/settings' }))).not.toHaveProperty('analyticsAvailable');
      } finally {
        await t.close();
      }
    }
  });

  it('reject an UMAMI_URL that is no http(s) base URL', async () => {
    for (const url of ['ftp://umami.example.com', 'umami.example.com', 'https://umami.example.com/?x=1']) {
      await expect(createTestApp({ UMAMI_URL: url }), url).rejects.toThrow(/UMAMI_URL/);
    }
  });
});
