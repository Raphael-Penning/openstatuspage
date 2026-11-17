/**
 * Test helpers: an app on an in-memory SQLite database plus small HTTP helpers.
 */
import type { UserRole } from '@openstatuspage/shared';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, migrateToLatest, type DB } from '../src/db/index.js';
import { newId } from '../src/lib/ids.js';
import { hashPassword } from '../src/lib/password.js';
import type { Mailer } from '../src/mail/mailer.js';
import { nowIso } from '../src/lib/time.js';

export const BASE_URL = 'https://status.example.com';
export const PASSWORD = 'correct-horse-battery';

export interface TestApp {
  app: FastifyInstance;
  db: DB;
  config: Config;
  close(): Promise<void>;
}

export async function createTestApp(
  env: Record<string, string> = {},
  options: { mailer?: Mailer } = {},
): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'sqlite::memory:',
    SECRET_KEY: 'test-secret-key-that-is-long-enough-1234567890',
    BASE_URL,
    ...env,
  });
  const db = await createDb(config);
  await migrateToLatest(db);
  const app = await buildApp({ config, db, serveWeb: false, mailer: options.mailer });
  await app.ready();
  return {
    app,
    db,
    config,
    async close() {
      await app.close();
      await db.destroy();
    },
  };
}

export async function createUser(
  db: DB,
  opts: { email: string; role: UserRole; password?: string | null; name?: string },
): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .insertInto('users')
    .values({
      id,
      email: opts.email,
      name: opts.name ?? opts.email.split('@')[0]!,
      role: opts.role,
      password_hash: opts.password === null ? null : await hashPassword(opts.password ?? PASSWORD),
      oidc_subject: null,
      created_at: now,
      updated_at: now,
      last_login_at: null,
    })
    .execute();
  return id;
}

/** Logs in and returns the `Cookie` header value. */
export async function login(app: FastifyInstance, email: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'osp_session');
  if (!cookie) throw new Error('no session cookie');
  return `osp_session=${cookie.value}`;
}

export interface Client {
  get(url: string): Promise<LightMyRequestResponse>;
  post(url: string, payload?: unknown): Promise<LightMyRequestResponse>;
  put(url: string, payload: unknown): Promise<LightMyRequestResponse>;
  patch(url: string, payload: unknown): Promise<LightMyRequestResponse>;
  delete(url: string): Promise<LightMyRequestResponse>;
}

/** HTTP client authenticated by cookie (with CSRF header) or by bearer token. */
export function client(app: FastifyInstance, auth: { cookie?: string; token?: string }): Client {
  const headers: Record<string, string> = {};
  if (auth.cookie) {
    headers.cookie = auth.cookie;
    headers['x-requested-with'] = 'openstatuspage';
  }
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  const send = (method: InjectOptions['method'], url: string, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return {
    get: (url) => send('GET', url),
    post: (url, payload) => send('POST', url, payload ?? {}),
    put: (url, payload) => send('PUT', url, payload),
    patch: (url, payload) => send('PATCH', url, payload),
    delete: (url) => send('DELETE', url),
  };
}

/** Creates an admin and returns an authenticated client. */
export async function adminClient(t: TestApp, email = 'admin@example.com'): Promise<Client> {
  await createUser(t.db, { email, role: 'admin' });
  return client(t.app, { cookie: await login(t.app, email) });
}

/** Creates a webhook monitoring source with the given checks (via the ingest service). */
export async function seedChecks(
  t: TestApp,
  checks: { externalId: string; name: string; host: string; state: 'ok' | 'warning' | 'critical' | 'unknown' }[],
): Promise<{ sourceId: string; checkIds: Record<string, string> }> {
  const sourceId = newId();
  const now = nowIso();
  await t.db
    .insertInto('monitor_sources')
    .values({
      id: sourceId,
      name: 'Internal monitoring',
      type: 'webhook',
      enabled: 1,
      config_encrypted: t.app.ctx.secrets.encryptJson({}),
      poll_interval_seconds: 60,
      ingest_token_hash: 'x',
      last_poll_at: null,
      last_poll_ok: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await t.app.ctx.ingest.ingest(sourceId, checks, { full: false });
  const rows = await t.db.selectFrom('monitor_checks').select(['id', 'external_id']).where('source_id', '=', sourceId).execute();
  return { sourceId, checkIds: Object.fromEntries(rows.map((r) => [r.external_id, r.id])) };
}

export async function setCheckState(
  t: TestApp,
  sourceId: string,
  check: { externalId: string; name: string; host: string },
  state: 'ok' | 'warning' | 'critical' | 'unknown',
): Promise<void> {
  await t.app.ctx.ingest.ingest(sourceId, [{ ...check, state }], { full: false });
}
