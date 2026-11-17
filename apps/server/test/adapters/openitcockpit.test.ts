import { OpenItCockpitConfig } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import {
  extractEntries,
  hasNextPage,
  mapOitcHost,
  mapOitcService,
  openItCockpitPollAdapter,
  openItCockpitPushParser,
} from '../../src/adapters/openitcockpit.js';
import { adapterContext, jsonFixture, jsonResponse, mockFetch } from './helpers.js';

const page1 = jsonFixture<Record<string, unknown>>('openitcockpit-services-page1.json');
const page2 = jsonFixture<Record<string, unknown>>('openitcockpit-services-page2.json');
const hostsBody = jsonFixture<Record<string, unknown>>('openitcockpit-hosts.json');

const WEB = 'a7d1c3e2-5b4f-4e6a-8c9d-aaaaaaaaaaaa';
const DB = 'b8e2d4f3-6c5a-4f7b-9d0e-bbbbbbbbbbbb';

const config = (overrides: Record<string, unknown> = {}) =>
  OpenItCockpitConfig.parse({ baseUrl: 'https://oitc.example.com', apiKey: 'oitc-api-key-123', ...overrides });

describe('openITCockpit mapping', () => {
  it('maps service entries defensively', () => {
    const [https, load] = (page1.all_services as unknown[]).map(mapOitcService);
    expect(https).toEqual({
      externalId: `${WEB}!6b1f7a8e-0c2d-4f3a-9e1b-111111111111`,
      name: 'HTTPS',
      host: 'web01.example.com',
      state: 'ok',
      output: 'HTTP OK: HTTP/1.1 200 OK',
      // user-formatted date is ignored
      checkedAt: null,
    });
    expect(load).toMatchObject({ state: 'warning', name: 'Load' });

    const [pg, backup] = (page2.all_services as unknown[]).map(mapOitcService);
    expect(pg).toMatchObject({ host: 'db01.example.com', state: 'critical', checkedAt: '2026-11-17T08:59:30.000Z' });
    expect(backup).toMatchObject({ state: 'unknown', output: 'No status available' });
  });

  it('accepts alternative field names', () => {
    expect(
      mapOitcService({
        service: { id: 5, name: 'Ping', hostname: 'web02.example.com', host_id: 9 },
        Servicestatus: { current_state: '2', output: 'down' },
      }),
    ).toEqual({ externalId: '9!5', name: 'Ping', host: 'web02.example.com', state: 'critical', output: 'down', checkedAt: null });
    expect(mapOitcService({ Service: {} })).toBeNull();
  });

  it('maps hosts: up -> ok, down/unreachable -> critical', () => {
    const [web, db] = (hostsBody.all_hosts as unknown[]).map(mapOitcHost);
    expect(web).toMatchObject({ externalId: WEB, name: 'web01.example.com', state: 'ok' });
    expect(db).toMatchObject({ externalId: DB, state: 'critical' });
    expect(mapOitcHost({ Host: { name: 'x' }, Hoststatus: { currentState: 1 } })).toMatchObject({ externalId: 'x', state: 'critical' });
  });

  it('finds result arrays and paging info', () => {
    expect(extractEntries(page1, 'services')).toHaveLength(2);
    expect(extractEntries({ something: [{ a: 1 }] }, 'hosts')).toHaveLength(1);
    expect(extractEntries({ error: 'x' }, 'hosts')).toBeNull();
    expect(hasNextPage(page1, 1)).toBe(true);
    expect(hasNextPage(page2, 2)).toBe(false);
    expect(hasNextPage({ paging: { pageCount: 3 } }, 2)).toBe(true);
    expect(hasNextPage({}, 1)).toBe(false);
  });
});

describe('openITCockpit poll', () => {
  it('follows pagination and sends the API key header', async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.includes('/hosts/')) return jsonResponse(hostsBody);
      return jsonResponse(call.url.includes('page=2') ? page2 : page1);
    });
    const checks = await openItCockpitPollAdapter.poll(config(), adapterContext(fetch));
    expect(calls.map((c) => c.url)).toEqual([
      'https://oitc.example.com/services/index.json?angular=true&page=1',
      'https://oitc.example.com/services/index.json?angular=true&page=2',
      'https://oitc.example.com/hosts/index.json?angular=true&page=1',
    ]);
    expect(calls[0]!.headers.get('authorization')).toBe('X-OITC-API oitc-api-key-123');
    expect(checks).toHaveLength(6);
  });

  it('stops when the server ignores the page parameter', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(page1));
    const checks = await openItCockpitPollAdapter.poll(config({ includeHosts: false }), adapterContext(fetch));
    expect(checks).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it('reports redirects to the login page', async () => {
    const { fetch } = mockFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://oitc.example.com/users/login?token=abc' } }),
    );
    const err = (await openItCockpitPollAdapter.poll(config(), adapterContext(fetch)).catch((e: Error) => e)) as Error;
    expect(err.message).toContain('redirected (HTTP 302)');
    expect(err.message).toContain('https://oitc.example.com/users/login');
    expect(err.message).not.toContain('token=abc');
    expect(err.message).not.toContain('oitc-api-key-123');
  });

  it('rejects HTML responses', async () => {
    const { fetch } = mockFetch(() => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }));
    await expect(openItCockpitPollAdapter.poll(config(), adapterContext(fetch))).rejects.toThrow(/did not return JSON/);
  });
});

describe('openITCockpit push parser', () => {
  it('parses service and host notifications with UUID ids', () => {
    const { checks, full } = openItCockpitPushParser.parse(
      [
        {
          type: 'service',
          host: WEB,
          service: '6b1f7a8e-0c2d-4f3a-9e1b-111111111111',
          hostDisplayName: 'web01.example.com',
          serviceDisplayName: 'HTTPS',
          stateId: '2',
          output: 'CRITICAL - timeout',
          timestamp: '1763380800',
        },
        { type: 'host', host: DB, hostDisplayName: '$HOSTDISPLAYNAME$', stateId: 1 },
      ],
      {},
    );
    expect(full).toBe(false);
    expect(checks[0]).toEqual({
      externalId: `${WEB}!6b1f7a8e-0c2d-4f3a-9e1b-111111111111`,
      name: 'HTTPS',
      host: 'web01.example.com',
      state: 'critical',
      output: 'CRITICAL - timeout',
      checkedAt: '2025-11-17T12:00:00.000Z',
    });
    // Unresolved macros fall back to the UUID
    expect(checks[1]).toMatchObject({ externalId: DB, name: DB, state: 'critical' });
  });

  it('matches the ids of the pull adapter', () => {
    const pulled = mapOitcService((page1.all_services as unknown[])[0])!;
    const pushed = openItCockpitPushParser.parse(
      { host: WEB, service: '6b1f7a8e-0c2d-4f3a-9e1b-111111111111', stateId: 0 },
      {},
    ).checks[0]!;
    expect(pushed.externalId).toBe(pulled.externalId);
  });

  it('rejects payloads without state', () => {
    expect(() => openItCockpitPushParser.parse({ host: WEB }, {})).toThrow();
  });
});
