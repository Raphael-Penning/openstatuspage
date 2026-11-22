import { IcingaDbImporterFixture } from './icingadb-fixture.js';
import { Icinga2Config, OpenItCockpitConfig, UptimeKumaConfig } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import { createIcingaDbImporter, toPgPlaceholders } from '../../src/importers/icingadb.js';
import {
  createOpenItCockpitImporter,
  mapStatehistoryEntries,
  openItCockpitImporter,
  parseOitcTime,
} from '../../src/importers/openitcockpit.js';
import type { ImporterContext } from '../../src/importers/types.js';
import { beatsToIntervals, uptimeKumaImporter } from '../../src/importers/uptimekuma.js';
import { jsonResponse, mockFetch } from '../adapters/helpers.js';
import { fakeKuma } from './fake-kuma.js';

const t = (iso: string) => Date.parse(iso);
const H = 3_600_000;

function ctx(fetchFn: typeof fetch = (() => Promise.reject(new Error('no network'))) as typeof fetch) {
  const progress: [string, number, number][] = [];
  const c: ImporterContext = {
    signal: new AbortController().signal,
    fetch: fetchFn,
    progress: async (phase, done, total) => {
      progress.push([phase, done, total]);
    },
  };
  return { ctx: c, progress };
}

const iso = (items: { start: number; end: number; value: string }[] | undefined) =>
  items?.map((i) => [new Date(i.start).toISOString(), new Date(i.end).toISOString(), i.value]);

// ---------------------------------------------------------------------------
// Uptime Kuma
// ---------------------------------------------------------------------------

describe('Uptime Kuma importer', () => {
  const now = Date.now();
  const from = now - 6 * H;
  const fmt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
  const config = UptimeKumaConfig.parse({ baseUrl: 'https://kuma.example.com/', apiKey: 'uk1_key' });

  it('turns heartbeats into intervals and caps silent periods', () => {
    const beats = [
      { time: '2026-01-01 00:00:00.000', status: 1 },
      { time: '2026-01-01 00:01:00.000', status: 0 },
      { time: '2026-01-01 00:02:00.000', status: 1 },
      { time: 'garbage', status: 1 },
      // monitor paused for an hour
      { time: '2026-01-01 01:30:00.000', status: 2 },
    ];
    const out = beatsToIntervals(beats, 60, t('2026-01-01T00:00:00Z'), t('2026-01-01T01:40:00Z'));
    expect(iso(out)).toEqual([
      ['2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'ok'],
      ['2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z', 'critical'],
      ['2026-01-01T00:02:00.000Z', '2026-01-01T00:12:00.000Z', 'ok'],
      ['2026-01-01T01:30:00.000Z', '2026-01-01T01:40:00.000Z', 'warning'],
    ]);
  });

  it('logs in over Socket.IO long polling and reads the beats of matching monitors', async () => {
    const kuma = fakeKuma({
      monitors: [
        // Checked every 20 minutes: a beat holds for at most 60 minutes.
        { id: 1, name: 'Website', interval: 1200 },
        { id: 2, name: 'API' },
        { id: 3, name: 'Twin' },
        { id: 4, name: 'Twin' },
      ],
      beats: {
        1: [
          [fmt(from + 1 * H), 1],
          [fmt(from + 2 * H), 0],
          [fmt(from + 2 * H + 5 * 60_000), 1],
        ],
        2: [],
      },
    });
    const { ctx: c, progress } = ctx(kuma.fetch);
    const result = await uptimeKumaImporter.fetch(
      config,
      { username: 'reader', password: 'kuma-pass' },
      [
        { checkId: 'c1', externalId: 'Website' },
        { checkId: 'c2', externalId: 'API' },
        { checkId: 'c3', externalId: 'Twin' },
        { checkId: 'c4', externalId: 'Missing' },
      ],
      { from, to: from + 3 * H },
      c,
    );
    expect(iso(result.checks.get('Website'))).toEqual([
      [new Date(from + 1 * H).toISOString(), new Date(from + 2 * H).toISOString(), 'ok'],
      [new Date(from + 2 * H).toISOString(), new Date(from + 2 * H + 5 * 60_000).toISOString(), 'critical'],
      // Held for at most 3 intervals after the last beat.
      [new Date(from + 2 * H + 5 * 60_000).toISOString(), new Date(from + 3 * H).toISOString(), 'ok'],
    ]);
    expect(result.checks.has('API')).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'kuma_duplicate_name', params: { name: 'Twin' } }));
    // Whole hours from the start of the range until now, plus one (getMonitorBeats counts back from now).
    const beatCalls = kuma.received.filter((r) => r.event === 'getMonitorBeats');
    expect(beatCalls.map((r) => r.args[0])).toEqual([1, 2]);
    expect(beatCalls[0]!.args[1]).toBe(8);
    expect(kuma.received[0]).toEqual({ event: 'login', args: [{ username: 'reader', password: 'kuma-pass', token: '' }] });
    expect(progress.at(-1)).toEqual(['fetching', 4, 4]);
    // The session was closed.
    expect(kuma.requests.at(-1)!.method).toBe('POST');
  });

  it('skips a monitor whose answer is too large and reconnects for the others', async () => {
    const kuma = fakeKuma({
      totp: '123456',
      monitors: [
        { id: 1, name: 'Busy' },
        { id: 2, name: 'Website' },
      ],
      beats: { 2: [[fmt(from + H), 1]] },
      oversized: [1],
    });
    const result = await uptimeKumaImporter.fetch(
      config,
      { username: 'reader', password: 'kuma-pass', totp: '123456' },
      [
        { checkId: 'c1', externalId: 'Busy' },
        { checkId: 'c2', externalId: 'Website' },
      ],
      { from, to: now },
      ctx(kuma.fetch).ctx,
    );
    expect(result.checks.has('Busy')).toBe(false);
    expect(result.checks.get('Website')).toHaveLength(1);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'kuma_monitor_failed', params: { name: 'Busy', reason: expect.stringMatching(/exceeds 50 MiB/) } }),
    ]);
    // The second session logged in with the token of the first (no new 2FA code needed).
    expect(kuma.sessions()).toBe(2);
    expect(kuma.received.map((r) => r.event)).toEqual(['login', 'getMonitorBeats', 'loginByToken', 'getMonitorBeats']);
  });

  it('uses the stored history login and supports a 2FA code', async () => {
    const kuma = fakeKuma({ totp: '123456', monitors: [{ id: 1, name: 'Website' }], beats: { 1: [[fmt(from + H), 1]] } });
    const stored = UptimeKumaConfig.parse({ ...config, historyUsername: 'reader', historyPassword: 'kuma-pass' });
    await expect(
      uptimeKumaImporter.fetch(stored, {}, [{ checkId: 'c1', externalId: 'Website' }], { from, to: now }, ctx(kuma.fetch).ctx),
    ).rejects.toThrow(/two-factor/);
    const result = await uptimeKumaImporter.fetch(
      stored,
      { totp: '123456' },
      [{ checkId: 'c1', externalId: 'Website' }],
      { from, to: now },
      ctx(kuma.fetch).ctx,
    );
    expect(result.checks.get('Website')).toHaveLength(1);
  });

  it('reports wrong credentials and missing credentials', async () => {
    const kuma = fakeKuma({ monitors: [], beats: {} });
    await expect(
      uptimeKumaImporter.fetch(config, { username: 'reader', password: 'wrong' }, [], { from, to: now }, ctx(kuma.fetch).ctx),
    ).rejects.toThrow('Uptime Kuma: Incorrect username or password.');
    await expect(uptimeKumaImporter.fetch(config, {}, [], { from, to: now }, ctx(kuma.fetch).ctx)).rejects.toThrow(/user name and password/);
  });

  it('fails clearly when the URL is not Socket.IO', async () => {
    const { fetch } = mockFetch(() => new Response('<html></html>', { status: 200 }));
    await expect(
      uptimeKumaImporter.fetch(config, { username: 'a', password: 'b' }, [], { from, to: now }, ctx(fetch).ctx),
    ).rejects.toThrow(/handshake/);
  });
});

// ---------------------------------------------------------------------------
// Icinga DB
// ---------------------------------------------------------------------------

describe('Icinga DB importer', () => {
  const config = Icinga2Config.parse({
    baseUrl: 'https://icinga.example.com:5665',
    username: 'osp',
    password: 'secret',
    icingaDbUrl: 'mysql://reader:dbsecret@db.example.com/icingadb',
  });

  it('converts placeholders for PostgreSQL', () => {
    expect(toPgPlaceholders('a = ? AND b < ?')).toBe('a = $1 AND b < $2');
  });

  it('reads hard state history with the state before the range and the current state as fallback', async () => {
    const fixture = new IcingaDbImporterFixture();
    // web01!http: last event before the range = CRITICAL, then OK and WARNING (soft CRITICAL ignored via hard_state).
    fixture.event('web01', 'http', t('2025-12-31T20:00:00Z'), 2);
    fixture.event('web01', 'http', t('2026-01-01T02:00:00Z'), 0);
    fixture.event('web01', 'http', t('2026-01-01T05:00:00Z'), 0, 'soft', 2);
    fixture.event('web01', 'http', t('2026-01-01T06:00:00Z'), 1);
    fixture.serviceState('web01', 'http', 1, t('2026-01-01T06:00:00Z'));
    // db01 (host): no events at all (retention), DOWN since before the range.
    fixture.hostState('db01', 1, t('2025-11-01T00:00:00Z'));
    // web02!http: changed after the range end → no data.
    fixture.serviceState('web02', 'http', 0, t('2026-02-01T00:00:00Z'));
    // A check that is not requested.
    fixture.event('other', 'disk', t('2026-01-01T01:00:00Z'), 2);

    let connectedWith = '';
    const importer = createIcingaDbImporter(async (url) => {
      connectedWith = url;
      return fixture.runner();
    });
    const { ctx: c } = ctx();
    const result = await importer.fetch(
      config,
      {},
      [
        { checkId: '1', externalId: 'web01!http' },
        { checkId: '2', externalId: 'db01' },
        { checkId: '3', externalId: 'web02!http' },
      ],
      { from: t('2026-01-01T00:00:00Z'), to: t('2026-01-02T00:00:00Z') },
      c,
    );
    expect(connectedWith).toBe('mysql://reader:dbsecret@db.example.com/icingadb');
    expect(iso(result.checks.get('web01!http'))).toEqual([
      ['2026-01-01T00:00:00.000Z', '2026-01-01T02:00:00.000Z', 'critical'],
      ['2026-01-01T02:00:00.000Z', '2026-01-01T06:00:00.000Z', 'ok'],
      ['2026-01-01T06:00:00.000Z', '2026-01-02T00:00:00.000Z', 'warning'],
    ]);
    expect(iso(result.checks.get('db01'))).toEqual([['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'critical']]);
    expect(result.checks.has('web02!http')).toBe(false);
    expect(result.checks.has('other!disk')).toBe(false);
    expect(fixture.closed).toBe(true);
  });

  it('reads at most maxRows rows per query and splits busy windows', async () => {
    const fixture = new IcingaDbImporterFixture();
    // Eight state changes of one service and four of another within a day.
    for (let i = 0; i < 8; i++) fixture.event('web01', 'http', t('2026-01-01T00:00:00Z') + i * H, i % 2 === 0 ? 2 : 0);
    for (let i = 0; i < 4; i++) fixture.event('db01', 'disk', t('2026-01-01T00:30:00Z') + i * H, 1);
    const runner = fixture.runner();
    let largest = 0;
    const importer = createIcingaDbImporter(
      async () => ({
        query: async (sql, params) => {
          const rows = await runner.query(sql, params);
          largest = Math.max(largest, rows.length);
          return rows;
        },
        close: runner.close,
      }),
      { maxRows: 3 },
    );
    const result = await importer.fetch(
      config,
      {},
      [{ checkId: '1', externalId: 'web01!http' }],
      { from: t('2026-01-01T00:00:00Z'), to: t('2026-01-01T12:00:00Z') },
      ctx().ctx,
    );
    // LIMIT maxRows + 1 detects an overflow; nothing larger is ever read.
    expect(largest).toBeLessThanOrEqual(4);
    expect(result.checks.get('web01!http')).toHaveLength(8);
    expect(iso(result.checks.get('web01!http'))?.at(-1)).toEqual(['2026-01-01T07:00:00.000Z', '2026-01-01T12:00:00.000Z', 'ok']);

    // More rows than allowed within one minute: the import fails instead of reading them all.
    const dense = new IcingaDbImporterFixture();
    for (let i = 0; i < 5; i++) dense.event('web01', 'http', t('2026-01-01T00:00:00Z') + i * 1000, i % 2 === 0 ? 2 : 0);
    await expect(
      createIcingaDbImporter(async () => dense.runner(), { maxRows: 3 }).fetch(
        config,
        {},
        [{ checkId: '1', externalId: 'web01!http' }],
        { from: t('2026-01-01T00:00:00Z'), to: t('2026-01-02T00:00:00Z') },
        ctx().ctx,
      ),
    ).rejects.toThrow('Icinga DB: more than 3 rows in one query');
  });

  it('keeps at most maxEvents state changes per import', async () => {
    const fixture = new IcingaDbImporterFixture();
    for (let i = 0; i < 6; i++) fixture.event('web01', 'http', t('2026-01-01T00:00:00Z') + i * H, i % 2 === 0 ? 2 : 0);
    const importer = createIcingaDbImporter(async () => fixture.runner(), { maxEvents: 5 });
    await expect(
      importer.fetch(
        config,
        {},
        [{ checkId: '1', externalId: 'web01!http' }],
        { from: t('2026-01-01T00:00:00Z'), to: t('2026-01-02T00:00:00Z') },
        ctx().ctx,
      ),
    ).rejects.toThrow('Icinga DB: more than 5 state changes in the range');
  });

  it('prefers the one-off connection string and reports connection errors without it', async () => {
    const importer = createIcingaDbImporter(async (url) => {
      throw new Error(`cannot reach ${new URL(url).hostname}`);
    });
    await expect(
      importer.fetch(config, { databaseUrl: 'postgres://u:p@pg.example.com/icingadb' }, [], { from: 0, to: H }, ctx().ctx),
    ).rejects.toThrow('Icinga DB: connection failed: cannot reach pg.example.com');
    const noUrl = Icinga2Config.parse({ ...config, icingaDbUrl: null });
    await expect(importer.fetch(noUrl, {}, [], { from: 0, to: H }, ctx().ctx)).rejects.toThrow(/connection string is required/);
  });
});

// ---------------------------------------------------------------------------
// openITCockpit
// ---------------------------------------------------------------------------

describe('openITCockpit importer', () => {
  const config = OpenItCockpitConfig.parse({ baseUrl: 'https://oitc.example.com', apiKey: 'oitc-key' });

  it('parses the usual time formats as UTC', () => {
    const expected = t('2026-01-02T03:04:05Z');
    expect(parseOitcTime(expected / 1000)).toBe(expected);
    expect(parseOitcTime(String(expected / 1000))).toBe(expected);
    expect(parseOitcTime('2026-01-02T04:04:05+01:00')).toBe(expected);
    expect(parseOitcTime('2026-01-02 03:04:05')).toBe(expected);
    expect(parseOitcTime('02.01.2026 03:04:05')).toBe(expected);
    expect(parseOitcTime('01/02/2026 03:04:05')).toBe(expected);
    expect(parseOitcTime('03:04:05 - 02.01.2026')).toBe(expected);
    expect(parseOitcTime('02.01.2026 03:04')).toBe(t('2026-01-02T03:04:00Z'));
    expect(parseOitcTime('yesterday')).toBeNull();
  });

  it('skips soft states in statehistory responses', () => {
    const events = mapStatehistoryEntries(
      {
        all_statehistories: [
          { StatehistoryService: { state: 2, state_time: '2026-01-01 01:00:00', is_hardstate: true } },
          { StatehistoryService: { state: 0, state_time: '2026-01-01 02:00:00', is_hardstate: false } },
        ],
      },
      'service',
    );
    expect(events).toEqual([{ at: t('2026-01-01T01:00:00Z'), value: 'critical' }]);
  });

  it('maps uuids to numeric ids and reads the hard state history per check', async () => {
    const from = t('2026-01-01T00:00:00Z');
    const to = t('2026-01-02T00:00:00Z');
    const { fetch, calls } = mockFetch(({ url }) => {
      const u = new URL(url);
      if (u.pathname === '/services/index.json') {
        return jsonResponse({
          all_services: [
            {
              Service: { id: 11, uuid: 'svc-uuid-1', servicename: 'HTTP' },
              Host: { id: 1, uuid: 'host-uuid-1', hostname: 'web01' },
              Servicestatus: { currentState: 0, lastHardStateChange: '2025-12-01 00:00:00' },
            },
            {
              Service: { id: 12, uuid: 'svc-uuid-2', servicename: 'Disk' },
              Host: { id: 1, uuid: 'host-uuid-1', hostname: 'web01' },
              Servicestatus: { currentState: 1, lastHardStateChange: '2025-12-15 00:00:00' },
            },
          ],
          paging: { page: 1, pageCount: 1 },
        });
      }
      if (u.pathname === '/statehistories/service/11.json') {
        if (u.searchParams.get('direction') === 'desc') {
          return jsonResponse({ all_statehistories: [{ StatehistoryService: { state: 2, state_time: '2025-12-31 22:00:00' } }] });
        }
        const page = Number(u.searchParams.get('page'));
        const pages = [
          [{ StatehistoryService: { state: 0, state_time: '2026-01-01 03:00:00', is_hardstate: true } }],
          [{ StatehistoryService: { state: 2, state_time: '2026-01-01 08:00:00', is_hardstate: true } }],
        ];
        return jsonResponse({ all_statehistories: pages[page - 1] ?? [], paging: { page, pageCount: 2 } });
      }
      if (u.pathname === '/statehistories/service/12.json') return jsonResponse({ all_statehistories: [] });
      return new Response('not found', { status: 404 });
    });
    const result = await openItCockpitImporter.fetch(
      config,
      {},
      [
        { checkId: 'a', externalId: 'host-uuid-1!svc-uuid-1' },
        { checkId: 'b', externalId: 'host-uuid-1!svc-uuid-2' },
        { checkId: 'c', externalId: 'host-uuid-9!svc-uuid-9' },
      ],
      { from, to },
      ctx(fetch).ctx,
    );
    expect(iso(result.checks.get('host-uuid-1!svc-uuid-1'))).toEqual([
      ['2026-01-01T00:00:00.000Z', '2026-01-01T03:00:00.000Z', 'critical'],
      ['2026-01-01T03:00:00.000Z', '2026-01-01T08:00:00.000Z', 'ok'],
      ['2026-01-01T08:00:00.000Z', '2026-01-02T00:00:00.000Z', 'critical'],
    ]);
    // No history: the current state holds since its last hard change before the range.
    expect(iso(result.checks.get('host-uuid-1!svc-uuid-2'))).toEqual([
      ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'warning'],
    ]);
    expect(result.checks.has('host-uuid-9!svc-uuid-9')).toBe(false);
    const history = calls.find((c) => c.url.includes('statehistories/service/11.json') && c.url.includes('direction=asc'))!;
    const params = new URL(history.url).searchParams;
    expect(params.get('filter[from]')).toBe('2026-01-01 00:00:00');
    expect(params.get('filter[StatehistoryServices.state_type]')).toBe('1');
    expect(history.headers.get('authorization')).toBe('X-OITC-API oitc-key');
    // Hosts are only listed when a host check was requested.
    expect(calls.some((c) => c.url.includes('hosts/index.json'))).toBe(false);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'oitc_utc' })]);
  });

  it('keeps at most maxEvents state changes per import, across checks', async () => {
    const from = t('2026-01-01T00:00:00Z');
    const to = t('2026-01-02T00:00:00Z');
    const { fetch } = mockFetch(({ url }) => {
      const u = new URL(url);
      if (u.pathname === '/services/index.json') {
        return jsonResponse({
          all_services: [11, 12].map((id) => ({
            Service: { id, uuid: `svc-${id}`, servicename: `S${id}` },
            Host: { id: 1, uuid: 'host-1', hostname: 'web01' },
            Servicestatus: { currentState: 0, lastHardStateChange: '2025-12-01 00:00:00' },
          })),
          paging: { page: 1, pageCount: 1 },
        });
      }
      if (u.pathname.startsWith('/statehistories/service/')) {
        if (u.searchParams.get('direction') === 'desc') return jsonResponse({ all_statehistories: [] });
        // Three state changes per check.
        return jsonResponse({
          all_statehistories: [1, 2, 3].map((h) => ({
            StatehistoryService: { state: h % 2 === 0 ? 0 : 2, state_time: `2026-01-01 0${h}:00:00`, is_hardstate: true },
          })),
        });
      }
      return new Response('not found', { status: 404 });
    });
    const targets = [
      { checkId: 'a', externalId: 'host-1!svc-11' },
      { checkId: 'b', externalId: 'host-1!svc-12' },
    ];
    const fits = await createOpenItCockpitImporter({ maxEvents: 6 }).fetch(config, {}, targets, { from, to }, ctx(fetch).ctx);
    expect(fits.checks.get('host-1!svc-12')).toHaveLength(4);
    await expect(
      createOpenItCockpitImporter({ maxEvents: 5 }).fetch(config, {}, targets, { from, to }, ctx(fetch).ctx),
    ).rejects.toThrow('openITCockpit API: more than 5 state changes in the range');
  });

  it('lets a real event at the start of the range win over the derived start state', async () => {
    const from = t('2026-01-01T00:00:00Z');
    const to = t('2026-01-01T06:00:00Z');
    const { fetch } = mockFetch(({ url }) => {
      const u = new URL(url);
      if (u.pathname === '/services/index.json') {
        return jsonResponse({
          all_services: [
            {
              Service: { id: 11, uuid: 'svc-uuid-1', servicename: 'HTTP' },
              Host: { id: 1, uuid: 'host-uuid-1', hostname: 'web01' },
              Servicestatus: { currentState: 0, lastHardStateChange: '2026-01-01 00:00:00' },
            },
          ],
          paging: { page: 1, pageCount: 1 },
        });
      }
      if (u.pathname === '/statehistories/service/11.json') {
        if (u.searchParams.get('direction') === 'desc') {
          return jsonResponse({ all_statehistories: [{ StatehistoryService: { state: 2, state_time: '2025-12-31 22:00:00' } }] });
        }
        return jsonResponse({
          all_statehistories: [{ StatehistoryService: { state: 0, state_time: '2026-01-01 00:00:00', is_hardstate: true } }],
        });
      }
      return new Response('not found', { status: 404 });
    });
    const result = await openItCockpitImporter.fetch(
      config,
      {},
      [{ checkId: 'a', externalId: 'host-uuid-1!svc-uuid-1' }],
      { from, to },
      ctx(fetch).ctx,
    );
    expect(iso(result.checks.get('host-uuid-1!svc-uuid-1'))).toEqual([['2026-01-01T00:00:00.000Z', '2026-01-01T06:00:00.000Z', 'ok']]);
  });
});
