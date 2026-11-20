/**
 * Pure, locale-aware date and time formatting helpers for the public page.
 * Everything is based on Intl so the output follows the current i18n language.
 */
import { dateTimeFormat, numberFormat, relativeTimeFormat } from './intl';

/** Visitor preference: show times in the browser's time zone or in UTC. */
export type TimeZoneMode = 'local' | 'utc';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function timeZoneOf(mode: TimeZoneMode): string | undefined {
  return mode === 'utc' ? 'UTC' : undefined;
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** "Nov 17, 2026, 2:05 PM" (+ " UTC" in UTC mode). */
export function formatDateTime(value: string | Date, locale: string, mode: TimeZoneMode): string {
  const text = dateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timeZoneOf(mode),
  }).format(toDate(value));
  return mode === 'utc' ? `${text} UTC` : text;
}

/** "Nov 17, 2026". */
export function formatDate(value: string | Date, locale: string, mode: TimeZoneMode): string {
  return dateTimeFormat(locale, { dateStyle: 'medium', timeZone: timeZoneOf(mode) }).format(toDate(value));
}

/** "2:05 PM" (+ " UTC" in UTC mode). */
export function formatTime(value: string | Date, locale: string, mode: TimeZoneMode): string {
  const text = dateTimeFormat(locale, { timeStyle: 'short', timeZone: timeZoneOf(mode) }).format(toDate(value));
  return mode === 'utc' ? `${text} UTC` : text;
}

/** True when both instants fall on the same calendar day in the given mode. */
export function isSameDay(a: string | Date, b: string | Date, mode: TimeZoneMode): boolean {
  const fmt = dateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timeZoneOf(mode),
  });
  return fmt.format(toDate(a)) === fmt.format(toDate(b));
}

/**
 * Time window, e.g. "Nov 17, 2026, 2:00 PM – 4:00 PM" when both ends are on
 * the same day, otherwise both full date-times.
 */
export function formatRange(start: string | Date, end: string | Date, locale: string, mode: TimeZoneMode): string {
  if (isSameDay(start, end, mode)) {
    const first = dateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timeZoneOf(mode),
    }).format(toDate(start));
    return `${first} – ${formatTime(end, locale, mode)}`;
  }
  return `${formatDateTime(start, locale, mode).replace(/ UTC$/, '')} – ${formatDateTime(end, locale, mode)}`;
}

/** Day of a UTC uptime bucket ("YYYY-MM-DD"), e.g. "Nov 17, 2026". Buckets are UTC days. */
export function formatUtcDay(day: string, locale: string): string {
  return dateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}

/** "November 2026" for a "YYYY-MM" key. */
export function formatMonth(month: string, locale: string): string {
  return dateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
}

/** "YYYY-MM" of an instant, in UTC (matches the API's month filter). */
export function monthKey(value: string | Date): string {
  return toDate(value).toISOString().slice(0, 7);
}

/** The last `count` month keys ending with the month of `now`, newest first. */
export function recentMonths(now: Date, count: number): string[] {
  const result: string[] = [];
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  for (let i = 0; i < count; i++) {
    result.push(new Date(Date.UTC(y, m - i, 1)).toISOString().slice(0, 7));
  }
  return result;
}

/** "2 hours ago", "in 3 days", "now". */
export function formatRelative(value: string | Date, now: number, locale: string): string {
  const diff = toDate(value).getTime() - now;
  const abs = Math.abs(diff);
  const rtf = relativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < MINUTE) return rtf.format(0, 'second');
  if (abs < HOUR) return rtf.format(Math.round(diff / MINUTE), 'minute');
  if (abs < DAY) return rtf.format(Math.round(diff / HOUR), 'hour');
  if (abs < 30 * DAY) return rtf.format(Math.round(diff / DAY), 'day');
  if (abs < 365 * DAY) return rtf.format(Math.round(diff / (30 * DAY)), 'month');
  return rtf.format(Math.round(diff / (365 * DAY)), 'year');
}

function unit(value: number, name: 'day' | 'hour' | 'minute', locale: string): string {
  return numberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'short' }).format(value);
}

/**
 * Human readable duration with at most two units: "45 min", "2 hr 15 min",
 * "3 days 4 hr". Durations below one minute are shown as "< 1 min".
 */
export function formatDuration(ms: number, locale: string): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / MINUTE);
  if (totalMinutes < 1) return `< ${unit(1, 'minute', locale)}`;
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(unit(days, 'day', locale));
    if (hours > 0) parts.push(unit(hours, 'hour', locale));
  } else if (hours > 0) {
    parts.push(unit(hours, 'hour', locale));
    if (minutes > 0) parts.push(unit(minutes, 'minute', locale));
  } else {
    parts.push(unit(minutes, 'minute', locale));
  }
  return parts.join(' ');
}

/** Duration between two instants; an open end means "until now". */
export function durationBetween(start: string, end: string | null, now: number): number {
  return (end ? new Date(end).getTime() : now) - new Date(start).getTime();
}

/**
 * Language-neutral formatting without Intl, used by the server render and the
 * hydration render (hooks/preferences.tsx): ISO dates and 24-hour times in UTC,
 * SI-style durations. It is deterministic, unambiguous without JavaScript, and
 * keeps ICU (several MB of locale data and native memory) out of the server.
 * After hydration the page switches to the localized Intl formatting above.
 */
export const neutral = {
  date: (value: string | Date): string => toDate(value).toISOString().slice(0, 10),
  time: (value: string | Date): string => `${toDate(value).toISOString().slice(11, 16)} UTC`,
  dateTime: (value: string | Date): string => {
    const iso = toDate(value).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  },
  range: (start: string | Date, end: string | Date): string => {
    const a = toDate(start).toISOString();
    const b = toDate(end).toISOString();
    const first = `${a.slice(0, 10)} ${a.slice(11, 16)}`;
    return a.slice(0, 10) === b.slice(0, 10)
      ? `${first} – ${b.slice(11, 16)} UTC`
      : `${first} – ${b.slice(0, 10)} ${b.slice(11, 16)} UTC`;
  },
  /** "2 h 15 min", "3 d 4 h", "< 1 min" (at most two units, like formatDuration). */
  duration: (ms: number): string => {
    const totalMinutes = Math.floor(Math.max(0, ms) / MINUTE);
    if (totalMinutes < 1) return '< 1 min';
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
    if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
    return `${minutes} min`;
  },
};
