/**
 * Pure helpers for the public uptime bars.
 */
import { SERVICE_STATUS_SEVERITY, type DailyUptime, type ServiceStatus } from '@openstatuspage/shared';
import { numberFormat } from './intl';

/** Breakpoints (px) and the number of days shown below them. */
const DAY_STEPS: readonly (readonly [number, number])[] = [
  [640, 30],
  [1024, 60],
];

/**
 * Number of days an uptime bar shows for a viewport width: 30 on phones,
 * 60 on tablets, 90 on desktops. Never more than `available`.
 */
export function barDaysForWidth(width: number, available: number, desktopDays = 90): number {
  let days = desktopDays;
  for (const [maxWidth, d] of DAY_STEPS) {
    if (width < maxWidth) {
      days = d;
      break;
    }
  }
  return Math.max(1, Math.min(days, available));
}

/** The newest `count` buckets (input is oldest first, like the API). */
export function lastDays(uptime: readonly DailyUptime[], count: number): DailyUptime[] {
  if (count <= 0) return [];
  return uptime.slice(Math.max(0, uptime.length - count));
}

/**
 * Average uptime of the buckets that have data, rounded to two decimals.
 * null when no bucket has data.
 */
export function averageUptime(days: readonly DailyUptime[]): number | null {
  let sum = 0;
  let n = 0;
  for (const d of days) {
    if (d.uptime === null) continue;
    sum += d.uptime;
    n++;
  }
  if (n === 0) return null;
  return Math.round((sum / n) * 100) / 100;
}

/** "99.95 %" style, locale aware, at most two fraction digits. */
export function formatPercent(value: number, locale: string): string {
  return numberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value / 100);
}

/** Minutes of real downtime (partial or major outage) of a bucket. */
export function outageMinutes(day: DailyUptime): number {
  return (day.minutes.partial_outage ?? 0) + (day.minutes.major_outage ?? 0);
}

/** Non-operational minutes of a bucket, worst status first, zero entries removed. */
export function statusMinutes(day: DailyUptime): { status: ServiceStatus; minutes: number }[] {
  return (Object.entries(day.minutes) as [ServiceStatus, number | undefined][])
    .filter((e): e is [ServiceStatus, number] => e[0] !== 'operational' && (e[1] ?? 0) > 0)
    .map(([status, minutes]) => ({ status, minutes }))
    .sort((a, b) => SERVICE_STATUS_SEVERITY[b.status] - SERVICE_STATUS_SEVERITY[a.status]);
}

/** Horizontal tooltip alignment for a segment so the tooltip stays inside the bar. */
export function tooltipAlign(index: number, count: number): 'start' | 'center' | 'end' {
  if (count <= 1) return 'center';
  const pos = index / (count - 1);
  if (pos < 0.2) return 'start';
  if (pos > 0.8) return 'end';
  return 'center';
}

/**
 * Index of the day under a pointer at `offsetX` px of a bar `width` px wide
 * with `count` days. The whole bar is one pointer target (WCAG 2.5.8), the
 * day follows from the position.
 */
export function dayIndexAt(offsetX: number, width: number, count: number): number {
  if (count <= 0 || width <= 0) return 0;
  const index = Math.floor((offsetX / width) * count);
  return Math.min(count - 1, Math.max(0, index));
}

/**
 * Pattern of a day segment in addition to its color, so the bar does not
 * rely on color alone (WCAG 1.4.1): striped when the day was not fully
 * operational, an outline when there is no data.
 */
export function dayPattern(status: ServiceStatus | null): 'solid' | 'striped' | 'outline' {
  if (status === null) return 'outline';
  return status === 'operational' ? 'solid' : 'striped';
}

/** Buckets whose data was corrected afterwards (public corrections), newest first. */
export function correctedDays(days: readonly DailyUptime[]): DailyUptime[] {
  return days.filter((d) => d.corrected === true).reverse();
}
