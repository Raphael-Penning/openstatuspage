import type { AdminHistoryImport, AdminMonitorSource, CheckState } from '@openstatuspage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/lib/crypto.js';
import { newId } from '../src/lib/ids.js';
import { nowIso } from '../src/lib/time.js';
import type { HistoryImporter } from '../src/importers/types.js';
import { BUNDLE_SOURCE_ID } from '../src/services/bundles.js';
import { IMPORT_STALE_MS } from '../src/services/history-import.js';
import { adminClient, client, createTestApp, createUser, login, seedChecks, type Client, type TestApp } from './helpers.js';
import { fakeKuma } from './importers/fake-kuma.js';

const H = 3_600_000;
const DAY = 24 * H;

let t: TestApp;
let admin: Client;
let now: number;
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();

beforeEach(async () => {
  t = await createTestApp();
  admin = await adminClient(t);
  now = Date.now();
});

afterEach(async () => {
  await t.close();
});

async function addService(
  name: string,
  checkIds: string[],
  opts: { statusMode?: 'auto' | 'manual'; aggregation?: 'worst' | 'quorum' } = {},
): Promise<string> {
  const id = newId();
  const ts = nowIso();
  await t.db
    .insertInto('services')
    .values({
      id,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      name,
      description: null,
      kind: 'service',
      url: null,
      group_id: null,
      sort_order: 0,
      is_public: 1,
      status_mode: opts.statusMode ?? 'auto',
      manual_status: 'operational',
      aggregation: opts.aggregation ?? 'worst',
      current_status: 'operational',
      monitor_status: 'operational',
      status_changed_at: null,
      created_at: ts,
      updated_at: ts,
    })
    .execute();
  for (const checkId of checkIds) {
    await t.db
      .insertInto('service_checks')
      .values({ service_id: id, check_id: checkId, warning_status: 'degraded', critical_status: 'major_outage', unknown_status: null })
      .execute();
  }
  await t.app.ctx.engine.recompute([id]);
  return id;
}

const csv = (rows: [string, number, number, string][], column: 'check' | 'service' = 'check') =>
  [`${column},start,end,state`, ...rows.map(([id, s, e, state]) => `${id},${at(s)},${at(e)},${state}`)].join('\n');

async function start(sourceId: string, body: Record<string, unknown>, c: Client = admin): Promise<AdminHistoryImport> {
  const res = await c.post(`/api/admin/monitor-sources/${sourceId}/history-imports`, body);
  expect(res.statusCode, res.body).toBe(202);
  return res.json<AdminHistoryImport>();
}

async function settle(sourceId: string, id: string): Promise<AdminHistoryImport> {
  await t.app.ctx.worker.idle();
  const res = await admin.get(`/api/admin/monitor-sources/${sourceId}/history-imports/${id}`);
  expect(res.statusCode).toBe(200);
  return res.json<AdminHistoryImport>();
}

async function apply(sourceId: string, id: string): Promise<AdminHistoryImport> {
  const res = await admin.post(`/api/admin/monitor-sources/${sourceId}/history-imports/${id}/apply`);
  expect(res.statusCode, res.body).toBe(202);
  return settle(sourceId, id);
}

async function segments(serviceId: string) {
  return t.db
    .selectFrom('service_status_history')
    .select(['status', 'started_at', 'ended_at', 'source'])
    .where('service_id', '=', serviceId)
    .orderBy('started_at')
    .execute();
}

const twoChecks = () =>
  seedChecks(t, [
    { externalId: 'web01!http', name: 'HTTP', host: 'web01', state: 'ok' },
    { externalId: 'web02!http', name: 'HTTP', host: 'web02', state: 'ok' },
  ]);

describe('history import (CSV)', () => {
  it('previews, applies and fills only the gaps before the live history', async () => {
    const { sourceId, checkIds } = await twoChecks();
    const service = await addService('Website', [checkIds['web01!http']!]);
    const job = await start(sourceId, {
      from: at(-3 * DAY),
      to: at(-1 * DAY),
      csv: csv([
        ['web01!http', -3 * DAY, -2 * DAY, 'critical'],
        ['web01!http', -2 * DAY, -1 * DAY, 'ok'],
        ['unknown!check', -2 * DAY, -1 * DAY, 'ok'],
      ]),
    });
    expect(job.status).toBe('fetching');

    const ready = await settle(sourceId, job.id);
    expect(ready.status).toBe('ready');
    const preview = ready.preview!;
    expect(preview.unmatched).toEqual(['unknown!check']);
    expect(preview.checks).toHaveLength(1);
    expect(preview.checks[0]).toMatchObject({ externalId: 'web01!http', intervals: 2, coveredMs: 2 * DAY });
    expect(preview.checks[0]!.stateMs).toEqual({ critical: DAY, ok: DAY });
    expect(preview.services).toHaveLength(1);
    expect(preview.services[0]).toMatchObject({
      serviceId: service,
      skipped: null,
      gapMs: 2 * DAY,
      filledMs: 2 * DAY,
      downMs: DAY,
      uptime: 50,
      uptimeBefore: null,
      segmentCount: 2,
    });
    // Nothing is written before confirmation.
    expect((await segments(service)).filter((s) => s.source === 'import')).toHaveLength(0);

    const done = await apply(sourceId, job.id);
    expect(done.status).toBe('completed');
    expect(done.result).toEqual({ checkIntervals: 2, serviceSegments: 2, services: 1 });

    const rows = await segments(service);
    expect(rows.map((r) => [r.status, r.source])).toEqual([
      ['major_outage', 'import'],
      ['operational', 'import'],
      ['operational', 'live'],
    ]);
    expect(rows[0]!.started_at).toBe(at(-3 * DAY));
    const checkRows = await t.db
      .selectFrom('monitor_check_history')
      .select(['state', 'source'])
      .where('check_id', '=', checkIds['web01!http']!)
      .orderBy('started_at')
      .execute();
    expect(checkRows).toEqual([
      { state: 'critical', source: 'import' },
      { state: 'ok', source: 'import' },
      { state: 'ok', source: 'live' },
    ]);
    // Staged data is removed, the audit log has the whole story without the file content.
    expect(await t.db.selectFrom('history_import_intervals').selectAll().execute()).toHaveLength(0);
    const audit = await t.db.selectFrom('audit_log').select(['action', 'details']).where('action', 'like', 'history_import.%').orderBy('created_at').execute();
    expect(audit.map((a) => a.action)).toEqual(['history_import.start', 'history_import.apply', 'history_import.complete']);
    expect(JSON.parse(audit[0]!.details!)).toMatchObject({ method: 'csv', csvRows: 3 });

    // The public uptime bars now include the imported days.
    const pub = await t.app.inject({ method: 'GET', url: '/api/public/services/website' });
    expect(pub.statusCode).toBe(200);
    const uptime = pub.json<{ uptime: { date: string; uptime: number | null }[] }>().uptime;
    const day = (offset: number) => uptime.find((u) => u.date === at(offset).slice(0, 10))!;
    expect(day(-2.5 * DAY).uptime).not.toBeNull();
    expect(JSON.stringify(pub.json())).not.toContain('web01');
  });

  it('never overwrites live history and is idempotent on re-runs', async () => {
    const { sourceId, checkIds } = await twoChecks();
    const service = await addService('Website', [checkIds['web01!http']!]);
    // A live segment in the middle of the range (e.g. an earlier installation).
    await t.db
      .insertInto('service_status_history')
      .values({ id: newId(), service_id: service, status: 'degraded', started_at: at(-2 * DAY), ended_at: at(-2 * DAY + 6 * H), source: 'live' })
      .execute();
    const body = {
      from: at(-3 * DAY),
      to: at(-1 * DAY),
      csv: csv([['web01!http', -3 * DAY, -1 * DAY, 'critical']]),
    };
    const first = await start(sourceId, body);
    const ready = await settle(sourceId, first.id);
    expect(ready.preview!.services[0]).toMatchObject({ gapMs: 2 * DAY - 6 * H, filledMs: 2 * DAY - 6 * H });
    await apply(sourceId, first.id);
    const afterFirst = await segments(service);
    expect(afterFirst.map((s) => [s.status, s.source, s.started_at, s.ended_at])).toEqual([
      ['major_outage', 'import', at(-3 * DAY), at(-2 * DAY)],
      ['degraded', 'live', at(-2 * DAY), at(-2 * DAY + 6 * H)],
      ['major_outage', 'import', at(-2 * DAY + 6 * H), at(-1 * DAY)],
      ['operational', 'live', expect.any(String), null],
    ]);

    const second = await start(sourceId, body);
    const again = await apply(sourceId, (await settle(sourceId, second.id)).id);
    expect(again.status).toBe('completed');
    expect(await segments(service)).toEqual(afterFirst);
    const importedChecks = await t.db
      .selectFrom('monitor_check_history')
      .select('id')
      .where('source', '=', 'import')
      .execute();
    expect(importedChecks).toHaveLength(1);
  });

  it('applies explicit service rows, skips manual services and replays bundles', async () => {
    const { sourceId, checkIds } = await twoChecks();
    const manual = await addService('Manual', [checkIds['web01!http']!], { statusMode: 'manual' });
    const checkout = await addService('Checkout', []);
    // Bundle: web01 (2 votes) and web02 (1 vote).
    const res = await admin.post('/api/admin/check-bundles', {
      name: 'Web',
      members: [
        { checkId: checkIds['web01!http']!, votes: 2 },
        { checkId: checkIds['web02!http']!, votes: 1 },
      ],
    });
    expect(res.statusCode).toBe(201);
    const bundleService = await addService('Web', [res.json<{ checkId: string }>().checkId]);

    const job = await start(sourceId, {
      from: at(-3 * DAY),
      to: at(-1 * DAY),
      csv: [
        'check,service,start,end,state',
        `web01!http,,${at(-3 * DAY)},${at(-1 * DAY)},critical`,
        `web02!http,,${at(-3 * DAY)},${at(-2 * DAY)},ok`,
        `,checkout,${at(-3 * DAY)},${at(-1 * DAY)},maintenance`,
      ].join('\n'),
    });
    const ready = await settle(sourceId, job.id);
    const byId = new Map(ready.preview!.services.map((s) => [s.serviceId, s]));
    expect(byId.get(manual)!.skipped).toBe('manual');
    expect(byId.get(checkout)).toMatchObject({ filledMs: 2 * DAY, downMs: 0 });
    // 2 of 3 votes critical the whole time (web02 does not report on day 2): down for 2 days.
    expect(byId.get(bundleService)).toMatchObject({ filledMs: 2 * DAY, downMs: 2 * DAY, segmentCount: 1 });
    await apply(sourceId, job.id);
    expect((await segments(manual)).every((s) => s.source === 'live')).toBe(true);
    expect((await segments(checkout))[0]).toMatchObject({ status: 'maintenance', source: 'import' });
  });

  it('validates input, roles and conflicts', async () => {
    const { sourceId, checkIds } = await twoChecks();
    await addService('Website', [checkIds['web01!http']!]);
    const base = `/api/admin/monitor-sources/${sourceId}/history-imports`;
    const body = { from: at(-2 * DAY), to: at(-DAY), csv: csv([['web01!http', -2 * DAY, -DAY, 'ok']]) };

    await createUser(t.db, { email: 'editor@example.com', role: 'editor' });
    const editor = client(t.app, { cookie: await login(t.app, 'editor@example.com') });
    expect((await editor.post(base, body)).statusCode).toBe(403);
    expect((await editor.get(base)).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: base })).statusCode).toBe(401);

    expect((await admin.post(`/api/admin/monitor-sources/${newId()}/history-imports`, body)).statusCode).toBe(404);
    // Webhook sources have no history API.
    expect((await admin.post(base, { from: body.from, to: body.to })).statusCode).toBe(400);
    expect((await admin.post(base, { ...body, from: at(DAY), to: at(2 * DAY) })).statusCode).toBe(400);
    expect((await admin.post(base, { ...body, to: body.from })).statusCode).toBe(400);
    expect((await admin.post(base, { ...body, from: at(-800 * DAY) })).statusCode).toBe(400);
    const invalid = await admin.post(base, { ...body, csv: 'check,start,end,state\nweb01!http,yesterday,today,ok' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ issues: { line: number }[] }>().issues[0]!.line).toBe(2);

    const job = await start(sourceId, body);
    await settle(sourceId, job.id);
    expect((await admin.post(base, body)).statusCode).toBe(409);
    expect((await editor.post(`${base}/${job.id}/apply`)).statusCode).toBe(403);

    // The bundle source has no history of its own.
    await t.app.ctx.bundles.ensureSource();
    expect((await admin.post(`/api/admin/monitor-sources/${BUNDLE_SOURCE_ID}/history-imports`, body)).statusCode).toBe(409);

    // Cancel discards the preview; it can no longer be applied.
    const cancelled = await admin.post(`${base}/${job.id}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<AdminHistoryImport>().status).toBe('cancelled');
    expect((await admin.post(`${base}/${job.id}/apply`)).statusCode).toBe(409);
    expect((await admin.post(`${base}/${job.id}/cancel`)).statusCode).toBe(409);
    expect(await t.db.selectFrom('history_import_intervals').selectAll().execute()).toHaveLength(0);

    const list = await admin.get(base);
    expect(list.json<AdminHistoryImport[]>().map((j) => j.status)).toEqual(['cancelled']);
  });
});

describe('history import (sources)', () => {
  async function kumaSource(config: Record<string, unknown>): Promise<string> {
    const id = newId();
    const ts = nowIso();
    await t.db
      .insertInto('monitor_sources')
      .values({
        id,
        name: 'Kuma',
        type: 'uptimekuma',
        enabled: 1,
        config_encrypted: t.app.ctx.secrets.encryptJson({ baseUrl: 'https://kuma.example.com', apiKey: 'uk1_key', ...config }),
        poll_interval_seconds: 60,
        ingest_token_hash: sha256(newId()),
        last_poll_at: null,
        last_poll_ok: null,
        last_error: null,
        created_at: ts,
        updated_at: ts,
      })
      .execute();
    await t.app.ctx.ingest.ingest(id, [{ externalId: 'Website', name: 'Website', state: 'ok' }], { full: false });
    return id;
  }

  it('imports Uptime Kuma heartbeats with one-off credentials that are never kept or shown', async () => {
    const sourceId = await kumaSource({});
    const check = await t.db.selectFrom('monitor_checks').select('id').where('source_id', '=', sourceId).executeTakeFirstOrThrow();
    const service = await addService('Website', [check.id]);
    const fmt = (ms: number) => new Date(now + ms).toISOString().replace('T', ' ').replace('Z', '');
    const kuma = fakeKuma({
      username: 'history',
      password: 'one-off-secret',
      monitors: [{ id: 7, name: 'Website', interval: 3600 }],
      beats: { 7: [[fmt(-2 * DAY), 1], [fmt(-2 * DAY + H), 0], [fmt(-2 * DAY + 2 * H), 1], [fmt(-2 * DAY + 3 * H), 1]] },
    });
    t.app.ctx.historyImports.fetchFactory = () => kuma.fetch;

    // Without stored or entered credentials the import is rejected right away.
    expect((await admin.post(`/api/admin/monitor-sources/${sourceId}/history-imports`, { from: at(-3 * DAY), to: at(-DAY) })).statusCode).toBe(400);

    const job = await start(sourceId, {
      from: at(-3 * DAY),
      to: at(-DAY),
      credentials: { username: 'history', password: 'one-off-secret' },
    });
    const ready = await settle(sourceId, job.id);
    expect(ready.status, ready.error ?? '').toBe('ready');
    expect(ready.preview!.checks[0]).toMatchObject({ intervals: 3, coveredMs: 6 * H });
    expect(ready.preview!.services[0]).toMatchObject({ serviceId: service, filledMs: 6 * H, downMs: H });

    const row = await t.db.selectFrom('history_imports').selectAll().where('id', '=', job.id).executeTakeFirstOrThrow();
    expect(row.credentials_encrypted).toBeNull();
    const everything = JSON.stringify([ready, row, await t.db.selectFrom('audit_log').selectAll().execute()]);
    expect(everything).not.toContain('one-off-secret');

    const done = await apply(sourceId, job.id);
    expect(done.result).toMatchObject({ checkIntervals: 3, serviceSegments: 3 });
  });

  it('stores the history login as an encrypted, masked secret of the source', async () => {
    const res = await admin.post('/api/admin/monitor-sources', {
      name: 'Kuma',
      type: 'uptimekuma',
      config: { baseUrl: 'https://kuma.example.com', apiKey: 'uk1_key', historyUsername: 'history', historyPassword: 'stored-secret' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const source = res.json<AdminMonitorSource>();
    expect(source.config.historyPassword).toBe('••••••••');
    expect(res.body).not.toContain('stored-secret');
    // Changing the history user requires the password again.
    const put = await admin.put(`/api/admin/monitor-sources/${source.id}`, {
      name: 'Kuma',
      type: 'uptimekuma',
      config: { baseUrl: 'https://kuma.example.com', apiKey: '••••••••', historyUsername: 'other', historyPassword: '••••••••' },
    });
    expect(put.statusCode).toBe(400);
    const keep = await admin.put(`/api/admin/monitor-sources/${source.id}`, {
      name: 'Kuma renamed',
      type: 'uptimekuma',
      config: { baseUrl: 'https://kuma.example.com', apiKey: '••••••••', historyUsername: 'history', historyPassword: '••••••••' },
    });
    expect(keep.statusCode, keep.body).toBe(200);
    const stored = await t.db.selectFrom('monitor_sources').select('config_encrypted').where('id', '=', source.id).executeTakeFirstOrThrow();
    expect(t.app.ctx.secrets.decryptJson<Record<string, unknown>>(stored.config_encrypted).historyPassword).toBe('stored-secret');
  });

  it('reports importer failures without secrets and can be cancelled while fetching', async () => {
    const sourceId = await kumaSource({ historyUsername: 'history', historyPassword: 'stored-secret' });
    const check = await t.db.selectFrom('monitor_checks').select('id').where('source_id', '=', sourceId).executeTakeFirstOrThrow();
    await addService('Website', [check.id]);

    const failing: HistoryImporter = {
      type: 'uptimekuma',
      async fetch() {
        throw new Error('login failed for stored-secret');
      },
    };
    t.app.ctx.historyImports.importers = { uptimekuma: failing };
    const failed = await settle(sourceId, (await start(sourceId, { from: at(-2 * DAY), to: at(-DAY) })).id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('login failed for ***');

    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const slow: HistoryImporter = {
      type: 'uptimekuma',
      async fetch(_c, _cred, _targets, _range, ctx) {
        started();
        await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        return { checks: new Map(), warnings: [] };
      },
    };
    t.app.ctx.historyImports.importers = { uptimekuma: slow };
    const job = await start(sourceId, { from: at(-2 * DAY), to: at(-DAY) });
    await running;
    const cancel = await admin.post(`/api/admin/monitor-sources/${sourceId}/history-imports/${job.id}/cancel`);
    expect(cancel.json<AdminHistoryImport>().status).toBe('cancelled');
    expect((await settle(sourceId, job.id)).status).toBe('cancelled');
  });

  it('fails jobs that stopped making progress', async () => {
    const { sourceId } = await twoChecks();
    const id = newId();
    const old = new Date(now - IMPORT_STALE_MS - 60_000).toISOString();
    await t.db
      .insertInto('history_imports')
      .values({
        id,
        source_id: sourceId,
        status: 'fetching',
        range_from: at(-2 * DAY),
        range_to: at(-DAY),
        only_linked: 1,
        progress: null,
        credentials_encrypted: 'v1.x.y.z',
        fetch_summary: null,
        preview: null,
        result: null,
        error: null,
        created_by: null,
        created_at: old,
        updated_at: old,
        finished_at: null,
      })
      .execute();
    await t.app.ctx.historyImports.cleanup();
    const row = await t.db.selectFrom('history_imports').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('failed');
    expect(row.credentials_encrypted).toBeNull();
  });
});

describe('live check history', () => {
  it('records state changes of checks and bundles', async () => {
    const { sourceId, checkIds } = await twoChecks();
    const id = checkIds['web01!http']!;
    const ingest = (state: CheckState) =>
      t.app.ctx.ingest.ingest(sourceId, [{ externalId: 'web01!http', state }], { full: false });
    await ingest('ok'); // unchanged: no new row
    await ingest('critical');
    await ingest('ok');
    const rows = await t.db
      .selectFrom('monitor_check_history')
      .select(['state', 'ended_at', 'source'])
      .where('check_id', '=', id)
      .orderBy('started_at')
      .orderBy('ended_at')
      .execute();
    // Changes within one millisecond share timestamps: compare without order.
    expect(rows.map((r) => r.state).sort()).toEqual(['critical', 'ok', 'ok']);
    expect(rows.filter((r) => r.ended_at === null).map((r) => r.state)).toEqual(['ok']);
    expect(rows.every((r) => r.source === 'live')).toBe(true);

    const res = await admin.post('/api/admin/check-bundles', { name: 'Web', members: [{ checkId: id, votes: 1 }] });
    const bundleCheck = res.json<{ checkId: string }>().checkId;
    const bundleRows = await t.db.selectFrom('monitor_check_history').select('state').where('check_id', '=', bundleCheck).orderBy('started_at').execute();
    // Created as unknown, then the first vote.
    expect(bundleRows.map((r) => r.state).sort()).toEqual(['ok', 'unknown']);
  });
});
