/** Current time as ISO-8601 UTC string. All timestamps in the DB use this format. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Normalizes any parseable timestamp to ISO-8601 UTC. */
export function toIso(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp: ${String(value)}`);
  return d.toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Date and time in UTC as `Intl.DateTimeFormat` writes them for en-GB and de-DE
 * (dateStyle medium, timeStyle short): "5 Sept 2026, 07:03" and "05.09.2026, 07:03".
 * Written out instead of using Intl so that feeds and mails do not load the ICU
 * locale data (several MB per instance) and stay the same across Node versions.
 */
export function formatUtcDateTime(value: string | Date, locale: 'en' | 'de'): string {
  const d = value instanceof Date ? value : new Date(value);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const year = d.getUTCFullYear();
  if (locale === 'de') return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${year}, ${time}`;
  return `${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth()]} ${year}, ${time}`;
}
