import { describe, expect, it } from 'vitest';
import {
  durationBetween,
  formatDateTime,
  formatDuration,
  formatMonth,
  formatRange,
  formatRelative,
  formatUtcDay,
  isSameDay,
  monthKey,
  recentMonths,
} from './time';

/** ICU versions differ in the spaces they use (U+202F, U+00A0); compare normalized. */
const n = (text: string) => text.replace(/\s/g, ' ');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatRelative', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');

  it('picks a fitting unit', () => {
    expect(formatRelative(new Date(now - 10_000), now, 'en')).toBe('now');
    expect(formatRelative(new Date(now - 5 * MIN), now, 'en')).toBe('5 minutes ago');
    expect(formatRelative(new Date(now - 2 * HOUR), now, 'en')).toBe('2 hours ago');
    expect(formatRelative(new Date(now - 3 * DAY), now, 'en')).toBe('3 days ago');
    expect(formatRelative(new Date(now + 2 * DAY), now, 'en')).toBe('in 2 days');
    expect(formatRelative(new Date(now - 400 * DAY), now, 'en')).toBe('last year');
  });

  it('follows the language', () => {
    expect(formatRelative(new Date(now - 2 * HOUR), now, 'de')).toBe('vor 2 Stunden');
  });
});

describe('formatDuration', () => {
  it('uses at most two units', () => {
    expect(n(formatDuration(45 * MIN, 'en'))).toBe('45 min');
    expect(n(formatDuration(2 * HOUR + 15 * MIN, 'en'))).toBe('2 hr 15 min');
    expect(n(formatDuration(2 * HOUR, 'en'))).toBe('2 hr');
    expect(n(formatDuration(3 * DAY + 4 * HOUR + 59 * MIN, 'en'))).toBe('3 days 4 hr');
  });

  it('handles tiny and negative values', () => {
    expect(n(formatDuration(10_000, 'en'))).toBe('< 1 min');
    expect(n(formatDuration(-5, 'en'))).toBe('< 1 min');
  });

  it('follows the language', () => {
    expect(n(formatDuration(2 * HOUR + 15 * MIN, 'de'))).toBe('2 Std. 15 Min.');
  });
});

describe('durationBetween', () => {
  it('uses now for open ends', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    expect(durationBetween('2026-11-17T11:00:00Z', null, now)).toBe(HOUR);
    expect(durationBetween('2026-11-17T11:00:00Z', '2026-11-17T11:30:00Z', now)).toBe(30 * MIN);
  });
});

describe('date formatting', () => {
  it('formats in UTC with a suffix', () => {
    expect(n(formatDateTime('2026-11-17T14:05:00Z', 'en', 'utc'))).toBe('Nov 17, 2026, 2:05 PM UTC');
    expect(n(formatDateTime('2026-11-17T14:05:00Z', 'de', 'utc'))).toBe('17.11.2026, 14:05 UTC');
  });

  it('shortens ranges within one day', () => {
    expect(n(formatRange('2026-11-17T14:00:00Z', '2026-11-17T16:00:00Z', 'en', 'utc'))).toBe(
      'Nov 17, 2026, 2:00 PM – 4:00 PM UTC',
    );
    expect(n(formatRange('2026-11-17T22:00:00Z', '2026-11-18T02:00:00Z', 'en', 'utc'))).toBe(
      'Nov 17, 2026, 10:00 PM – Nov 18, 2026, 2:00 AM UTC',
    );
  });

  it('compares days in the selected zone', () => {
    expect(isSameDay('2026-11-17T00:10:00Z', '2026-11-17T23:50:00Z', 'utc')).toBe(true);
    expect(isSameDay('2026-11-17T23:50:00Z', '2026-11-18T00:10:00Z', 'utc')).toBe(false);
  });

  it('formats UTC buckets and months', () => {
    expect(formatUtcDay('2026-11-01', 'en')).toBe('Nov 1, 2026');
    expect(formatMonth('2026-03', 'de')).toBe('März 2026');
  });
});

describe('months', () => {
  it('builds month keys in UTC', () => {
    expect(monthKey('2026-11-30T23:59:00Z')).toBe('2026-11');
    expect(recentMonths(new Date('2026-02-15T00:00:00Z'), 4)).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
  });
});
