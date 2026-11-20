/**
 * One day of a service in detail (GET /api/public/services/{idOrSlug}/days/{date}):
 * the bucket of the uptime bar, the status periods of that day, and the public
 * incidents and maintenance windows that overlap it.
 *
 * Built from exactly the data of the public uptime (public-catalog.ts): the
 * bucket is taken from the service's uptime bar, the periods are the corrected
 * history (history-corrections.ts) clipped to the day. Only public data leaves
 * this module: no correction reasons, no correction or maintenance ids of the
 * periods, no monitoring sources. On PostgreSQL every query runs against the
 * osp_public views (they hold all columns used here).
 */
import { type DailyUptime, type ServiceDaySegment, type ServiceStatus } from '@openstatuspage/shared';
import type { DB } from '../db/index.js';
import { loadCorrectionLayers } from './corrections.js';
import { applyCorrections, type CorrectedSegment } from './history-corrections.js';
import { loadSegments } from './public-catalog.js';

const DAY_MS = 86_400_000;

interface Period {
  status: ServiceStatus;
  start: number;
  end: number;
  /** Still going on at `now` (the history has no end yet). */
  open: boolean;
  corrected: boolean;
}

/**
 * Clips the (corrected) history of a service to the UTC day starting at
 * `dayStart` and merges neighbouring periods with the same status and
 * correction marker. Periods of public corrections (`publicCorrections`, by id)
 * are marked; any other origin stays invisible.
 */
export function daySegments(
  segments: readonly (CorrectedSegment | { status: ServiceStatus; started_at: string; ended_at: string | null })[],
  publicCorrections: ReadonlySet<string>,
  dayStart: number,
  now: Date,
): ServiceDaySegment[] {
  const nowMs = now.getTime();
  const until = Math.min(dayStart + DAY_MS, nowMs);
  const periods: Period[] = [];
  for (const s of segments) {
    const rawEnd = s.ended_at ? Math.min(new Date(s.ended_at).getTime(), nowMs) : nowMs;
    const start = Math.max(new Date(s.started_at).getTime(), dayStart);
    const end = Math.min(rawEnd, until);
    if (end <= start) continue;
    const source = 'source' in s ? s : null;
    periods.push({
      status: s.status,
      start,
      end,
      open: s.ended_at === null && end === nowMs,
      corrected: source?.source === 'correction' && source.sourceId !== null && publicCorrections.has(source.sourceId),
    });
  }
  periods.sort((a, b) => a.start - b.start);
  const merged: Period[] = [];
  for (const p of periods) {
    const last = merged[merged.length - 1];
    if (last && last.end === p.start && last.status === p.status && last.corrected === p.corrected) {
      last.end = p.end;
      last.open = p.open;
    } else {
      merged.push({ ...p });
    }
  }
  return merged.map((p) => ({
    status: p.status,
    startedAt: new Date(p.start).toISOString(),
    endedAt: p.open ? null : new Date(p.end).toISOString(),
    ...(p.corrected ? { corrected: true as const } : {}),
  }));
}

/** The status periods of one service on the UTC day starting at `dayStart`. */
export async function loadDaySegments(db: DB, serviceId: string, dayStart: number, now: Date): Promise<ServiceDaySegment[]> {
  const from = new Date(dayStart);
  const to = new Date(dayStart + DAY_MS);
  const [segments, corrections] = await Promise.all([
    loadSegments(db, [serviceId], from, to),
    loadCorrectionLayers(db, [serviceId], from.toISOString(), to.toISOString()),
  ]);
  const measured = segments.get(serviceId) ?? [];
  const c = corrections.get(serviceId);
  const history = c ? applyCorrections(measured, c.layers, now) : measured;
  return daySegments(history, new Set(c?.publicNotes.keys() ?? []), dayStart, now);
}

/** Public incidents of a service that overlap [dayStart, dayEnd), oldest first. */
export async function dayIncidentIds(db: DB, serviceId: string, dayStart: number): Promise<string[]> {
  const from = new Date(dayStart).toISOString();
  const to = new Date(dayStart + DAY_MS).toISOString();
  const rows = await db
    .selectFrom('incidents')
    .innerJoin('incident_services', 'incident_services.incident_id', 'incidents.id')
    .select('incidents.id')
    .where('incident_services.service_id', '=', serviceId)
    .where('incidents.is_public', '=', 1)
    .where('incidents.started_at', '<', to)
    .where((eb) => eb.or([eb('incidents.resolved_at', 'is', null), eb('incidents.resolved_at', '>=', from)]))
    .orderBy('incidents.started_at')
    .orderBy('incidents.id')
    .execute();
  return rows.map((r) => r.id);
}

/**
 * Public maintenance windows of a service that overlap [dayStart, dayEnd),
 * by their actual times where known, oldest first. A running window lasts at
 * least until now; cancelled windows never took place.
 */
export async function dayMaintenanceIds(db: DB, serviceId: string, dayStart: number, now: Date): Promise<string[]> {
  const to = new Date(dayStart + DAY_MS).toISOString();
  const rows = await db
    .selectFrom('maintenances')
    .innerJoin('maintenance_services', 'maintenance_services.maintenance_id', 'maintenances.id')
    .select([
      'maintenances.id',
      'maintenances.status',
      'maintenances.scheduled_start',
      'maintenances.scheduled_end',
      'maintenances.actual_start',
      'maintenances.actual_end',
    ])
    .where('maintenance_services.service_id', '=', serviceId)
    .where('maintenances.is_public', '=', 1)
    .where('maintenances.status', '!=', 'cancelled')
    .where((eb) => eb.or([eb('maintenances.scheduled_start', '<', to), eb('maintenances.actual_start', '<', to)]))
    .execute();
  return maintenancesOnDay(rows, dayStart, now);
}

/**
 * Ids of the windows (not cancelled) that overlap the UTC day starting at
 * `dayStart`, by their actual times where known, oldest first. A running window
 * lasts at least until now.
 */
export function maintenancesOnDay(
  rows: readonly {
    id: string;
    status: string;
    scheduled_start: string;
    scheduled_end: string;
    actual_start: string | null;
    actual_end: string | null;
  }[],
  dayStart: number,
  now: Date,
): string[] {
  const nowIso = now.toISOString();
  const from = new Date(dayStart).toISOString();
  const to = new Date(dayStart + DAY_MS).toISOString();
  return rows
    .filter((m) => m.status !== 'cancelled')
    .map((m) => {
      const start = m.actual_start ?? m.scheduled_start;
      let end = m.actual_end ?? m.scheduled_end;
      if (m.status === 'in_progress' && end < nowIso) end = nowIso;
      return { id: m.id, start, end };
    })
    .filter((m) => m.start < to && m.end > from)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : 1))
    .map((m) => m.id);
}

/** The attributes the day shares with its uptime bucket (explicitly, so nothing else slips through). */
export function bucketAttributes(bucket: DailyUptime): DailyUptime {
  return {
    date: bucket.date,
    status: bucket.status,
    uptime: bucket.uptime,
    minutes: bucket.minutes,
    ...(bucket.corrected ? { corrected: true as const, correctionNotes: bucket.correctionNotes ?? [] } : {}),
  };
}
