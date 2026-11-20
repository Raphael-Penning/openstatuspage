import { describe, expect, it } from 'vitest';
import { formatUtcDateTime } from '../src/lib/time.js';

describe('formatUtcDateTime', () => {
  it('writes date and time in UTC like en-GB and de-DE (medium date, short time)', () => {
    expect(formatUtcDateTime('2026-09-05T07:03:59.999Z', 'en')).toBe('5 Sept 2026, 07:03');
    expect(formatUtcDateTime('2026-09-05T07:03:59.999Z', 'de')).toBe('05.09.2026, 07:03');
    expect(formatUtcDateTime(new Date('2026-12-31T23:59:00Z'), 'en')).toBe('31 Dec 2026, 23:59');
    expect(formatUtcDateTime(new Date('2026-12-31T23:59:00Z'), 'de')).toBe('31.12.2026, 23:59');
  });

  it('matches Intl.DateTimeFormat for every month', () => {
    for (const [locale, tag] of [['en', 'en-GB'], ['de', 'de-DE']] as const) {
      const intl = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
      for (let month = 0; month < 12; month++) {
        const date = new Date(Date.UTC(2026, month, month + 1, month * 2, month * 5));
        expect(formatUtcDateTime(date, locale)).toBe(intl.format(date));
      }
    }
  });
});
