/**
 * Turns status history segments into per-day uptime buckets for the public
 * uptime bars. Pure function, all calculations in UTC.
 */
import { SERVICE_STATUS_SEVERITY, type DailyUptime, type ServiceStatus } from '@openstatuspage/shared';

export interface StatusSegment {
  status: ServiceStatus;
  started_at: string;
  ended_at: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DOWN: ReadonlySet<ServiceStatus> = new Set(['partial_outage', 'major_outage']);

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * @param segments status segments of one service (any order)
 * @param days     number of days to return, ending with today
 * @param now      reference time
 */
export function computeDailyUptime(segments: StatusSegment[], days: number, now: Date): DailyUptime[] {
  const today = startOfUtcDay(now).getTime();
  const nowMs = now.getTime();
  const parsed = segments.map((s) => ({
    status: s.status,
    start: new Date(s.started_at).getTime(),
    end: s.ended_at ? new Date(s.ended_at).getTime() : nowMs,
  }));

  const result: DailyUptime[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = today - i * DAY_MS;
    const dayEnd = Math.min(dayStart + DAY_MS, nowMs);
    const minutes: Partial<Record<ServiceStatus, number>> = {};
    let observed = 0;
    let down = 0;
    let worst: ServiceStatus | null = null;

    for (const seg of parsed) {
      const overlap = Math.min(seg.end, dayEnd) - Math.max(seg.start, dayStart);
      if (overlap <= 0) continue;
      observed += overlap;
      if (DOWN.has(seg.status)) down += overlap;
      if (seg.status !== 'operational') {
        minutes[seg.status] = (minutes[seg.status] ?? 0) + Math.round(overlap / 60000);
      }
      if (worst === null || SERVICE_STATUS_SEVERITY[seg.status] > SERVICE_STATUS_SEVERITY[worst]) {
        worst = seg.status;
      }
    }

    result.push({
      date: new Date(dayStart).toISOString().slice(0, 10),
      status: worst,
      uptime: observed > 0 ? round2(((observed - down) / observed) * 100) : null,
      minutes,
    });
  }
  return result;
}

/** Average uptime over the observed time of all buckets' segments. */
export function averageUptime(segments: StatusSegment[], from: Date, now: Date): number | null {
  const fromMs = from.getTime();
  const nowMs = now.getTime();
  let observed = 0;
  let down = 0;
  for (const s of segments) {
    const start = Math.max(new Date(s.started_at).getTime(), fromMs);
    const end = Math.min(s.ended_at ? new Date(s.ended_at).getTime() : nowMs, nowMs);
    if (end <= start) continue;
    observed += end - start;
    if (DOWN.has(s.status)) down += end - start;
  }
  return observed > 0 ? round2(((observed - down) / observed) * 100) : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
