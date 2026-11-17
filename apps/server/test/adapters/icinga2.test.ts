import { Icinga2Config } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import {
  icinga2PollAdapter,
  icinga2PushParser,
  icingaApiUrl,
  mapIcingaHost,
  mapIcingaService,
} from '../../src/adapters/icinga2.js';
import { adapterContext, jsonFixture, jsonResponse, mockFetch } from './helpers.js';

const services = jsonFixture<{ results: Record<string, unknown>[] }>('icinga2-services.json');
const hosts = jsonFixture<{ results: Record<string, unknown>[] }>('icinga2-hosts.json');

const config = (overrides: Record<string, unknown> = {}) =>
  Icinga2Config.parse({
    baseUrl: 'https://icinga.example.com:5665',
    username: 'statuspage',
    password: 's3cret-password',
    ...overrides,
  });

describe('Icinga 2 mapping', () => {
  it('maps services with host!service ids, hard states and check output', () => {
    const mapped = services.results.map(mapIcingaService);
    expect(mapped[0]).toEqual({
      externalId: 'web01.example.com!https',
      name: 'HTTPS',
      host: 'web01.example.com',
      state: 'ok',
      output: 'HTTP OK: HTTP/1.1 200 OK - 1234 bytes in 0.050 second response time',
      checkedAt: '2025-11-17T12:00:00.500Z',
    });
    // Soft CRITICAL with last hard state WARNING -> warning
    expect(mapped[1]).toMatchObject({ externalId: 'db01.example.com!disk', state: 'warning' });
    // In downtime: the state is reported as is
    expect(mapped[2]).toMatchObject({ externalId: 'db01.example.com!postgres', state: 'critical' });
    expect(mapped[3]).toMatchObject({ state: 'unknown' });
    // Never checked (pending)
    expect(mapped[4]).toMatchObject({ state: 'unknown', checkedAt: null, output: 'Pending: not checked yet' });
  });

  it('maps hosts: up -> ok, down -> critical', () => {
    const mapped = hosts.results.map(mapIcingaHost);
    expect(mapped[0]).toMatchObject({ externalId: 'web01.example.com', name: 'Web 01', host: 'web01.example.com', state: 'ok' });
    expect(mapped[1]).toMatchObject({ externalId: 'db01.example.com', state: 'critical' });
  });

  it('skips entries without names', () => {
    expect(mapIcingaService({ attrs: { name: 'x' } })).toBeNull();
    expect(mapIcingaHost({ attrs: {} })).toBeNull();
  });

  it('builds API URLs with or without /v1 in the base URL', () => {
    expect(icingaApiUrl('https://icinga.example.com:5665/', 'objects/hosts')).toBe(
      'https://icinga.example.com:5665/v1/objects/hosts',
    );
    expect(icingaApiUrl('https://icinga.example.com:5665/v1', 'objects/hosts')).toBe(
      'https://icinga.example.com:5665/v1/objects/hosts',
    );
  });
});

describe('Icinga 2 poll', () => {
  it('queries services and hosts with GET and basic auth', async () => {
    const { fetch, calls } = mockFetch((call) =>
      jsonResponse(call.url.includes('/objects/hosts') ? hosts : services),
    );
    const checks = await icinga2PollAdapter.poll(config(), adapterContext(fetch));
    expect(checks).toHaveLength(7);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toMatch(/^https:\/\/icinga\.example\.com:5665\/v1\/objects\/services\?attrs=name&/);
    expect(calls[0]!.url).toContain('attrs=last_hard_state');
    expect(calls[0]!.headers.get('accept')).toBe('application/json');
    expect(calls[0]!.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('statuspage:s3cret-password').toString('base64')}`,
    );
    expect(calls[1]!.url).toContain('/v1/objects/hosts?');
  });

  it('sends filters in a POST body with X-HTTP-Method-Override and limits hosts to matching services', async () => {
    const { fetch, calls } = mockFetch((call) =>
      jsonResponse(call.url.includes('/objects/hosts') ? { results: [hosts.results[1]] } : { results: services.results.slice(1, 3) }),
    );
    const checks = await icinga2PollAdapter.poll(
      config({ filter: '"customer-facing" in service.groups' }),
      adapterContext(fetch),
    );
    expect(checks.map((c) => c.externalId)).toEqual(['db01.example.com!disk', 'db01.example.com!postgres', 'db01.example.com']);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.get('x-http-method-override')).toBe('GET');
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ filter: '"customer-facing" in service.groups' });
    expect(JSON.parse(calls[0]!.body!).attrs).toContain('last_check_result');
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({
      filter: 'host.name in osp_hosts',
      filter_vars: { osp_hosts: ['db01.example.com'] },
    });
  });

  it('skips hosts when includeHosts is false', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(services));
    const checks = await icinga2PollAdapter.poll(config({ includeHosts: false }), adapterContext(fetch));
    expect(checks).toHaveLength(5);
    expect(calls).toHaveLength(1);
  });

  it('reports HTTP errors without credentials', async () => {
    const { fetch } = mockFetch(() => jsonResponse({ error: 401, status: 'Unauthorized. Please check your user credentials.' }, 401));
    const err = await icinga2PollAdapter.poll(config(), adapterContext(fetch)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('HTTP 401');
    expect(message).toContain('Unauthorized');
    expect(message).not.toContain('s3cret-password');
    expect(message).not.toContain(Buffer.from('statuspage:s3cret-password').toString('base64'));
  });

  it('rejects unexpected response shapes', async () => {
    const { fetch } = mockFetch(() => jsonResponse({ foo: 'bar' }));
    await expect(icinga2PollAdapter.poll(config(), adapterContext(fetch))).rejects.toThrow(/no "results" array/);
  });
});

describe('Icinga 2 push parser', () => {
  it('parses a service notification', () => {
    const result = icinga2PushParser.parse(
      {
        type: 'service',
        host: 'web01.example.com',
        service: 'https',
        displayName: 'HTTPS',
        state: 'CRITICAL',
        stateId: '2',
        output: 'Connection refused',
        timestamp: '1763380800',
        notificationType: 'PROBLEM',
      },
      {},
    );
    expect(result).toEqual({
      full: false,
      checks: [
        {
          externalId: 'web01.example.com!https',
          name: 'HTTPS',
          host: 'web01.example.com',
          state: 'critical',
          output: 'Connection refused',
          checkedAt: '2025-11-17T12:00:00.000Z',
        },
      ],
    });
  });

  it('parses host notifications and state names', () => {
    const { checks } = icinga2PushParser.parse([
      { type: 'host', host: 'db01.example.com', state: 'DOWN', output: 'PING CRITICAL' },
      { host: 'db01.example.com', state: 'UP' },
      { host: 'web01.example.com', service: 'load', state: 'WARNING' },
    ], {});
    expect(checks.map((c) => [c.externalId, c.state])).toEqual([
      ['db01.example.com', 'critical'],
      ['db01.example.com', 'ok'],
      ['web01.example.com!load', 'warning'],
    ]);
  });

  it('rejects invalid payloads', () => {
    expect(() => icinga2PushParser.parse({ service: 'x', state: 'OK' }, {})).toThrow();
    expect(() => icinga2PushParser.parse({ host: 'web01' }, {})).toThrow(/state/);
    expect(() => icinga2PushParser.parse({ type: 'service', host: 'web01', state: 'OK' }, {})).toThrow(/service/);
  });
});
