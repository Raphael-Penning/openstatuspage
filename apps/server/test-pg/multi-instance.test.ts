/**
 * Two worker instances against one PostgreSQL database.
 *
 * Part of the PostgreSQL suite (pnpm --filter @openstatuspage/server test:pg).
 * Runs when PG_TEST_URL points to a PostgreSQL server whose user may create
 * databases (each run uses a fresh database and drops it afterwards), e.g.
 *
 *   docker run -d --rm --name osp-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:17-alpine
 *   PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres pnpm --filter @openstatuspage/server test:pg
 *
 * Without it the suite is skipped.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pollTaskName, syncPollers } from '../src/adapters/poller.js';
import { pollAndStore } from '../src/adapters/runner.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createDb, type DB } from '../src/db/index.js';
import { isUniqueViolation } from '../src/lib/errors.js';
import { newId, newToken } from '../src/lib/ids.js';
import { TaskLeases } from '../src/lib/task-leases.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { DELIVERY_TASK, registerNotificationTasks } from '../src/services/notifications.js';
import { prepareDatabase } from '../src/startup.js';
import { sha256 } from '../src/lib/crypto.js';
import { nowIso } from '../src/lib/time.js';
import { fixture } from '../test/adapters/helpers.js';

const ADMIN_URL = process.env.PG_TEST_URL;
const SECRET_KEY = 'test-secret-key-that-is-long-enough-1234567890';

interface Instance {
  app: FastifyInstance;
  ctx: AppContext;
  db: DB;
  mailer: MemoryMailer;
}

let dbName: string;
let url: string;
let a: Instance;
let b: Instance;

async function adminQuery(text: string): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

async function startInstance(): Promise<Instance> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    SECRET_KEY,
    BASE_URL: 'https://status.example.com',
    APP_ROLE: 'worker',
  });
  const db = await createDb(config);
  await prepareDatabase(db, config, { info: () => undefined });
  const mailer = new MemoryMailer();
  const app = await buildApp({ config, db, serveWeb: false, mailer });
  await app.ready();
  return { app, ctx: app.ctx, db, mailer };
}

async function stopInstance(i: Instance | undefined): Promise<void> {
  if (!i) return;
  i.ctx.worker.stop();
  await i.app.close();
  await i.db.destroy();
}

describe.skipIf(!ADMIN_URL)('several instances on one PostgreSQL database', () => {
  beforeAll(async () => {
    dbName = `osp_multi_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await adminQuery(`create database ${dbName}`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    url = u.toString();
    // Both start at once: Kysely's migration lock lets only one of them migrate.
    [a, b] = await Promise.all([startInstance(), startInstance()]);
  });

  afterAll(async () => {
    await stopInstance(a);
    await stopInstance(b);
    if (dbName) await adminQuery(`drop database if exists ${dbName} with (force)`);
  });

  beforeEach(async () => {
    await a.db.deleteFrom('task_leases').execute();
    await a.db.deleteFrom('email_outbox').execute();
    a.mailer.sent.length = 0;
    b.mailer.sent.length = 0;
  });

  it('uses leases on PostgreSQL with one owner per instance', () => {
    expect(a.ctx.leases).toBeInstanceOf(TaskLeases);
    expect(b.ctx.leases).toBeInstanceOf(TaskLeases);
    expect(a.ctx.leases!.owner).not.toBe(b.ctx.leases!.owner);
  });

  async function insertKumaSource(): Promise<string> {
    const id = newId();
    const now = nowIso();
    await a.db
      .insertInto('monitor_sources')
      .values({
        id,
        name: `Kuma ${id.slice(0, 6)}`,
        type: 'uptimekuma',
        enabled: 1,
        config_encrypted: a.ctx.secrets.encryptJson({ baseUrl: 'https://kuma.example.com', apiKey: 'kuma-secret-key' }),
        poll_interval_seconds: 60,
        ingest_token_hash: sha256(newToken()),
        last_poll_at: null,
        last_poll_ok: null,
        last_error: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return id;
  }

  /** fetch double for Uptime Kuma that counts requests and can be slowed down. */
  function countingKuma(delayMs = 0) {
    const counter = { calls: 0 };
    const metrics = fixture('uptimekuma-metrics.txt');
    const fetchFactory = () =>
      (async () => {
        counter.calls++;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        return new Response(metrics, { status: 200 });
      }) as typeof fetch;
    return { counter, fetchFactory };
  }

  it('polls a source once per interval although both workers schedule it', async () => {
    const sourceId = await insertKumaSource();
    const kuma = countingKuma(50);
    await syncPollers(a.ctx, { fetchFactory: kuma.fetchFactory });
    await syncPollers(b.ctx, { fetchFactory: kuma.fetchFactory });
    const task = pollTaskName(sourceId);
    expect(a.ctx.worker.has(task)).toBe(true);
    expect(b.ctx.worker.has(task)).toBe(true);

    // Both timers fire together, several times within one interval: one poll.
    for (let i = 0; i < 3; i++) {
      await Promise.all([a.ctx.worker.runScheduled(task), b.ctx.worker.runScheduled(task)]);
    }
    expect(kuma.counter.calls).toBe(1);
    const checks = await a.db.selectFrom('monitor_checks').select('id').where('source_id', '=', sourceId).execute();
    expect(checks).toHaveLength(5);

    // One interval later exactly one of them polls again.
    await a.db
      .updateTable('task_leases')
      .set((eb) => ({ last_started_at: eb('last_started_at', '-', 60_000) }))
      .where('name', '=', task)
      .execute();
    await Promise.all([a.ctx.worker.runScheduled(task), b.ctx.worker.runScheduled(task)]);
    expect(kuma.counter.calls).toBe(2);
  });

  it('never polls a source on two instances at the same time', async () => {
    const sourceId = await insertKumaSource();
    const kuma = countingKuma(300);
    const [first, second] = await Promise.all([
      pollAndStore(a.ctx, sourceId, { fetchFactory: kuma.fetchFactory }),
      // Started slightly later, while the first poll still holds the lease.
      new Promise((r) => setTimeout(r, 100)).then(() =>
        pollAndStore(b.ctx, sourceId, { fetchFactory: kuma.fetchFactory }),
      ),
    ]);
    expect(kuma.counter.calls).toBe(1);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, message: expect.stringContaining('Another instance is polling') });
    // The lease is free again: a manual poll goes through.
    expect((await pollAndStore(b.ctx, sourceId, { fetchFactory: kuma.fetchFactory })).ok).toBe(true);
    expect(kuma.counter.calls).toBe(2);
  });

  it('polls an edited source right away on one instance only', async () => {
    const sourceId = await insertKumaSource();
    const kuma = countingKuma();
    await syncPollers(a.ctx, { fetchFactory: kuma.fetchFactory });
    await syncPollers(b.ctx, { fetchFactory: kuma.fetchFactory });
    const task = pollTaskName(sourceId);
    await Promise.all([a.ctx.worker.runScheduled(task), b.ctx.worker.runScheduled(task)]);
    expect(kuma.counter.calls).toBe(1);

    // Source times come from this process, lease times from the database clock.
    await new Promise((r) => setTimeout(r, 500));
    await a.db.updateTable('monitor_sources').set({ updated_at: nowIso() }).where('id', '=', sourceId).execute();
    await syncPollers(a.ctx, { fetchFactory: kuma.fetchFactory });
    await syncPollers(b.ctx, { fetchFactory: kuma.fetchFactory });
    await Promise.all([a.ctx.worker.runScheduled(task), b.ctx.worker.runScheduled(task)]);
    await Promise.all([a.ctx.worker.runScheduled(task), b.ctx.worker.runScheduled(task)]);
    expect(kuma.counter.calls).toBe(2);
  });

  it('sends every queued mail exactly once when both workers deliver', async () => {
    const recipients = Array.from({ length: 40 }, (_, i) => `reader${i}@example.com`);
    await a.ctx.notifications.enqueue(
      recipients.map((recipient) => ({
        subscriberId: null,
        recipient,
        kind: 'test',
        subject: 'Hello',
        text: 'Hello',
        html: '<p>Hello</p>',
      })),
    );
    registerNotificationTasks(a.ctx);
    registerNotificationTasks(b.ctx);
    // Scheduled task runs and direct deliveries (row claims) in parallel.
    await Promise.all([
      a.ctx.worker.runScheduled(DELIVERY_TASK),
      b.ctx.worker.runScheduled(DELIVERY_TASK),
      a.ctx.notifications.deliverDue(),
      b.ctx.notifications.deliverDue(),
      b.ctx.notifications.deliverDue(),
    ]);
    await Promise.all([a.ctx.notifications.deliverDue(), b.ctx.notifications.deliverDue()]);

    const sent = [...a.mailer.sent, ...b.mailer.sent].map((m) => m.to);
    expect(sent).toHaveLength(recipients.length);
    expect(new Set(sent)).toEqual(new Set(recipients));
    const pending = await a.db.selectFrom('email_outbox').select('id').where('status', '!=', 'sent').execute();
    expect(pending).toEqual([]);
  });

  it('runs a task on one instance at a time and once per interval', async () => {
    let runs = 0;
    let active = 0;
    let overlap = false;
    const body = async () => {
      runs++;
      active++;
      if (active > 1) overlap = true;
      await new Promise((r) => setTimeout(r, 100));
      active--;
    };
    a.ctx.worker.schedule('test-task', 60_000, body);
    b.ctx.worker.schedule('test-task', 60_000, body);
    await Promise.all([
      a.ctx.worker.runScheduled('test-task'),
      b.ctx.worker.runScheduled('test-task'),
      a.ctx.worker.runNow('test-task'),
      b.ctx.worker.runNow('test-task'),
    ]);
    expect(overlap).toBe(false);
    expect(runs).toBe(1);
    // Run now (e.g. new mail queued) ignores the interval but not the lock.
    await b.ctx.worker.runNow('test-task');
    expect(runs).toBe(2);
    a.ctx.worker.unschedule('test-task');
    b.ctx.worker.unschedule('test-task');
  });

  it('lets another instance take over the lease of an instance that died', async () => {
    const dead = new TaskLeases(a.db, { owner: 'dead-instance', ttlMs: 200 });
    const alive = new TaskLeases(b.db, { owner: 'alive-instance', ttlMs: 200 });
    expect(await dead.claim('takeover')).toBe(true);
    expect(await alive.claim('takeover')).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(await alive.claim('takeover')).toBe(true);
    // The dead owner can no longer renew or release it.
    expect(await dead.renew('takeover')).toBe(false);
    await dead.release('takeover');
    expect(await dead.claim('takeover')).toBe(false);
    await alive.release('takeover');
    expect(await dead.claim('takeover')).toBe(true);
    await dead.release('takeover');
  });

  it('removes leases nobody used for a long time', async () => {
    const leases = new TaskLeases(a.db, { owner: 'cleanup-test' });
    expect(await leases.claim('old-task')).toBe(true);
    await leases.release('old-task');
    expect(await leases.claim('recent-task')).toBe(true);
    await leases.release('recent-task');
    await a.db
      .updateTable('task_leases')
      .set((eb) => ({ last_started_at: eb('last_started_at', '-', 8 * 86400_000) }))
      .where('name', '=', 'old-task')
      .execute();
    expect(await leases.purge()).toBe(1);
    const names = (await a.db.selectFrom('task_leases').select('name').execute()).map((r) => r.name);
    expect(names).toEqual(['recent-task']);
  });

  it('keeps one open status history segment when two instances recompute a service', async () => {
    const id = newId();
    const ts = nowIso();
    await a.db
      .insertInto('services')
      .values({
        id,
        slug: `svc-${id.slice(0, 8)}`,
        name: 'Concurrent',
        description: null,
        kind: 'service',
        url: null,
        group_id: null,
        sort_order: 0,
        is_public: 1,
        status_mode: 'manual',
        manual_status: 'operational',
        aggregation: 'worst',
        current_status: 'operational',
        monitor_status: 'operational',
        status_changed_at: null,
        created_at: ts,
        updated_at: ts,
      })
      .execute();
    for (const status of ['degraded', 'major_outage', 'operational'] as const) {
      await a.db.updateTable('services').set({ manual_status: status }).where('id', '=', id).execute();
      await Promise.all([
        a.ctx.engine.recompute([id]),
        b.ctx.engine.recompute([id]),
        a.ctx.engine.recompute([id]),
        b.ctx.engine.recompute([id]),
      ]);
    }
    const open = await a.db
      .selectFrom('service_status_history')
      .select('status')
      .where('service_id', '=', id)
      .where('ended_at', 'is', null)
      .execute();
    expect(open).toEqual([{ status: 'operational' }]);
    const all = await a.db.selectFrom('service_status_history').select('id').where('service_id', '=', id).execute();
    // degraded -> major_outage -> operational
    expect(all).toHaveLength(3);
  });

  it('allows one active history import per source', async () => {
    const sourceId = await insertKumaSource();
    const row = () => ({
      id: newId(),
      source_id: sourceId,
      status: 'fetching' as const,
      range_from: '2026-01-01T00:00:00.000Z',
      range_to: '2026-01-02T00:00:00.000Z',
      only_linked: 1,
      progress: null,
      credentials_encrypted: null,
      fetch_summary: null,
      preview: null,
      result: null,
      error: null,
      error_code: null,
      created_by: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      finished_at: null,
    });
    await a.db.insertInto('history_imports').values(row()).execute();
    const err = await b.db
      .insertInto('history_imports')
      .values(row())
      .execute()
      .then(() => null, (e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
    // Finished jobs do not count.
    await a.db.insertInto('history_imports').values({ ...row(), status: 'completed' as const }).execute();
  });
});
