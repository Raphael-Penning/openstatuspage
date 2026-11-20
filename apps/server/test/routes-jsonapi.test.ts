/**
 * Walks every registered route and checks that JSON responses are JSON:API
 * documents. The only routes outside JSON:API are the documented non-JSON:API
 * endpoints (health check, feeds, crawler files, OIDC and the unsubscribe redirect).
 */
import { JSONAPI_MEDIA_TYPE } from '@openstatuspage/shared';
import type { HTTPMethods, LightMyRequestResponse, RouteOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminClient, createTestApp, data, seedChecks, type Client, type TestApp } from './helpers.js';

/** Routes that are not JSON:API on purpose (see docs/api.md). */
const NON_JSONAPI = [
  'GET /api/health',
  'GET /api/public/subscriptions/:id/unsubscribe',
  'GET /api/auth/oidc/login',
  'GET /api/auth/oidc/callback',
  'GET /feed.rss',
  'GET /feed.atom',
  'GET /robots.txt',
  'GET /sitemap.xml',
  'GET /sitemap-pages.xml',
  'GET /sitemap-incidents-:page.xml',
  'GET /sitemap-services-:page.xml',
  'GET /llms.txt',
  'GET /llms-full.txt',
];

/** Non-JSON:API routes whose successful answer is plain JSON. */
const PLAIN_JSON = new Set(['GET /api/health']);

/** Requests that end the admin session run last. */
const LAST = new Set(['POST /api/auth/logout']);

const METHOD_ORDER: HTTPMethods[] = ['GET', 'POST', 'PATCH', 'DELETE'];

interface Route {
  method: HTTPMethods;
  url: string;
  jsonapi: boolean;
  native: boolean;
}

let t: TestApp;
let admin: Client;
let routes: Route[];
const ids: Record<string, string> = {};

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function seed(): Promise<void> {
  const created = async (url: string, body: Record<string, unknown>) => {
    const res = await admin.post(url, body);
    expect(res.statusCode, `${url}: ${res.body}`).toBe(201);
    return data<{ id: string; [key: string]: unknown }>(res);
  };
  ids['service-groups'] = (await created('/api/admin/service-groups', { name: 'Platform' })).id;
  ids.locations = (await created('/api/admin/locations', { name: 'Frankfurt', region: 'europe' })).id;
  ids.services = (await created('/api/admin/services', { name: 'API' })).id;
  const incident = await created('/api/admin/incidents', { title: 'Slow', message: 'Investigating' });
  ids.incidents = incident.id;
  ids['incidents/updates'] = (incident.updateIds as string[])[0]!;
  const maintenance = await created('/api/admin/maintenances', {
    title: 'Upgrade',
    scheduledStart: iso(3_600_000),
    scheduledEnd: iso(7_200_000),
    serviceIds: [ids.services],
  });
  ids.maintenances = maintenance.id;
  ids['maintenances/updates'] = (maintenance.updateIds as string[])[0] ?? 'missing';
  ids.corrections = (
    await created('/api/admin/corrections', {
      serviceIds: [ids.services],
      startsAt: iso(-7_200_000),
      endsAt: iso(-3_600_000),
      status: 'operational',
      reason: 'False alarm',
    })
  ).id;
  const source = await created('/api/admin/monitor-sources', { name: 'Hook', sourceType: 'webhook', config: {} });
  ids['monitor-sources'] = source.id;
  const { checkIds } = await seedChecks(t, [{ externalId: 'web', name: 'Web', host: 'web1', state: 'ok' }]);
  ids.checks = checkIds.web!;
  ids['check-bundles'] = (await created('/api/admin/check-bundles', { name: 'Bundle', members: [{ checkId: ids.checks }] })).id;
  ids.users = (await created('/api/admin/users', { email: 'editor@example.com', name: 'Editor', role: 'editor' })).id;
  ids['api-tokens'] = (await created('/api/admin/api-tokens', { name: 'CI', role: 'editor' })).id;
}

/** Fills the path parameters with the seeded resource of the preceding segment ("missing" otherwise). */
function concreteUrl(url: string): string {
  const parts = url.split('/');
  return parts
    .map((part, i) => {
      if (!part.startsWith(':')) return part;
      if (part === ':sourceId') return ids['monitor-sources']!;
      if (part === ':type') return 'webhook';
      const collection = parts[i - 1] ?? '';
      const parent = parts[i - 3] ?? '';
      return ids[`${parent}/${collection}`] ?? (part === ':importId' ? 'missing' : (ids[collection] ?? 'missing'));
    })
    .join('/');
}

function request(route: Route): Promise<LightMyRequestResponse> {
  const url = concreteUrl(route.url);
  if (route.method === 'GET') return admin.get(url);
  if (route.method === 'DELETE') return admin.delete(url);
  if (route.native) {
    return t.app.inject({ method: route.method, url, headers: { 'content-type': 'application/json' }, payload: '{}' });
  }
  return route.method === 'PATCH' ? admin.patch(url, {}) : admin.post(url, {});
}

beforeEach(async () => {
  const registered: RouteOptions[] = [];
  t = await createTestApp({}, { onRoute: (route) => registered.push(route) });
  routes = registered.flatMap((route) => {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]) as HTTPMethods[];
    const config = (route.config ?? {}) as { jsonapi?: { requestBody?: string } };
    return methods
      .filter((m) => m !== 'HEAD')
      .map((method) => ({
        method,
        url: route.url,
        jsonapi: config.jsonapi !== undefined,
        native: config.jsonapi?.requestBody === 'native',
      }));
  });
  admin = await adminClient(t);
  await seed();
});
afterEach(async () => {
  await t.close();
});

describe('registered routes', () => {
  it('are JSON:API routes, except the documented non-JSON:API endpoints', () => {
    expect(routes.length).toBeGreaterThan(50);
    const plain = routes.filter((r) => !r.jsonapi).map((r) => `${r.method} ${r.url}`);
    expect(plain.sort()).toEqual([...NON_JSONAPI].sort());
  });

  it('answer JSON with the JSON:API media type and document', async () => {
    const key = (r: Route) => `${r.method} ${r.url}`;
    const ordered = [...routes].sort(
      (a, b) =>
        Number(LAST.has(key(a))) - Number(LAST.has(key(b))) ||
        METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
    );
    const checked: string[] = [];
    for (const route of ordered) {
      const res = await request(route);
      const label = `${key(route)} → ${res.statusCode}`;
      const type = String(res.headers['content-type'] ?? '');
      if (res.statusCode === 204) {
        expect(res.body, label).toBe('');
        continue;
      }
      if (!type.includes('json')) {
        // Feeds, redirects and HTML: only allowed on the non-JSON:API routes.
        expect(route.jsonapi, label).toBe(false);
        continue;
      }
      if (PLAIN_JSON.has(key(route)) && res.statusCode < 400) continue;
      expect(type, label).toBe(JSONAPI_MEDIA_TYPE);
      const body = res.json() as Record<string, unknown>;
      expect(body.jsonapi, label).toEqual({ version: '1.1' });
      expect('data' in body || 'meta' in body || 'errors' in body, label).toBe(true);
      if (res.statusCode >= 400) expect(body.errors, label).toEqual(expect.arrayContaining([expect.objectContaining({ status: String(res.statusCode) })]));
      checked.push(label);
    }
    // Most routes answer with a document (seeded resources make the GETs succeed).
    expect(checked.filter((l) => / → 2\d\d$/.test(l)).length).toBeGreaterThan(30);
  });

  it('answer include and sort with 400 unless the route supports them', async () => {
    const gets = routes.filter((r) => r.jsonapi && r.method === 'GET');
    expect(gets.length).toBeGreaterThan(30);
    for (const route of gets) {
      const url = concreteUrl(route.url);
      for (const [parameter, code] of [
        ['include', 'unsupported_include'],
        ['sort', 'unsupported_sort'],
      ] as const) {
        // "x" is no include path and no sort field of any route.
        const res = await admin.get(`${url}?${parameter}=x`);
        const label = `GET ${route.url}?${parameter}=x → ${res.statusCode}`;
        expect(res.statusCode, label).toBe(400);
        expect(res.json().errors[0], label).toMatchObject({ code, source: { parameter } });
      }
    }
  });

  it('answers errors of the non-JSON:API routes as JSON:API error documents', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/public/subscriptions/missing/unsubscribe' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe(JSONAPI_MEDIA_TYPE);
    expect(res.json()).toMatchObject({ jsonapi: { version: '1.1' }, errors: [{ status: '404' }] });
  });

  it('answers errors of the feeds as JSON:API error documents', async () => {
    const wrongMethod = await t.app.inject({ method: 'POST', url: '/feed.rss' });
    expect(wrongMethod.statusCode).toBe(404);
    expect(wrongMethod.headers['content-type']).toBe(JSONAPI_MEDIA_TYPE);
    expect(wrongMethod.json()).toMatchObject({ jsonapi: { version: '1.1' }, errors: [{ status: '404' }] });

    const spy = vi.spyOn(t.app.ctx.db, 'selectFrom').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    try {
      for (const url of ['/api/public/status', '/feed.atom']) {
        const res = await t.app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(500);
        expect(res.headers['content-type'], url).toBe(JSONAPI_MEDIA_TYPE);
        expect(res.json(), url).toEqual({
          jsonapi: { version: '1.1' },
          errors: [{ status: '500', code: 'internal_error', title: 'Internal Server Error', detail: 'Internal server error' }],
        });
      }
    } finally {
      spy.mockRestore();
    }
  });
});
