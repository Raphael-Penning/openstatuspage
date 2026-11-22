import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MonitorSourceType } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import type { AdapterContext } from '../../src/adapters/types.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import { createDb, migrateToLatest } from '../../src/db/index.js';
import { sha256 } from '../../src/lib/crypto.js';
import { newId, newToken } from '../../src/lib/ids.js';
import { nowIso } from '../../src/lib/time.js';

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(resolve(here, 'fixtures', name), 'utf8');
}

export function jsonFixture<T = unknown>(name: string): T {
  return JSON.parse(fixture(name)) as T;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

/** fetch double: `handler` returns the response for each request; calls are recorded. */
export function mockFetch(handler: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: RecordedCall = {
      url: String(input instanceof Request ? input.url : input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : null,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function adapterContext(fetchFn: typeof fetch): AdapterContext {
  return { fetch: fetchFn, signal: new AbortController().signal };
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  insertSource(input: {
    type: MonitorSourceType;
    config?: Record<string, unknown>;
    enabled?: boolean;
    pollIntervalSeconds?: number;
  }): Promise<{ id: string; token: string }>;
  close(): Promise<void>;
}

export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', ...env });
  const db = await createDb(config);
  await migrateToLatest(db);
  const app = await buildApp({ config, db, serveWeb: false });
  await app.ready();
  const { ctx } = app;
  return {
    app,
    ctx,
    async insertSource({ type, config: sourceConfig = {}, enabled = true, pollIntervalSeconds = 60 }) {
      const id = newId();
      const token = newToken();
      const now = nowIso();
      await db
        .insertInto('monitor_sources')
        .values({
          id,
          name: `Test ${type}`,
          type,
          enabled: enabled ? 1 : 0,
          config_encrypted: ctx.secrets.encryptJson(sourceConfig),
          poll_interval_seconds: pollIntervalSeconds,
          ingest_token_hash: sha256(token),
          last_poll_at: null,
          last_poll_ok: null,
          last_error: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      return { id, token };
    },
    async close() {
      ctx.worker.stop();
      await app.close();
      await db.destroy();
    },
  };
}
