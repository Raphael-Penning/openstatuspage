/**
 * Conversion between `<input type="datetime-local">` values (browser local time,
 * "YYYY-MM-DDTHH:mm") and the UTC ISO-8601 timestamps used by the API.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** UTC ISO timestamp -> local "YYYY-MM-DDTHH:mm". Returns "" for empty or invalid input. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Local "YYYY-MM-DDTHH:mm" -> UTC ISO timestamp. Returns null for empty or invalid input. */
export function localInputToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = LOCAL_INPUT.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  // Reject overflowing values such as 2026-02-31 that Date would silently roll over.
  if (date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) return null;
  return date.toISOString();
}

const DATE_INPUT = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Local "YYYY-MM-DD" (`<input type="date">`) -> UTC ISO timestamp of local
 * midnight, `addDays` days later. Returns null for empty or invalid input.
 */
export function dateInputToIso(value: string | null | undefined, addDays = 0): string | null {
  if (!value) return null;
  const m = DATE_INPUT.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const check = new Date(Number(y), Number(mo) - 1, Number(d));
  if (check.getMonth() !== Number(mo) - 1 || check.getDate() !== Number(d)) return null;
  return new Date(Number(y), Number(mo) - 1, Number(d) + addDays).toISOString();
}

/** Current local time as a datetime-local value. */
export function nowLocalInput(offsetMinutes = 0): string {
  return isoToLocalInput(new Date(Date.now() + offsetMinutes * 60_000).toISOString());
}

/** Name of the browser time zone with its current UTC offset, e.g. "Europe/Berlin (UTC+01:00)". */
export function timeZoneLabel(date: Date = new Date()): string {
  let zone = 'UTC';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    /* Intl unavailable */
  }
  return `${zone} (${formatUtcOffset(-date.getTimezoneOffset())})`;
}

/** Minutes east of UTC -> "UTC+01:00". */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Localized absolute date and time. */
export function formatDateTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

/** Localized relative time ("5 minutes ago", "in 2 days"). */
export function formatRelative(iso: string | null | undefined, locale: string, now: number = Date.now()): string {
  if (!iso) return '–';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '–';
  const diff = Math.round((t - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (Math.abs(diff) >= seconds || unit === 'second') {
      return rtf.format(Math.round(diff / seconds), unit);
    }
  }
  return rtf.format(0, 'second');
}
