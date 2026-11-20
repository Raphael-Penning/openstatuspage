import { describe, expect, it } from 'vitest';
import { isUptimeDay, serviceDayPath, servicePath, shiftUptimeDay, uptimeDayOf, uptimeDayStart } from './days.js';

describe('uptime days', () => {
  it('accept only real calendar days in the bucket format', () => {
    expect(uptimeDayStart('2026-11-20')).toBe(Date.UTC(2026, 10, 20));
    expect(isUptimeDay('2024-02-29')).toBe(true);
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-1-01', '20261120', '2026-11-20T00:00', ' 2026-11-20', '0099-01-01x', '']) {
      expect(isUptimeDay(bad), bad).toBe(false);
    }
  });

  it('shift across months and years in UTC', () => {
    expect(shiftUptimeDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftUptimeDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(uptimeDayOf(Date.UTC(2026, 10, 20, 23, 59))).toBe('2026-11-20');
    expect(() => shiftUptimeDay('nope', 1)).toThrow();
  });

  it('build day page paths below an optional base path', () => {
    expect(servicePath({ id: 'svc-1', slug: 'api' })).toBe('/services/api');
    expect(servicePath({ id: 'svc-1', slug: '' })).toBe('/services/svc-1');
    expect(serviceDayPath({ id: 'svc-1', slug: 'api' }, '2026-11-20')).toBe('/services/api/days/2026-11-20');
    expect(serviceDayPath({ id: 'svc-1', slug: 'a b' }, '2026-11-20', '/p/tok')).toBe('/p/tok/services/a%20b/days/2026-11-20');
  });
});
