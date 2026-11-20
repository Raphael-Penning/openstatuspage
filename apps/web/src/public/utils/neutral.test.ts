import { describe, expect, it } from 'vitest';
import { neutral } from './time';
import { formatPercent, formatPercentNeutral } from './uptime';

/** The ICU-free formatting of the server render and the hydration render. */
describe('neutral formatting', () => {
  it('writes ISO dates and 24-hour times in UTC', () => {
    expect(neutral.dateTime('2026-11-17T14:05:59Z')).toBe('2026-11-17 14:05 UTC');
    expect(neutral.date('2026-11-17T23:59:00Z')).toBe('2026-11-17');
    expect(neutral.time('2026-11-17T09:00:00Z')).toBe('09:00 UTC');
    expect(neutral.range('2026-11-17T14:00:00Z', '2026-11-17T16:00:00Z')).toBe('2026-11-17 14:00 – 16:00 UTC');
    expect(neutral.range('2026-11-17T22:00:00Z', '2026-11-18T02:00:00Z')).toBe('2026-11-17 22:00 – 2026-11-18 02:00 UTC');
  });

  it('writes durations with at most two units', () => {
    expect(neutral.duration(30_000)).toBe('< 1 min');
    expect(neutral.duration(45 * 60_000)).toBe('45 min');
    expect(neutral.duration(135 * 60_000)).toBe('2 h 15 min');
    expect(neutral.duration(120 * 60_000)).toBe('2 h');
    expect(neutral.duration((3 * 24 + 4) * 3600_000 + 5 * 60_000)).toBe('3 d 4 h');
  });

  it('writes percentages like Intl does for the UI languages', () => {
    for (const value of [99.95, 100, 99.5, 0, 12.345]) {
      expect(formatPercentNeutral(value, 'en')).toBe(formatPercent(value, 'en'));
      expect(formatPercentNeutral(value, 'de')).toBe(formatPercent(value, 'de'));
    }
  });
});
