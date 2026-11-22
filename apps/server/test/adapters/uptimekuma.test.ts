import { UptimeKumaConfig } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import { parsePrometheusText } from '../../src/adapters/prometheus.js';
import {
  kumaState,
  kumaTimeToIso,
  mapKumaMetrics,
  uptimeKumaPollAdapter,
  uptimeKumaPushParser,
} from '../../src/adapters/uptimekuma.js';
import { adapterContext, fixture, jsonFixture, mockFetch } from './helpers.js';

const config = UptimeKumaConfig.parse({ baseUrl: 'https://kuma.example.com/', apiKey: 'uk1_secretkey' });

describe('Uptime Kuma states', () => {
  it('maps up/down/pending/maintenance', () => {
    expect([1, 0, 2, 3, 7].map(kumaState)).toEqual(['ok', 'critical', 'warning', 'ok', 'unknown']);
  });
});

describe('Uptime Kuma metrics mapping', () => {
  it('maps monitor_status samples, using the monitor name as external id', () => {
    const checks = mapKumaMetrics(parsePrometheusText(fixture('uptimekuma-metrics.txt')).samples);
    expect(checks).toEqual([
      {
        externalId: 'Website',
        name: 'Website',
        host: 'www.example.com',
        state: 'ok',
        output: 'Up, type http, response time 87 ms',
        checkedAt: null,
      },
      {
        externalId: 'Mail server',
        name: 'Mail server',
        host: 'mail.example.com',
        state: 'critical',
        output: 'Down, type port',
        checkedAt: null,
      },
      {
        externalId: 'API "v2"',
        name: 'API "v2"',
        host: 'api.example.com',
        state: 'warning',
        output: 'Pending, type keyword, response time 230 ms',
        checkedAt: null,
      },
      {
        externalId: 'Storage',
        name: 'Storage',
        host: 'storage.example.com',
        state: 'ok',
        output: 'Maintenance, type ping',
        checkedAt: null,
      },
      { externalId: 'Group', name: 'Group', host: null, state: 'ok', output: 'Up, type group', checkedAt: null },
    ]);
  });

  it('ignores samples without monitor name', () => {
    expect(mapKumaMetrics(parsePrometheusText('monitor_status{monitor_type="http"} 1').samples)).toEqual([]);
  });
});

describe('Uptime Kuma poll', () => {
  it('requests /metrics with basic auth (empty user, API key as password)', async () => {
    const { fetch, calls } = mockFetch(() => new Response(fixture('uptimekuma-metrics.txt'), { status: 200 }));
    const checks = await uptimeKumaPollAdapter.poll(config, adapterContext(fetch));
    expect(checks).toHaveLength(5);
    expect(calls[0]!.url).toBe('https://kuma.example.com/metrics');
    expect(calls[0]!.headers.get('authorization')).toBe(`Basic ${Buffer.from(':uk1_secretkey').toString('base64')}`);
  });

  it('fails when the response is not Uptime Kuma metrics', async () => {
    const { fetch } = mockFetch(() => new Response('<html>login</html>', { status: 200 }));
    await expect(uptimeKumaPollAdapter.poll(config, adapterContext(fetch))).rejects.toThrow(/monitor_status/);
  });

  it('explains authentication failures', async () => {
    const { fetch } = mockFetch(() => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));
    const err = (await uptimeKumaPollAdapter.poll(config, adapterContext(fetch)).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/HTTP 401 Unauthorized for https:\/\/kuma\.example\.com\/metrics – check the credentials/);
    expect(err.message).not.toContain('uk1_secretkey');
  });
});

describe('Uptime Kuma webhook parser', () => {
  it('parses a down notification', () => {
    const result = uptimeKumaPushParser.parse(jsonFixture('uptimekuma-webhook-down.json'), {});
    expect(result).toEqual({
      full: false,
      checks: [
        {
          externalId: 'Mail server',
          name: 'Mail server',
          host: 'mail.example.com',
          state: 'critical',
          output: 'connect ECONNREFUSED',
          checkedAt: '2026-11-17T08:15:30.123Z',
        },
      ],
    });
  });

  it('accepts test notifications without changes', () => {
    expect(uptimeKumaPushParser.parse(jsonFixture('uptimekuma-webhook-test.json'), {})).toEqual({ checks: [], full: false });
  });

  it('maps every heartbeat status and derives the host from the URL', () => {
    const body = (status: number) => ({
      heartbeat: { status, msg: '' },
      monitor: { name: 'Website', url: 'https://www.example.com/health', hostname: null },
    });
    const states = [0, 1, 2, 3].map((s) => uptimeKumaPushParser.parse(body(s), {}).checks[0]!.state);
    expect(states).toEqual(['critical', 'ok', 'warning', 'ok']);
    expect(uptimeKumaPushParser.parse(body(1), {}).checks[0]!.host).toBe('www.example.com');
  });

  it('rejects heartbeats without monitor', () => {
    expect(() => uptimeKumaPushParser.parse({ heartbeat: { status: 1 } }, {})).toThrow(/monitor/);
    expect(() => uptimeKumaPushParser.parse({ heartbeat: { status: 'up' }, monitor: { name: 'x' } }, {})).toThrow();
  });

  it('bounds the length of webhook fields like the generic push format', () => {
    const body = (heartbeat: Record<string, unknown>, monitor: Record<string, unknown>) => ({
      heartbeat: { status: 1, ...heartbeat },
      monitor: { name: 'web', ...monitor },
    });
    expect(uptimeKumaPushParser.parse(body({ msg: 'x'.repeat(5000) }, { hostname: 'h'.repeat(500) }), {}).checks).toHaveLength(1);
    expect(() => uptimeKumaPushParser.parse(body({}, { hostname: 'h'.repeat(501) }), {})).toThrow();
    expect(() => uptimeKumaPushParser.parse(body({}, { url: `https://example.com/${'a'.repeat(8192)}` }), {})).toThrow();
    expect(() => uptimeKumaPushParser.parse(body({ msg: 'x'.repeat(5001) }, {}), {})).toThrow();
    expect(() => uptimeKumaPushParser.parse({ ...body({}, {}), msg: 'x'.repeat(5001) }, {})).toThrow();
  });

  it('parses heartbeat times as UTC', () => {
    expect(kumaTimeToIso('2026-11-17 08:15:30.123')).toBe('2026-11-17T08:15:30.123Z');
    expect(kumaTimeToIso('2026-11-17T08:15:30+01:00')).toBe('2026-11-17T07:15:30.000Z');
    expect(kumaTimeToIso('garbage')).toBeNull();
    expect(kumaTimeToIso(null)).toBeNull();
  });
});
