import { describe, expect, it } from 'vitest';
import { genericPushParser } from '../../src/adapters/generic.js';
import { adapters, getAdapter, isPollable } from '../../src/adapters/index.js';
import { TokenBucketLimiter } from '../../src/adapters/rate-limit.js';
import { hostState, serviceState, timestampToIso } from '../../src/adapters/states.js';

describe('state helpers', () => {
  it('maps Nagios service states', () => {
    expect([0, 1, 2, 3, 4, '2', 2.0, 'OK', 'warning', 'CRITICAL', 'Unknown', 'bogus', null].map(serviceState)).toEqual([
      'ok',
      'warning',
      'critical',
      'unknown',
      'unknown',
      'critical',
      'critical',
      'ok',
      'warning',
      'critical',
      'unknown',
      'unknown',
      'unknown',
    ]);
  });

  it('maps Nagios host states', () => {
    expect([0, 1, 2, 3, 'UP', 'DOWN', 'UNREACHABLE', 'x'].map(hostState)).toEqual([
      'ok',
      'critical',
      'critical',
      'unknown',
      'ok',
      'critical',
      'critical',
      'unknown',
    ]);
  });

  it('converts timestamps', () => {
    expect(timestampToIso(1763380800)).toBe('2025-11-17T12:00:00.000Z');
    expect(timestampToIso('1763380800')).toBe('2025-11-17T12:00:00.000Z');
    expect(timestampToIso(1763380800000)).toBe('2025-11-17T12:00:00.000Z');
    expect(timestampToIso(-1)).toBeNull();
    expect(timestampToIso('nope')).toBeNull();
  });
});

describe('adapter registry', () => {
  it('knows every source type', () => {
    expect(Object.keys(adapters).sort()).toEqual(['bundle', 'icinga2', 'openitcockpit', 'uptimekuma', 'webhook']);
    expect(isPollable('icinga2')).toBe(true);
    expect(isPollable('bundle')).toBe(false);
    expect(getAdapter('bundle')?.push).toBeUndefined();
    expect(isPollable('webhook')).toBe(false);
    expect(getAdapter('webhook')?.push).toBeUndefined();
    expect(getAdapter('toString')).toBeUndefined();
  });
});

describe('generic push parser', () => {
  it('maps numeric and named states', () => {
    const result = genericPushParser.parse(
      {
        checks: [
          { id: 'a', state: 0 },
          { id: 'b', name: 'B', host: 'h1', state: 2, output: 'down', timestamp: '2026-11-17T08:00:00Z' },
          { id: 'c', state: 'warning' },
          { id: 'd', state: 3 },
        ],
        full: true,
      },
      {},
    );
    expect(result.full).toBe(true);
    expect(result.checks).toEqual([
      // Omitted metadata stays undefined so stored values are kept.
      { externalId: 'a', name: undefined, host: undefined, state: 'ok', output: undefined, checkedAt: null },
      { externalId: 'b', name: 'B', host: 'h1', state: 'critical', output: 'down', checkedAt: '2026-11-17T08:00:00Z' },
      { externalId: 'c', name: undefined, host: undefined, state: 'warning', output: undefined, checkedAt: null },
      { externalId: 'd', name: undefined, host: undefined, state: 'unknown', output: undefined, checkedAt: null },
    ]);
  });

  it('defaults to partial updates and validates input', () => {
    expect(genericPushParser.parse({ checks: [{ id: 'a', state: 'ok' }] }, {}).full).toBe(false);
    expect(() => genericPushParser.parse({ checks: [] }, {})).toThrow();
    expect(() => genericPushParser.parse({ checks: [{ id: 'a', state: 4 }] }, {})).toThrow();
    expect(() => genericPushParser.parse({ checks: [{ id: 'a', state: 'down' }] }, {})).toThrow();
  });
});

describe('TokenBucketLimiter', () => {
  it('allows bursts up to capacity and refills over time', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 1, now: () => now });
    expect([1, 2, 3].map(() => limiter.take('a'))).toEqual([0, 0, 0]);
    expect(limiter.take('a')).toBe(1);
    // other keys are independent
    expect(limiter.take('b')).toBe(0);
    now += 1000;
    expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBe(1);
    now += 60_000;
    expect([1, 2, 3].map(() => limiter.take('a'))).toEqual([0, 0, 0]);
  });

  it('evicts idle buckets when the key limit is reached', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, maxKeys: 2, now: () => now });
    limiter.take('a');
    limiter.take('b');
    now += 5000;
    expect(limiter.take('c')).toBe(0);
    // 'a' was evicted and starts with a full bucket again
    expect(limiter.take('a')).toBe(0);
  });
});
