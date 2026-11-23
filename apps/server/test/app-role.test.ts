import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb, EXPECTED_MIGRATION, migrateToLatest, schemaStatus } from '../src/db/index.js';
import { DELIVERY_TASK } from '../src/services/notifications.js';
import { POLLER_SYNC_TASK, prepareDatabase, startBackgroundTasks } from '../src/startup.js';
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

  it('names the public database role', () => {
    expect(loadConfig({ NODE_ENV: 'test', DATABASE_URL: PG }).DB_PUBLIC_ROLE).toBe('osp_public');
    expect(loadConfig({ NODE_ENV: 'test', DATABASE_URL: PG, DB_PUBLIC_ROLE: 'status_web' }).DB_PUBLIC_ROLE).toBe('status_web');
    for (const role of ['Status', 'status-web', 'x; drop table users', '1status']) {
      expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: PG, DB_PUBLIC_ROLE: role }), role).toThrow(/DB_PUBLIC_ROLE/);
    }
  });

  it('lets a public instance run with SUBSCRIPTION_TOKEN_KEY instead of SECRET_KEY', () => {
    const prod = { NODE_ENV: 'production', DATABASE_URL: PG, APP_ROLE: 'public' };
    const tokenKey = 'subscription-token-key-that-is-long-enough-123';
    expect(() => loadConfig(prod)).toThrow(/SUBSCRIPTION_TOKEN_KEY must be set for APP_ROLE=public/);
    const pub = loadConfig({ ...prod, SUBSCRIPTION_TOKEN_KEY: tokenKey });
    expect(pub.SUBSCRIPTION_TOKEN_KEY).toBe(tokenKey);
    // A random key of its own for everything else: nothing derived from it outlives the process.
    expect(pub.SECRET_KEY).not.toBe(tokenKey);
    expect(pub.SECRET_KEY.length).toBeGreaterThanOrEqual(32);
    expect(pub.insecureSecret).toBe(false);
    // Every other role still needs SECRET_KEY; the token key defaults to it.
    expect(() => loadConfig({ ...prod, APP_ROLE: 'admin', SUBSCRIPTION_TOKEN_KEY: tokenKey })).toThrow(/SECRET_KEY must be set/);
    const secret = 'secret-key-that-is-long-enough-1234567890';
    expect(loadConfig({ ...prod, APP_ROLE: 'admin', SECRET_KEY: secret }).SUBSCRIPTION_TOKEN_KEY).toBe(secret);
    expect(() => loadConfig({ ...prod, SUBSCRIPTION_TOKEN_KEY: 'short' })).toThrow(/SUBSCRIPTION_TOKEN_KEY/);
  });

  it('only enables OIDC where the login is served', () => {
    const env = { NODE_ENV: 'test', DATABASE_URL: PG, OIDC_ISSUER_URL: 'https://idp.example.com', OIDC_CLIENT_ID: 'osp' };
    expect(loadConfig({ ...env, APP_ROLE: 'admin' }).oidcEnabled).toBe(true);
    expect(loadConfig({ ...env, APP_ROLE: 'public' }).oidcEnabled).toBe(false);
    expect(loadConfig({ ...env, APP_ROLE: 'worker' }).oidcEnabled).toBe(false);
  });
});

async function routesOf(role: string, env: Record<string, string> = {}): Promise<string[]> {
  const routes: string[] = [];
  const t = await createTestApp(
    { APP_ROLE: role, ...env },
    {
      onRoute: (r) => {
        for (const m of [r.method].flat()) if (m !== 'HEAD') routes.push(`${m} ${r.url}`);
      },
    },
  );
  await t.close();
  return routes.sort();
}

const isPublicRoute = (r: string) =>
  /^\w+ (\/api\/public(\/|$)|\/s\/:id\/:token$|\/feed\.|\/api\/health$|\/api\/openapi\.json$|\/robots\.txt$|\/sitemap|\/llms|\/uploads\/|\/theme\/)/.test(r);

/** Files for crawlers that describe the status page: not on a management instance (robots.txt only). */
const STATUS_PAGE_ONLY = /^GET \/(sitemap|llms)/;

describe('APP_ROLE route availability', () => {
  let all: string[];
  beforeAll(async () => {
    all = await routesOf('all');
  });

  it('serves every route with all and admin', async () => {
    expect(all.some((r) => r.startsWith('GET /api/admin/'))).toBe(true);
    expect(all.some((r) => r.startsWith('POST /api/ingest/'))).toBe(true);
    expect(all.some((r) => r.startsWith('POST /api/auth/login'))).toBe(true);
    expect(await routesOf('admin')).toEqual(all.filter((r) => !STATUS_PAGE_ONLY.test(r)));
    expect(all).toEqual(expect.arrayContaining(['GET /robots.txt', 'GET /sitemap.xml', 'GET /llms.txt']));
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

  it('serves the analytics proxy where public pages are served, and only with UMAMI_URL', async () => {
    const proxy = ['GET /pulse/p.js', 'POST /pulse/api/send'];
    const env = { UMAMI_URL: 'https://umami.example.com' };
    for (const role of ['all', 'admin', 'public']) {
      expect(await routesOf(role, env), role).toEqual(expect.arrayContaining(proxy));
    }
    expect(all.some((r) => r.includes('/pulse/'))).toBe(false);
    expect(await routesOf('worker', env)).toEqual(['GET /api/health']);
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

  it('answers the health check in every role without deployment details', async () => {
    for (const role of ['all', 'public', 'admin', 'worker'] as const) {
      const t = await make(role);
      const res = await t.app.inject('/api/health');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
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
    // The webhook and SMS delivery code is not loaded (memory); the public summary still works.
    expect(t.app.ctx.channels).toBeNull();
    expect((await t.app.inject('/api/public/summary')).statusCode).toBe(200);
    expect((await make('admin')).app.ctx.channels).not.toBeNull();
  });

  it('answers 404 for everything but the health check on a worker instance', async () => {
    const t = await make('worker');
    for (const url of ['/api/public/status', '/feed.atom', '/api/admin/services', '/api/auth/config']) {
      expect((await t.app.inject(url)).statusCode, url).toBe(404);
    }
  });

  it('starts the background tasks only where WORKER_ENABLED', async () => {
    const cases = [
      ['all', {}, true],
      ['worker', {}, true],
      ['admin', {}, false],
      ['admin', { WORKER_ENABLED: 'true' }, true],
      ['public', {}, false],
    ] as const;
    for (const [role, extra, expected] of cases) {
      const t = await createTestApp({ APP_ROLE: role, ...extra });
      apps.push(t);
      const started = await startBackgroundTasks(t.app.ctx);
      expect(started, role).toBe(expected);
      expect(t.app.ctx.worker.running, role).toBe(expected);
      if (expected) {
        expect(t.app.ctx.worker.taskNames()).toEqual(
          expect.arrayContaining(['maintenance-transitions', 'session-cleanup', DELIVERY_TASK, POLLER_SYNC_TASK]),
        );
      } else {
        expect(t.app.ctx.worker.taskNames(), role).toEqual([]);
      }
      t.app.ctx.worker.stop();
    }
  });

  it('lets an admin sign in and preview the public API on an admin instance', async () => {
    const t = await make('admin');
    const admin = await adminClient(t);
    expect((await admin.get('/api/admin/services')).statusCode).toBe(200);
    expect((await t.app.inject('/api/public/status')).statusCode).toBe(200);
  });
});

describe('APP_ROLE database preparation', () => {
  const log = { info: () => {} };
  const fresh = () => createDb({ database: { dialect: 'sqlite', filename: ':memory:' } });

  it('migrates on start for all, admin and worker', async () => {
    for (const role of ['all', 'admin', 'worker'] as const) {
      const db = await fresh();
      await prepareDatabase(db, { APP_ROLE: role, SCHEMA_WAIT_SECONDS: 0 }, log);
      expect((await schemaStatus(db)).state, role).toBe('current');
      await db.destroy();
    }
  });

  it('never migrates on a public instance and fails clearly when the schema is missing', async () => {
    const db = await fresh();
    await expect(prepareDatabase(db, { APP_ROLE: 'public', SCHEMA_WAIT_SECONDS: 0 }, log)).rejects.toThrow(
      /schema is not ready.*never runs migrations/,
    );
    expect(await schemaStatus(db)).toEqual({ applied: null, expected: EXPECTED_MIGRATION, state: 'behind' });
    await db.destroy();
  });

  it('waits on a public instance until another instance has migrated', async () => {
    const db = await fresh();
    const waits: unknown[] = [];
    const ready = prepareDatabase(
      db,
      { APP_ROLE: 'public', SCHEMA_WAIT_SECONDS: 5 },
      { info: (obj) => waits.push(obj) },
      { intervalMs: 20 },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await migrateToLatest(db);
    await expect(ready).resolves.toBeUndefined();
    expect(waits).toEqual([{ applied: null, expected: EXPECTED_MIGRATION }]);
    await db.destroy();
  });

  it('refuses a database that is newer than the build on a public instance', async () => {
    const db = await fresh();
    await migrateToLatest(db);
    await db.insertInto('kysely_migration' as never).values({ name: '9999_future', timestamp: new Date().toISOString() } as never).execute();
    expect((await schemaStatus(db)).state).toBe('ahead');
    await expect(prepareDatabase(db, { APP_ROLE: 'public', SCHEMA_WAIT_SECONDS: 0 }, log)).rejects.toThrow(/newer than this build/);
    await db.destroy();
  });
});
