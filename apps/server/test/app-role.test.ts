import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { adminClient, createTestApp, createUser, errors, loginRequest, PASSWORD, type TestApp } from './helpers.js';

const PG = 'postgres://osp:secret@db.invalid:5432/osp';

describe('APP_ROLE configuration', () => {
  it('defaults to all with the worker enabled', () => {
    const c = loadConfig({ NODE_ENV: 'test' });
    expect(c.APP_ROLE).toBe('all');
    expect(c.WORKER_ENABLED).toBe(true);
  });

  it('rejects unknown roles', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', APP_ROLE: 'backend' })).toThrow(/APP_ROLE/);
  });

  it('refuses every role except all on SQLite', () => {
    for (const role of ['public', 'admin', 'worker']) {
      expect(() => loadConfig({ NODE_ENV: 'test', APP_ROLE: role })).toThrow(/APP_ROLE: .*needs PostgreSQL/);
    }
    expect(loadConfig({ NODE_ENV: 'test', APP_ROLE: 'all' }).APP_ROLE).toBe('all');
  });

  it('derives WORKER_ENABLED from the role', () => {
    const worker = (role: string, extra: Record<string, string> = {}) =>
      loadConfig({ NODE_ENV: 'test', DATABASE_URL: PG, APP_ROLE: role, ...extra }).WORKER_ENABLED;
    expect(worker('all')).toBe(true);
    expect(worker('worker')).toBe(true);
    expect(worker('admin')).toBe(false);
    expect(worker('admin', { WORKER_ENABLED: 'true' })).toBe(true);
    expect(worker('public')).toBe(false);
    expect(worker('all', { WORKER_ENABLED: 'false' })).toBe(false);
  });

  it('refuses contradicting worker settings', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: PG, APP_ROLE: 'public', WORKER_ENABLED: 'true' })).toThrow(
      /WORKER_ENABLED/,
    );
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: PG, APP_ROLE: 'worker', WORKER_ENABLED: 'false' })).toThrow(
      /WORKER_ENABLED/,
    );
  });

  it('lets a public instance queue mails without an SMTP server', () => {
    const env = { NODE_ENV: 'test', DATABASE_URL: PG, MAIL_TRANSPORT: 'smtp', SMTP_FROM: 'Status <status@example.com>' };
    expect(loadConfig({ ...env, APP_ROLE: 'public' }).MAIL_TRANSPORT).toBe('smtp');
    expect(() => loadConfig({ ...env, APP_ROLE: 'admin' })).toThrow(/SMTP_HOST/);
  });

  it('only enables OIDC where the login is served', () => {
    const env = { NODE_ENV: 'test', DATABASE_URL: PG, OIDC_ISSUER_URL: 'https://idp.example.com', OIDC_CLIENT_ID: 'osp' };
    expect(loadConfig({ ...env, APP_ROLE: 'admin' }).oidcEnabled).toBe(true);
    expect(loadConfig({ ...env, APP_ROLE: 'public' }).oidcEnabled).toBe(false);
    expect(loadConfig({ ...env, APP_ROLE: 'worker' }).oidcEnabled).toBe(false);
  });
});

async function routesOf(role: string): Promise<string[]> {
  const routes: string[] = [];
  const t = await createTestApp(
    { APP_ROLE: role },
    {
      onRoute: (r) => {
        for (const m of [r.method].flat()) if (m !== 'HEAD') routes.push(`${m} ${r.url}`);
      },
    },
  );
  await t.close();
  return routes.sort();
}

const isPublicRoute = (r: string) => /^\w+ (\/api\/public(\/|$)|\/feed\.|\/api\/health$)/.test(r);

describe('APP_ROLE route availability', () => {
  let all: string[];
  beforeAll(async () => {
    all = await routesOf('all');
  });

  it('serves every route with all and admin', async () => {
    expect(all.some((r) => r.startsWith('GET /api/admin/'))).toBe(true);
    expect(all.some((r) => r.startsWith('POST /api/ingest/'))).toBe(true);
    expect(all.some((r) => r.startsWith('POST /api/auth/login'))).toBe(true);
    expect(await routesOf('admin')).toEqual(all);
  });

  it('serves only the public routes with public', async () => {
    const routes = await routesOf('public');
    expect(routes).toEqual(all.filter(isPublicRoute));
    expect(routes.some((r) => r.startsWith('GET /api/public/status'))).toBe(true);
    expect(routes.some((r) => r.startsWith('POST /api/public/subscriptions'))).toBe(true);
    expect(routes.some((r) => /\/api\/(admin|auth|ingest)/.test(r))).toBe(false);
  });

  it('serves only the health check with worker', async () => {
    expect(await routesOf('worker')).toEqual(['GET /api/health']);
  });
});

describe('APP_ROLE requests', () => {
  const apps: TestApp[] = [];
  const make = async (role: string) => {
    const t = await createTestApp({ APP_ROLE: role });
    apps.push(t);
    return t;
  };
  afterAll(async () => {
    for (const t of apps) await t.close();
  });

  it('reports the role in the health check', async () => {
    for (const [role, worker] of [
      ['all', true],
      ['public', false],
      ['admin', false],
      ['worker', true],
    ] as const) {
      const t = await make(role);
      const res = await t.app.inject('/api/health');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', role, worker });
    }
  });

  it('answers 404 for admin, auth and ingest on a public instance', async () => {
    const t = await make('public');
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const signIn = await t.app.inject(loginRequest('admin@example.com', PASSWORD));
    expect(signIn.statusCode).toBe(404);
    expect(signIn.cookies).toHaveLength(0);
    for (const [method, url] of [
      ['GET', '/api/admin/services'],
      ['GET', '/api/auth/session'],
      ['GET', '/api/auth/config'],
      ['GET', '/api/auth/oidc/login'],
      ['POST', '/api/ingest/abc'],
      ['POST', '/api/admin/monitor-sources/abc/poll'],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: { authorization: 'Bearer x' } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(errors(res)[0]?.code).toBe('not_found');
    }
    expect((await t.app.inject('/api/public/status')).statusCode).toBe(200);
    expect((await t.app.inject('/feed.rss')).statusCode).toBe(200);
  });

  it('answers 404 for everything but the health check on a worker instance', async () => {
    const t = await make('worker');
    for (const url of ['/api/public/status', '/feed.atom', '/api/admin/services', '/api/auth/config']) {
      expect((await t.app.inject(url)).statusCode, url).toBe(404);
    }
  });

  it('lets an admin sign in and preview the public API on an admin instance', async () => {
    const t = await make('admin');
    const admin = await adminClient(t);
    expect((await admin.get('/api/admin/services')).statusCode).toBe(200);
    expect((await t.app.inject('/api/public/status')).statusCode).toBe(200);
  });
});
