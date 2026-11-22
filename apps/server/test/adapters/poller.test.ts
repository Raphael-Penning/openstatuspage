import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../../src/adapters/http.js';
import { pollTaskName, syncPollers } from '../../src/adapters/poller.js';
import { pollMonitorSourceNow, testMonitorSource } from '../../src/adapters/routes.js';
import { pollAndStore } from '../../src/adapters/runner.js';
import { HttpError } from '../../src/lib/errors.js';
import { createTestApp, fixture, mockFetch, type TestApp } from './helpers.js';

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

const kumaConfig = { baseUrl: 'https://kuma.example.com', apiKey: 'kuma-secret-key' };
const metrics = fixture('uptimekuma-metrics.txt');

function kumaFetch(): { fetch: FetchFn; calls: unknown[] } {
  return mockFetch(() => new Response(metrics, { status: 200 }));
}

function failingFetch(status = 500): FetchFn {
  return mockFetch(() => new Response('nope', { status })).fetch;
}

async function sourceRow(id: string) {
  return t.ctx.db.selectFrom('monitor_sources').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

async function checkStates(id: string) {
  const rows = await t.ctx.db
    .selectFrom('monitor_checks')
    .select(['external_id', 'state'])
    .where('source_id', '=', id)
    .orderBy('external_id')
    .execute();
  return Object.fromEntries(rows.map((r) => [r.external_id, r.state]));
}

describe('pollAndStore', () => {
  it('stores polled checks and records success', async () => {
    const { id } = await t.insertSource({ type: 'uptimekuma', config: kumaConfig });
    const outcome = await pollAndStore(t.ctx, id, { fetchFactory: () => kumaFetch().fetch });
    expect(outcome).toMatchObject({ ok: true, checkCount: 5, result: { created: 5 } });
    expect(await checkStates(id)).toMatchObject({ Website: 'ok', 'Mail server': 'critical' });
    const row = await sourceRow(id);
    expect(row.last_poll_ok).toBe(1);
    expect(row.last_error).toBeNull();
    expect(row.last_poll_at).not.toBeNull();
  });

  it('keeps the last known states when a poll fails and records the error', async () => {
    const { id } = await t.insertSource({ type: 'uptimekuma', config: kumaConfig });
    await pollAndStore(t.ctx, id, { fetchFactory: () => kumaFetch().fetch });
    const before = await checkStates(id);

    const outcome = await pollAndStore(t.ctx, id, { fetchFactory: () => failingFetch(503) });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('HTTP 503');
    expect(await checkStates(id)).toEqual(before);
    const row = await sourceRow(id);
    expect(row.last_poll_ok).toBe(0);
    expect(row.last_error).toContain('HTTP 503');
    expect(row.last_error).not.toContain('kuma-secret-key');
  });

  it('records network errors from the default fetch', async () => {
    const { id } = await t.insertSource({ type: 'uptimekuma', config: kumaConfig });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }),
    );
    const outcome = await pollAndStore(t.ctx, id);
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.message).toBe('Uptime Kuma: request to https://kuma.example.com/metrics failed: connection refused (ECONNREFUSED)');
  });

  it('stores nothing and records the error when a poll exceeds MAX_CHECKS_PER_SOURCE', async () => {
    await t.close();
    t = await createTestApp({ MAX_CHECKS_PER_SOURCE: '100' });
    const { id } = await t.insertSource({ type: 'uptimekuma', config: kumaConfig });
    const many = Array.from({ length: 101 }, (_, i) => `monitor_status{monitor_name="m${i}",monitor_type="http"} 1`).join('\n');
    const outcome = await pollAndStore(t.ctx, id, { fetchFactory: () => mockFetch(() => new Response(many)).fetch });
    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining('at most 100') });
    expect(await checkStates(id)).toEqual({});
    expect((await sourceRow(id)).last_error).toContain('MAX_CHECKS_PER_SOURCE');
  });

  it('applies POLL_MAX_RESPONSE_MB and POLL_MAX_VALUES to polls', async () => {
    await t.close();
    t = await createTestApp({ POLL_MAX_VALUES: '1000', POLL_MAX_RESPONSE_MB: '1' });
    const { id } = await t.insertSource({ type: 'uptimekuma', config: kumaConfig });
    const many = 'x 1\n'.repeat(600);
    const tooMany = await pollAndStore(t.ctx, id, { fetchFactory: () => mockFetch(() => new Response(many)).fetch });
    expect(tooMany).toMatchObject({ ok: false, message: expect.stringContaining('POLL_MAX_VALUES') });
    const large = `${'#'.repeat(1024 * 1024)}\n`;
    const tooLarge = await pollAndStore(t.ctx, id, { fetchFactory: () => mockFetch(() => new Response(large)).fetch });
    expect(tooLarge).toMatchObject({ ok: false, message: expect.stringContaining('exceeds 1 MiB') });
    expect((await sourceRow(id)).last_poll_ok).toBe(0);
    // The default fetch gets the byte limit, too.
    const factory = vi.fn(() => kumaFetch().fetch);
    await pollAndStore(t.ctx, id, { fetchFactory: factory });
    expect(factory).toHaveBeenCalledWith({ verifyTls: true, maxResponseBytes: 1024 * 1024 });
  });

  it('does not wipe existing checks when the system suddenly returns none', async () => {
    const { id } = await t.insertSource({
      type: 'icinga2',
      config: { baseUrl: 'https://icinga.example.com:5665', username: 'u', password: 'p', includeHosts: false },
    });
    await t.ctx.ingest.ingest(id, [{ externalId: 'a!b', name: 'b', state: 'ok' }], { full: false });
    const empty = mockFetch(() => Response.json({ results: [] }));
    const outcome = await pollAndStore(t.ctx, id, { fetchFactory: () => empty.fetch });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/existing checks were kept/);
    expect(await checkStates(id)).toEqual({ 'a!b': 'ok' });
  });

  it('reports invalid or undecryptable configuration', async () => {
    const { id } = await t.insertSource({ type: 'uptimekuma', config: { baseUrl: 'not a url' } });
    const outcome = await pollAndStore(t.ctx, id, { fetchFactory: () => kumaFetch().fetch });
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.message).toMatch(/Invalid configuration: check the fields baseUrl, apiKey/);

    await t.ctx.db.updateTable('monitor_sources').set({ config_encrypted: 'v1.broken.data.x' }).where('id', '=', id).execute();
    expect((await pollAndStore(t.ctx, id)).message).toMatch(/could not be decrypted/);
  });

  it('times out slow polls', async () => {
    const { id } = await t.insertSource({ type: 'uptimekuma', config: kumaConfig });
    const hanging: FetchFn = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as FetchFn;
    const outcome = await pollAndStore(t.ctx, id, { fetchFactory: () => hanging, timeoutMs: 30 });
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.message).toContain('timed out');
  });

  it('shares one poll between concurrent callers', async () => {
    const { id } = await t.insertSource({ type: 'uptimekuma', config: kumaConfig });
    const { fetch, calls } = kumaFetch();
    const [a, b] = await Promise.all([
      pollAndStore(t.ctx, id, { fetchFactory: () => fetch }),
      pollAndStore(t.ctx, id, { fetchFactory: () => fetch }),
    ]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });
});

describe('syncPollers', () => {
  it('schedules enabled pull sources and unschedules removed or disabled ones', async () => {
    const kuma = await t.insertSource({ type: 'uptimekuma', config: kumaConfig, pollIntervalSeconds: 30 });
    const disabled = await t.insertSource({ type: 'uptimekuma', config: kumaConfig, enabled: false });
    const webhook = await t.insertSource({ type: 'webhook' });
    const scheduleSpy = vi.spyOn(t.ctx.worker, 'schedule');

    await syncPollers(t.ctx);
    expect(t.ctx.worker.has(pollTaskName(kuma.id))).toBe(true);
    expect(t.ctx.worker.has(pollTaskName(disabled.id))).toBe(false);
    expect(t.ctx.worker.has(pollTaskName(webhook.id))).toBe(false);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy.mock.calls[0]![1]).toBe(30_000);

    // Unchanged sources are not rescheduled.
    await syncPollers(t.ctx);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);

    // Changed interval -> rescheduled
    await t.ctx.db
      .updateTable('monitor_sources')
      .set({ poll_interval_seconds: 120, updated_at: new Date(Date.now() + 1000).toISOString() })
      .where('id', '=', kuma.id)
      .execute();
    await syncPollers(t.ctx);
    expect(scheduleSpy).toHaveBeenCalledTimes(2);
    expect(scheduleSpy.mock.calls[1]![1]).toBe(120_000);

    // Enabled / disabled toggles
    await t.ctx.db.updateTable('monitor_sources').set({ enabled: 1 }).where('id', '=', disabled.id).execute();
    await t.ctx.db.updateTable('monitor_sources').set({ enabled: 0 }).where('id', '=', kuma.id).execute();
    await syncPollers(t.ctx);
    expect(t.ctx.worker.has(pollTaskName(kuma.id))).toBe(false);
    expect(t.ctx.worker.has(pollTaskName(disabled.id))).toBe(true);

    await t.ctx.db.deleteFrom('monitor_sources').where('id', '=', disabled.id).execute();
    await syncPollers(t.ctx);
    expect(t.ctx.worker.has(pollTaskName(disabled.id))).toBe(false);
  });

  it('scheduled tasks poll and store', async () => {
    const kuma = await t.insertSource({ type: 'uptimekuma', config: kumaConfig });
    await syncPollers(t.ctx, { fetchFactory: () => kumaFetch().fetch });
    await t.ctx.worker.runNow(pollTaskName(kuma.id));
    expect(Object.keys(await checkStates(kuma.id))).toHaveLength(5);
  });
});

describe('admin actions', () => {
  it('test polls without storing', async () => {
    const { id } = await t.insertSource({ type: 'uptimekuma', config: kumaConfig });
    const result = await testMonitorSource(t.ctx, id, { fetchFactory: () => kumaFetch().fetch });
    expect(result).toEqual({ ok: true, message: 'Connection successful: 5 checks found.', checkCount: 5 });
    expect(await checkStates(id)).toEqual({});
    expect((await sourceRow(id)).last_poll_at).toBeNull();

    const failed = await testMonitorSource(t.ctx, id, { fetchFactory: () => failingFetch(401) });
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain('check the credentials');
  });

  it('test explains push-only sources', async () => {
    const { id } = await t.insertSource({ type: 'webhook' });
    expect(await testMonitorSource(t.ctx, id)).toMatchObject({ ok: true });
  });

  it('poll now stores results and writes an audit entry', async () => {
    const { id } = await t.insertSource({ type: 'uptimekuma', config: kumaConfig });
    const result = await pollMonitorSourceNow(t.ctx, id, { fetchFactory: () => kumaFetch().fetch, userId: null });
    expect(result).toMatchObject({ ok: true, checkCount: 5 });
    expect(Object.keys(await checkStates(id))).toHaveLength(5);
    const audit = await t.ctx.db.selectFrom('audit_log').selectAll().execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'monitor_source.poll', entity_id: id });
  });

  it('poll now rejects unknown, push-only and disabled sources', async () => {
    const webhook = await t.insertSource({ type: 'webhook' });
    const disabled = await t.insertSource({ type: 'uptimekuma', config: kumaConfig, enabled: false });
    const status = (p: Promise<unknown>) => p.then(() => 200, (e: HttpError) => e.statusCode);
    expect(await status(pollMonitorSourceNow(t.ctx, 'missing'))).toBe(404);
    expect(await status(testMonitorSource(t.ctx, 'missing'))).toBe(404);
    expect(await status(pollMonitorSourceNow(t.ctx, webhook.id))).toBe(400);
    expect(await status(pollMonitorSourceNow(t.ctx, disabled.id))).toBe(409);
  });
});
