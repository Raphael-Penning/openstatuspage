/**
 * Single days of the uptime bars: the date format, the day page paths and the
 * shape of a day in detail (GET /api/public/services/{idOrSlug}/days/{date},
 * resource type `service-days`). Pure helpers the server, the server render and
 * the browser share, so all of them accept the same dates and build the same
 * links.
 *
 * A day is a UTC calendar day ("YYYY-MM-DD"), exactly like the buckets of the
 * uptime bars (DailyUptime.date).
 */
import type { DailyUptime } from './schemas.js';
import type { ServiceStatus } from './status.js';

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Start of a UTC day ("YYYY-MM-DD") in ms since epoch; null for anything but a real calendar day. */
export function uptimeDayStart(day: string): number | null {
  const match = DAY_PATTERN.exec(day);
  if (!match) return null;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const ms = Date.UTC(y, m - 1, d);
  const date = new Date(ms);
  // Rejects 2026-02-30, 2026-13-01 and years Date.UTC maps to 19xx.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return ms;
}

/** Whether `value` is a UTC day in the format of the uptime buckets ("YYYY-MM-DD", a real date). */
export function isUptimeDay(value: string): boolean {
  return uptimeDayStart(value) !== null;
}

/** The UTC day of a time ("YYYY-MM-DD"). */
export function uptimeDayOf(at: Date | number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The day `days` after `day` (negative: before). `day` must be valid. */
export function shiftUptimeDay(day: string, days: number): string {
  const start = uptimeDayStart(day);
  if (start === null) throw new Error(`Not a day: ${day}`);
  return uptimeDayOf(start + days * DAY_MS);
}

/**
 * Path of a service page: `/services/<slug>` below `base` (a prefix without a
 * trailing slash such as `/p/<token>`; empty for the public pages). The slug
 * is preferred; the id works as well.
 */
export function servicePath(service: { slug?: string | null; id: string }, base = ''): string {
  return `${base}/services/${encodeURIComponent(service.slug || service.id)}`;
}

/** Path of the detail page of one day of a service: `/services/<slug>/days/<YYYY-MM-DD>` below `base`. */
export function serviceDayPath(service: { slug?: string | null; id: string }, day: string, base = ''): string {
  return `${servicePath(service, base)}/days/${encodeURIComponent(day)}`;
}

/** One status period of a day, clipped to the day. */
export interface ServiceDaySegment {
  status: ServiceStatus;
  /** Start within the day (ISO 8601, UTC); the day start when the period began earlier. */
  startedAt: string;
  /** End within the day; the day end when the period went on; null while it still lasts (today). */
  endedAt: string | null;
  /** Set when a public correction made this period what it is. */
  corrected?: true;
}

/**
 * A day of a service in detail (`service-days`). The values of the bucket are
 * exactly those of the service's uptime bar (DailyUptime), the segments are
 * the corrected history of that day. Relationships: `service`, `incidents`
 * and `maintenances` (overlapping the day, public only), all in `included`.
 */
export interface PublicServiceDay extends DailyUptime {
  /** `<service id>:<YYYY-MM-DD>`. */
  id: string;
  /** Start and (exclusive) end of the UTC day. */
  startsAt: string;
  endsAt: string;
  /** False for today: the day is not over yet. */
  complete: boolean;
  /** Status periods in time order, operational ones included, without gaps of data. */
  segments: ServiceDaySegment[];
  /** The neighbouring days inside the uptime range; null at its ends. */
  previousDate: string | null;
  nextDate: string | null;
}
