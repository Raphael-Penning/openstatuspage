/**
 * The OpenAPI description (src/openapi): a valid OpenAPI 3.1 document, the same
 * as the committed docs/openapi.json, complete (every registered route is
 * described or listed in NON_API_ROUTES) and in step with the routes (JSON:API
 * types, relationships, include support, rate limits, roles, filters); plus the
 * endpoint GET /api/openapi.json and what each role and client gets from it.
 */
import { readFileSync } from 'node:fs';
import { JSONAPI_MEDIA_TYPE } from '@openstatuspage/shared';
import { Validator } from '@seriousme/openapi-schema-validator';
import type { HTTPMethods, RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appVersion } from '../src/lib/version.js';
import {
  API_DESCRIPTION_VERSION,
  buildOpenApiDocument,
  isPublicOperation,
  openApiPath,
  operationId,
  serializeOpenApiDocument,
  type OpenApiDocument,
} from '../src/openapi/document.js';
import { NON_API_ROUTES, OPERATIONS, type Operation } from '../src/openapi/operations.js';
import type { JsonApiRouteConfig } from '../src/plugins/jsonapi.js';
import { adminClient, client, createTestApp, createUser, data, login, type TestApp } from './helpers.js';
import { createWebDir, renderFromSource } from './web-fixture.js';

const OPENAPI_FILE = new URL('../../../docs/openapi.json', import.meta.url);

const key = (op: { method: string; path: string }) => `${op.method} ${op.path}`;

interface RegisteredRoute {
  method: HTTPMethods;
  url: string;
  /** The route options: plugin scopes set their config after the route is announced (useJsonApi). */
  route: RouteOptions;
}

type RouteConfig = { jsonapi?: JsonApiRouteConfig; rateLimit?: { max?: number } };
const configOf = (r: RegisteredRoute) => (r.route.config ?? {}) as RouteConfig;

/** Every route of an `all` instance with the web client, server-side rendering and the analytics proxy. */
async function registeredRoutes(): Promise<{ routes: RegisteredRoute[]; webFiles: Set<string> }> {
  const routes: RegisteredRoute[] = [];
  const web = createWebDir();
  try {
    const t = await createTestApp(
      { UMAMI_URL: 'https://umami.example.com' },
      {
        web: { dir: web.dir, ssrModule: renderFromSource },
        onRoute: (route: RouteOptions) => {
          for (const method of [route.method].flat() as HTTPMethods[]) {
            if (method !== 'HEAD') routes.push({ method, url: route.url, route });
          }
        },
      },
    );
    await t.close();
    // The files of the web build that @fastify/static registers as routes (index.html, assets).
    const webFiles = new Set(['/index.html', '/public.html', '/assets/index.js', '/assets/public.js', '/assets/shared.js', '/assets/shared.css']);
    return { routes, webFiles };
  } finally {
    web.remove();
  }
}

async function validate(doc: OpenApiDocument) {
  const validator = new Validator();
  const result = await validator.validate(structuredClone(doc));
  return { valid: result.valid, errors: result.errors, version: validator.version };
}

describe('the OpenAPI document', () => {
  const full = buildOpenApiDocument('full');
  const pub = buildOpenApiDocument('public');

  it('is a valid OpenAPI 3.1 document, in both scopes', async () => {
    for (const doc of [full, pub]) {
      const result = await validate(doc);
      expect(result.errors).toBeUndefined();
      expect(result.valid).toBe(true);
      expect(result.version).toBe('3.1');
    }
  });

  it('equals the committed docs/openapi.json (run pnpm openapi:generate)', () => {
    expect(readFileSync(OPENAPI_FILE, 'utf8')).toBe(serializeOpenApiDocument(full));
  });

  it('has a unique operationId per operation', () => {
    const ids = OPERATIONS.map(operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(OPERATIONS.map(key)).size).toBe(OPERATIONS.length);
  });

  it('describes the public part only in the public scope', () => {
    const paths = Object.keys(pub.paths);
    expect(paths).toContain('/api/public/status');
    expect(paths).toContain('/api/openapi.json');
    expect(paths.filter((p) => /^\/api\/(admin|auth|ingest)/.test(p))).toEqual([]);
    expect(Object.keys(pub.components.securitySchemes).sort()).toEqual(['privatePageToken', 'subscriptionToken', 'subscriptionTokenQuery']);
    expect(Object.keys(pub.components.schemas)).not.toContain('LoginInput');
    expect(Object.keys(pub.components.schemas)).not.toContain('MonitorSourceInput');
    const operations = Object.values(pub.paths).flatMap((p) => Object.values(p));
    expect(operations.some((op) => 'x-required-role' in op)).toBe(false);
  });

  it('reveals no server version, no secrets and no system-specific URLs', () => {
    for (const doc of [full, pub]) {
      const text = JSON.stringify(doc);
      expect((doc.info as { version: string }).version).toBe(API_DESCRIPTION_VERSION);
      expect(doc.servers).toEqual([{ url: '/', description: 'This instance' }]);
      expect(text).not.toContain(`"${appVersion()}"`);
      // Absolute URLs only to the specifications and to example.com placeholders.
      const hosts = new Set([...text.matchAll(/https?:\/\/([^/"\s)`]+)/g)].map((m) => m[1]));
      for (const host of hosts) expect(host, host).toMatch(/(^|\.)example\.com$|^jsonapi\.org$/);
      expect(text).not.toMatch(/osp_[A-Za-z0-9]{8,}/);
    }
  });

  it('marks admin-only operations and lists the credentials of every protected one', () => {
    const op = full.paths['/api/admin/users']!.post as { 'x-required-role': string; security: unknown[]; description: string };
    expect(op['x-required-role']).toBe('admin');
    expect(op.description).toContain('Admin only');
    expect(op.security).toEqual([{ sessionCookie: [], csrfHeader: [] }, { apiToken: [] }]);
    const read = full.paths['/api/admin/incidents']!.get as { 'x-required-role': string; security: unknown[] };
    expect(read['x-required-role']).toBe('editor');
    expect(read.security).toEqual([{ sessionCookie: [] }, { apiToken: [] }]);
    expect(full.paths['/api/ingest/{sourceId}']!.post!.security).toEqual([{ ingestToken: [] }, { ingestTokenQuery: [] }]);
    expect(full.paths['/api/public/subscriptions/{id}']!.get!.security).toEqual([{ subscriptionToken: [] }]);
  });

  it('marks the optional credentials of the API description only in the full scope', () => {
    expect(full.paths['/api/openapi.json']!.get!.security).toEqual([{}, { sessionCookie: [] }, { apiToken: [] }]);
    expect(pub.paths['/api/openapi.json']!.get!.security).toBeUndefined();
  });

  it('documents JSON:API envelopes, errors and rate limits', () => {
    const create = full.paths['/api/admin/services']!.post as Record<string, any>;
    expect(Object.keys(create.requestBody.content)).toEqual([JSONAPI_MEDIA_TYPE]);
    expect(create.requestBody.content[JSONAPI_MEDIA_TYPE].schema.properties.data.properties.type).toEqual({ const: 'services' });
    expect(create.requestBody.content[JSONAPI_MEDIA_TYPE].schema.properties.data.properties.attributes).toEqual({ $ref: '#/components/schemas/ServiceInput' });
    expect(Object.keys(create.responses)).toEqual(['201', '400', '401', '403', '406', '409', '413', '415']);
    const upload = full.paths['/api/admin/uploads']!.post as Record<string, any>;
    expect(Object.keys(upload.requestBody.content)).toEqual(['application/octet-stream']);
    expect(upload.responses['413']).toEqual({ $ref: '#/components/responses/PayloadTooLarge' });
    // 201 for new bytes, 200 for bytes already stored; only the 201 carries a Location.
    expect(Object.keys(upload.responses).slice(0, 2)).toEqual(['200', '201']);
    expect(upload.responses['200'].headers).toBeUndefined();
    expect(upload.responses['201'].headers.Location).toBeDefined();
    expect(upload['x-rate-limit']).toEqual({ max: 30, window: '1 minute', per: 'client IP address' });
    const login = full.paths['/api/auth/login']!.post as Record<string, any>;
    expect(login.responses['429']).toEqual({ $ref: '#/components/responses/TooManyRequests' });
    const history = full.paths['/api/public/history']!.get as Record<string, any>;
    expect(history.parameters.map((p: { name: string }) => p.name)).toEqual([
      'include',
      'page[number]',
      'page[size]',
      'filter[type]',
      'filter[service]',
      'filter[location]',
      'filter[month]',
    ]);
    // The attribute schemas are the zod schemas of packages/shared.
    expect((full.components.schemas.ServiceInput as { required: string[] }).required).toEqual(['name']);
    expect(full.components.schemas.ServiceInputPartial).not.toHaveProperty('required');
  });
});

describe('the operations and the registered routes', () => {
  let routes: RegisteredRoute[];
  let webFiles: Set<string>;
  beforeAll(async () => {
    ({ routes, webFiles } = await registeredRoutes());
  });

  const byKey = () => new Map(routes.map((r) => [`${r.method} ${r.url}`, r]));

  it('describe every registered route, apart from the documented exclusions', () => {
    const described = new Set(OPERATIONS.map(key));
    const excluded = new Set(NON_API_ROUTES.map((r) => r.route));
    const missing = routes
      .filter((r) => !webFiles.has(r.url))
      .map((r) => `${r.method} ${r.url}`)
      .filter((r) => !described.has(r) && !excluded.has(r));
    expect(missing).toEqual([]);
  });

  it('describe no route that does not exist, and exclude none that is described', () => {
    const registered = byKey();
    expect(OPERATIONS.map(key).filter((k) => !registered.has(k))).toEqual([]);
    expect(NON_API_ROUTES.map((r) => r.route).filter((k) => !registered.has(k))).toEqual([]);
    const described = new Set(OPERATIONS.map(key));
    expect(NON_API_ROUTES.filter((r) => described.has(r.route))).toEqual([]);
    for (const route of NON_API_ROUTES) expect(route.reason.length).toBeGreaterThan(0);
  });

  it('agree on JSON:API, request types, relationships, include and rate limits', () => {
    const registered = byKey();
    for (const op of OPERATIONS) {
      const config = configOf(registered.get(key(op))!);
      const jsonapi = config.jsonapi;
      const label = key(op);
      expect(jsonapi !== undefined, `${label}: JSON:API`).toBe(op.jsonapi !== false);
      expect(Boolean(jsonapi?.include), `${label}: include`).toBe(op.include !== undefined);
      const native = op.request?.kind === 'native' || op.request?.kind === 'binary';
      if (jsonapi) expect(jsonapi.requestBody === 'native', `${label}: native body`).toBe(native || (op.path.startsWith('/api/ingest/') && !op.request));
      if (op.request?.kind === 'resource') {
        expect(jsonapi?.type, `${label}: type`).toBe(op.request.enforced === false ? undefined : op.request.type);
        expect(jsonapi?.relationships, `${label}: relationships`).toEqual(op.request.relationships);
        expect(Boolean(jsonapi?.allowId), `${label}: allowId`).toBe(Boolean(op.request.allowId));
      } else if (jsonapi) {
        expect(jsonapi.type, `${label}: no request document`).toBeUndefined();
      }
      const limit = config.rateLimit?.max;
      if (op.rateLimit?.routeConfig) expect(limit, `${label}: rate limit`).toBe(op.rateLimit.max);
      else expect(limit, `${label}: rate limit`).toBeUndefined();
    }
  });

  it('put every public role route in the public scope', () => {
    const publicOps = OPERATIONS.filter(isPublicOperation).map((op) => openApiPath(op.path));
    expect(publicOps.length).toBeGreaterThan(20);
    expect(publicOps.every((p) => !p.startsWith('/api/admin'))).toBe(true);
  });
});

describe('the roles of the operations', () => {
  let t: TestApp;
  let editorToken: string;
  beforeAll(async () => {
    t = await createTestApp();
    const admin = await adminClient(t);
    const res = await admin.post('/api/admin/api-tokens', { name: 'Editor', role: 'editor' });
    expect(res.statusCode).toBe(201);
    editorToken = data<{ token: string }>(res).token;
  });
  afterAll(async () => {
    await t.close();
  });

  const concrete = (op: Operation) => op.path.replace(/:sourceId|:id|:incidentId|:maintenanceId|:importId/g, 'missing');

  it('are what the routes enforce: editors get 403 exactly on admin-only operations, anonymous clients 401', async () => {
    // Without a body: request documents are checked before the role (a wrong type would be 409).
    const send = (op: Operation, headers: Record<string, string>) => t.app.inject({ method: op.method, url: concrete(op), headers });
    const protectedOps = OPERATIONS.filter((op) => op.access === 'editor' || op.access === 'admin');
    expect(protectedOps.length).toBeGreaterThan(100);
    for (const op of protectedOps) {
      const label = `${key(op)} (${op.access})`;
      expect((await send(op, {})).statusCode, label).toBe(401);
      const status = (await send(op, { authorization: `Bearer ${editorToken}` })).statusCode;
      if (op.access === 'admin') expect(status, label).toBe(403);
      else expect([401, 403], label).not.toContain(status);
    }
  });

  it('take the documented filters', async () => {
    const admin = client(t.app, { cookie: await login(t.app, 'admin@example.com') });
    const values: Record<string, string> = { month: '2026-11', from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z', unlinked: 'true' };
    for (const op of OPERATIONS.filter((o) => o.method === 'GET' && o.filters)) {
      for (const f of op.filters!) {
        const value = values[f.name] ?? ((f.schema.enum as string[] | undefined)?.[0] ?? 'x');
        const res = await admin.get(`${concrete(op)}?filter[${f.name}]=${encodeURIComponent(value)}`);
        const unknown = (res.json() as { errors?: { detail?: string }[] }).errors?.some((e) => e.detail?.startsWith('Unknown filter'));
        expect(unknown, `${key(op)} filter[${f.name}]`).toBeFalsy();
      }
    }
  });
});

describe('GET /api/openapi.json', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await createUser(t.db, { email: 'editor@example.com', role: 'editor' });
  });
  afterAll(async () => {
    await t.close();
  });

  const paths = (body: string) => Object.keys((JSON.parse(body) as OpenApiDocument).paths);

  it('gives anonymous clients the public part, with an ETag and revalidation', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.vary).toBe('Cookie, Authorization');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.json()).toEqual(buildOpenApiDocument('public'));
    expect(paths(res.body).some((p) => p.startsWith('/api/admin'))).toBe(false);
    const etag = String(res.headers.etag);
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);

    const again = await t.app.inject({ method: 'GET', url: '/api/openapi.json', headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers.etag).toBe(etag);
    const head = await t.app.inject({ method: 'HEAD', url: '/api/openapi.json' });
    expect(head.statusCode).toBe(200);
  });

  it('gives signed-in users and API tokens the whole API', async () => {
    const cookie = await login(t.app, 'editor@example.com');
    const res = await t.app.inject({ method: 'GET', url: '/api/openapi.json', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(buildOpenApiDocument('full'));
    expect(res.headers.etag).not.toBe((await t.app.inject({ method: 'GET', url: '/api/openapi.json' })).headers.etag);

    const admin = await adminClient(t, 'owner@example.com');
    const token = data<{ token: string }>(await admin.post('/api/admin/api-tokens', { name: 'Docs', role: 'editor' })).token;
    const viaToken = await t.app.inject({ method: 'GET', url: '/api/openapi.json', headers: { authorization: `Bearer ${token}` } });
    expect(paths(viaToken.body)).toContain('/api/admin/services');
    // An invalid token is anonymous: the public part.
    const invalid = await t.app.inject({ method: 'GET', url: '/api/openapi.json', headers: { authorization: 'Bearer osp_wrong' } });
    expect(paths(invalid.body)).not.toContain('/api/admin/services');
  });

  it('gives every client of a public instance the public part only, and is missing on workers', async () => {
    const pub = await createTestApp({ APP_ROLE: 'public' });
    try {
      const res = await pub.app.inject({ method: 'GET', url: '/api/openapi.json', headers: { authorization: 'Bearer osp_anything', cookie: 'osp_session=x' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(buildOpenApiDocument('public'));
      expect(res.headers['cache-control']).toBe('public, no-cache');
      expect(res.headers.vary).toBeUndefined();
    } finally {
      await pub.close();
    }
    const worker = await createTestApp({ APP_ROLE: 'worker' });
    try {
      expect((await worker.app.inject({ method: 'GET', url: '/api/openapi.json' })).statusCode).toBe(404);
    } finally {
      await worker.close();
    }
  });
});
