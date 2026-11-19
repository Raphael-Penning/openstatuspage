import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dateInputToIso, formatRelative, formatUtcOffset, isoToLocalInput, localInputToIso, timeZoneLabel } from './datetime';

const originalTz = process.env.TZ;

describe('datetime-local conversion', () => {
  beforeAll(() => {
    // Node applies TZ changes at runtime; use a zone with DST to cover offsets.
    process.env.TZ = 'Europe/Berlin';
  });
  afterAll(() => {
    process.env.TZ = originalTz;
  });

  it('converts UTC ISO timestamps to local input values', () => {
    expect(isoToLocalInput('2026-01-15T10:30:00.000Z')).toBe('2026-01-15T11:30');
    expect(isoToLocalInput('2026-07-15T10:30:00.000Z')).toBe('2026-07-15T12:30');
  });

  it('converts local input values to UTC ISO timestamps', () => {
    expect(localInputToIso('2026-01-15T11:30')).toBe('2026-01-15T10:30:00.000Z');
    expect(localInputToIso('2026-07-15T12:30')).toBe('2026-07-15T10:30:00.000Z');
    expect(localInputToIso('2026-07-15T12:30:45')).toBe('2026-07-15T10:30:45.000Z');
  });

  it('converts date input values to local midnight in UTC', () => {
    expect(dateInputToIso('2026-01-15')).toBe('2026-01-14T23:00:00.000Z');
    expect(dateInputToIso('2026-07-15', 1)).toBe('2026-07-15T22:00:00.000Z');
    expect(dateInputToIso('2026-02-31')).toBeNull();
    expect(dateInputToIso('')).toBeNull();
    expect(dateInputToIso('15.01.2026')).toBeNull();
  });

  it('round-trips', () => {
    const iso = '2026-03-29T00:45:00.000Z';
    expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
  });

  it('handles empty and invalid values', () => {
    expect(isoToLocalInput(null)).toBe('');
    expect(isoToLocalInput('')).toBe('');
    expect(isoToLocalInput('not a date')).toBe('');
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso(undefined)).toBeNull();
    expect(localInputToIso('2026-13-01T10:00')).toBeNull();
    expect(localInputToIso('2026-02-31T10:00')).toBeNull();
    expect(localInputToIso('15.01.2026 10:00')).toBeNull();
  });

  it('labels the time zone with its offset', () => {
    expect(timeZoneLabel(new Date('2026-01-15T10:00:00Z'))).toBe('Europe/Berlin (UTC+01:00)');
    expect(timeZoneLabel(new Date('2026-07-15T10:00:00Z'))).toBe('Europe/Berlin (UTC+02:00)');
  });
});

describe('formatUtcOffset', () => {
  it('formats positive, negative and fractional offsets', () => {
    expect(formatUtcOffset(0)).toBe('UTC+00:00');
    expect(formatUtcOffset(330)).toBe('UTC+05:30');
    expect(formatUtcOffset(-300)).toBe('UTC-05:00');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  it('formats past and future times', () => {
    expect(formatRelative('2026-06-01T11:55:00Z', 'en', now)).toBe('5 minutes ago');
    expect(formatRelative('2026-06-03T12:00:00Z', 'en', now)).toBe('in 2 days');
    expect(formatRelative(null, 'en', now)).toBe('–');
  });
});
