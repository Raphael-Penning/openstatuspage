/**
 * Plans what a history import writes, from the staged (fetched) intervals and
 * the current database. Used twice: for the preview and, freshly, when the
 * import is applied (live history may have grown in between).
 *
 * Rules:
 * - Live history (source 'live') is never touched. Imported data only goes
 *   into periods of the range without live history ("gaps").
 * - Earlier imported data inside the range is replaced (re-runs are
 *   idempotent and can complete earlier imports); outside the range it stays.
 * - Services are rebuilt for their gaps by replaying all check history
 *   through the live rules (history-replay.ts). Manual-mode services are skipped.
 */
import type {
  CheckState,
  HistoryImportCheckPreview,
  HistoryImportPreview,
  HistoryImportServicePreview,
  ImpactStatus,
  ServiceStatus,
} from '@openstatuspage/shared';
import type { DB } from '../db/index.js';
import { clipToWindows, subtractSpans, totalLength, unionSpans, type Span, type Valued } from '../lib/intervals.js';
import { replayServiceHistory, type ReplayService } from './history-replay.js';
import { averageUptime } from './uptime.js';

const ms = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();
const DOWN: ReadonlySet<ServiceStatus> = new Set(['partial_outage', 'major_outage']);
const PREVIEW_SEGMENTS = 100;

export interface StagedData {
  checks: Map<string, Valued<CheckState>[]>;
  services: Map<string, Valued<ServiceStatus>[]>;
}

interface HistoryRow {
  id: string;
  start: number;
  end: number;
  source: 'live' | 'import';
  value: string;
}

/** Rows of an imported entity that change: removed rows and their parts outside the range. */
export interface Replacement<T> {
  deleteIds: string[];
  /** Parts of deleted rows outside the range (kept). */
  keep: Valued<T>[];
  insert: Valued<T>[];
}

export interface ImportPlan {
  checks: Map<string, Replacement<CheckState>>;
  services: Map<string, Replacement<ServiceStatus>>;
  preview: Omit<HistoryImportPreview, 'unmatched' | 'unmatchedCount' | 'warnings' | 'checksWithoutData'>;
}

function overlaps(row: { start: number; end: number }, range: Span): boolean {
  return row.start < range.end && row.end > range.start;
}

/** Outside-of-range parts of rows that are removed. */
function outsideParts<T>(rows: HistoryRow[], range: Span): Valued<T>[] {
  const out: Valued<T>[] = [];
  for (const r of rows) {
    if (r.start < range.start) out.push({ start: r.start, end: range.start, value: r.value as T });
    if (r.end > range.end) out.push({ start: range.end, end: r.end, value: r.value as T });
  }
  return out;
}

async function loadCheckHistory(db: DB, checkIds: string[], range: Span, now: number): Promise<Map<string, HistoryRow[]>> {
  const map = new Map<string, HistoryRow[]>();
  for (let i = 0; i < checkIds.length; i += 500) {
    const rows = await db
      .selectFrom('monitor_check_history')
      .select(['id', 'check_id', 'state', 'started_at', 'ended_at', 'source'])
      .where('check_id', 'in', checkIds.slice(i, i + 500))
      .where('started_at', '<', iso(range.end))
      .where((eb) => eb.or([eb('ended_at', 'is', null), eb('ended_at', '>', iso(range.start))]))
      .orderBy('started_at')
      .execute();
    for (const r of rows) {
      const list = map.get(r.check_id) ?? [];
      list.push({
        id: r.id,
        start: ms(r.started_at),
        end: r.ended_at ? ms(r.ended_at) : Math.max(now, ms(r.started_at)),
        source: r.source,
        value: r.state,
      });
      map.set(r.check_id, list);
    }
  }
  return map;
}

async function loadServiceHistory(db: DB, serviceIds: string[], range: Span, now: number): Promise<Map<string, HistoryRow[]>> {
  const map = new Map<string, HistoryRow[]>();
  for (let i = 0; i < serviceIds.length; i += 500) {
    const rows = await db
      .selectFrom('service_status_history')
      .select(['id', 'service_id', 'status', 'started_at', 'ended_at', 'source'])
      .where('service_id', 'in', serviceIds.slice(i, i + 500))
      .where('started_at', '<', iso(range.end))
      .where((eb) => eb.or([eb('ended_at', 'is', null), eb('ended_at', '>', iso(range.start))]))
      .orderBy('started_at')
      .execute();
    for (const r of rows) {
      const list = map.get(r.service_id) ?? [];
      list.push({
        id: r.id,
        start: ms(r.started_at),
        end: r.ended_at ? ms(r.ended_at) : Math.max(now, ms(r.started_at)),
        source: r.source,
        value: r.status,
      });
      map.set(r.service_id, list);
    }
  }
  return map;
}

function stateTimes<T extends string>(items: Valued<T>[]): Partial<Record<T, number>> {
  const out: Partial<Record<T, number>> = {};
  for (const i of items) out[i.value] = (out[i.value] ?? 0) + (i.end - i.start);
  return out;
}

export async function planImport(db: DB, rangeIso: { from: string; to: string }, staged: StagedData, now = Date.now()): Promise<ImportPlan> {
  const range: Span = { start: ms(rangeIso.from), end: Math.min(ms(rangeIso.to), now) };

  // --- Checks -------------------------------------------------------------------
  const importedCheckIds = [...staged.checks.keys()];
  const checkPlans = new Map<string, Replacement<CheckState>>();
  const importedHistory = await loadCheckHistory(db, importedCheckIds, range, now);
  for (const [checkId, intervals] of staged.checks) {
    const rows = importedHistory.get(checkId) ?? [];
    const live = rows.filter((r) => r.source === 'live');
    const replaced = rows.filter((r) => r.source === 'import' && overlaps(r, range));
    const gaps = subtractSpans(range, live);
    checkPlans.set(checkId, {
      deleteIds: replaced.map((r) => r.id),
      keep: outsideParts<CheckState>(replaced, range),
      insert: clipToWindows(intervals, gaps),
    });
  }

  // --- Affected services --------------------------------------------------------
  // Bundles containing an imported check (up to three levels, like the replay).
  const bundleRows = await db
    .selectFrom('check_bundle_members')
    .innerJoin('check_bundles', 'check_bundles.id', 'check_bundle_members.bundle_id')
    .innerJoin('monitor_checks', 'monitor_checks.id', 'check_bundle_members.check_id')
    .innerJoin('monitor_sources', 'monitor_sources.id', 'monitor_checks.source_id')
    .select([
      'check_bundles.check_id as bundle_check_id',
      'check_bundle_members.check_id',
      'check_bundle_members.votes',
      'monitor_sources.enabled',
    ])
    .execute();
  const bundles = new Map<string, { checkId: string; votes: number }[]>();
  for (const r of bundleRows) {
    if (r.enabled !== 1) continue; // as the live vote: disabled sources never report
    bundles.set(r.bundle_check_id, [...(bundles.get(r.bundle_check_id) ?? []), { checkId: r.check_id, votes: r.votes }]);
  }
  const relevantChecks = new Set(importedCheckIds);
  for (let depth = 0; depth < 3; depth++) {
    for (const [bundleCheck, members] of bundles) {
      if (members.some((m) => relevantChecks.has(m.checkId))) relevantChecks.add(bundleCheck);
    }
  }

  const serviceIdSet = new Set(staged.services.keys());
  if (relevantChecks.size > 0) {
    const ids = [...relevantChecks];
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await db
        .selectFrom('service_checks')
        .select('service_id')
        .distinct()
        .where('check_id', 'in', ids.slice(i, i + 500))
        .execute();
      for (const r of rows) serviceIdSet.add(r.service_id);
    }
  }
  const serviceIds = [...serviceIdSet];
  const services =
    serviceIds.length === 0
      ? []
      : await db
          .selectFrom('services')
          .select(['id', 'name', 'status_mode', 'aggregation'])
          .where('id', 'in', serviceIds)
          .orderBy('name')
          .execute();

  const links =
    serviceIds.length === 0
      ? []
      : await db
          .selectFrom('service_checks')
          .innerJoin('monitor_checks', 'monitor_checks.id', 'service_checks.check_id')
          .innerJoin('monitor_sources', 'monitor_sources.id', 'monitor_checks.source_id')
          .select([
            'service_checks.service_id',
            'service_checks.check_id',
            'service_checks.warning_status',
            'service_checks.critical_status',
            'service_checks.unknown_status',
          ])
          .where('service_checks.service_id', 'in', serviceIds)
          // Checks of disabled sources do not influence the status (as live).
          .where('monitor_sources.enabled', '=', 1)
          .execute();

  // Every check whose history the replay may need: links and their bundle members.
  const neededChecks = new Set(links.map((l) => l.check_id));
  for (let depth = 0; depth < 3; depth++) {
    for (const id of [...neededChecks]) for (const m of bundles.get(id) ?? []) neededChecks.add(m.checkId);
  }
  const otherHistory = await loadCheckHistory(
    db,
    [...neededChecks].filter((id) => !staged.checks.has(id)),
    range,
    now,
  );
  const checkHistory = new Map<string, Valued<CheckState>[]>();
  for (const id of neededChecks) {
    const plan = checkPlans.get(id);
    let items: Valued<CheckState>[];
    if (plan) {
      const rows = importedHistory.get(id) ?? [];
      items = [
        ...rows
          .filter((r) => r.source === 'live' || !overlaps(r, range))
          .map((r) => ({ start: r.start, end: r.end, value: r.value as CheckState })),
        ...plan.keep,
        ...plan.insert,
      ];
    } else {
      items = (otherHistory.get(id) ?? []).map((r) => ({ start: r.start, end: r.end, value: r.value as CheckState }));
    }
    checkHistory.set(
      id,
      items.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start),
    );
  }

  const incidents =
    serviceIds.length === 0
      ? []
      : await db
          .selectFrom('incident_services')
          .innerJoin('incidents', 'incidents.id', 'incident_services.incident_id')
          .select(['incident_services.service_id', 'incident_services.status', 'incidents.started_at', 'incidents.resolved_at'])
          .where('incident_services.service_id', 'in', serviceIds)
          .where('incidents.is_public', '=', 1)
          .where('incidents.started_at', '<', iso(range.end))
          .where((eb) => eb.or([eb('incidents.resolved_at', 'is', null), eb('incidents.resolved_at', '>', iso(range.start))]))
          .execute();
  const maintenances =
    serviceIds.length === 0
      ? []
      : await db
          .selectFrom('maintenance_services')
          .innerJoin('maintenances', 'maintenances.id', 'maintenance_services.maintenance_id')
          .select(['maintenance_services.service_id', 'maintenances.actual_start', 'maintenances.actual_end', 'maintenances.status'])
          .where('maintenance_services.service_id', 'in', serviceIds)
          .where('maintenances.is_public', '=', 1)
          .where('maintenances.actual_start', 'is not', null)
          .where('maintenances.actual_start', '<', iso(range.end))
          .execute();

  const serviceHistory = await loadServiceHistory(db, serviceIds, range, now);
  const replayServices: ReplayService[] = [];
  const serviceGaps = new Map<string, Span[]>();
  for (const s of services) {
    const rows = serviceHistory.get(s.id) ?? [];
    const gaps = subtractSpans(range, rows.filter((r) => r.source === 'live'));
    serviceGaps.set(s.id, gaps);
    if (s.status_mode === 'manual') continue;
    replayServices.push({
      id: s.id,
      aggregation: s.aggregation,
      links: links
        .filter((l) => l.service_id === s.id)
        .map((l) => ({
          checkId: l.check_id,
          warningStatus: l.warning_status,
          criticalStatus: l.critical_status,
          unknownStatus: l.unknown_status,
        })),
      windows: gaps,
    });
  }

  const replayed = replayServiceHistory({
    services: replayServices,
    checks: checkHistory,
    bundles,
    incidents: incidents.map((i) => ({
      serviceId: i.service_id,
      status: i.status as ImpactStatus,
      start: ms(i.started_at),
      end: i.resolved_at ? ms(i.resolved_at) : null,
    })),
    maintenances: maintenances
      // A completed maintenance without an end has no known window.
      .filter((m) => m.actual_end !== null || m.status === 'in_progress')
      .map((m) => ({ serviceId: m.service_id, start: ms(m.actual_start!), end: m.actual_end ? ms(m.actual_end) : null })),
    explicit: staged.services,
  });

  const servicePlans = new Map<string, Replacement<ServiceStatus>>();
  const servicePreviews: HistoryImportServicePreview[] = [];
  for (const s of services) {
    const rows = serviceHistory.get(s.id) ?? [];
    const gaps = serviceGaps.get(s.id) ?? [];
    const toSegment = (r: { start: number; end: number; value: string }) => ({
      status: r.value as ServiceStatus,
      started_at: iso(r.start),
      ended_at: iso(r.end),
    });
    const uptimeBefore = averageUptime(rows.map(toSegment), new Date(range.start), new Date(range.end));
    if (s.status_mode === 'manual') {
      servicePreviews.push({
        serviceId: s.id,
        name: s.name,
        skipped: 'manual',
        gapMs: totalLength(gaps),
        filledMs: 0,
        downMs: 0,
        uptime: uptimeBefore,
        uptimeBefore,
        segmentCount: 0,
        segments: [],
      });
      continue;
    }
    const segments = replayed.get(s.id) ?? [];
    const replaced = rows.filter((r) => r.source === 'import' && overlaps(r, range));
    const plan: Replacement<ServiceStatus> = {
      deleteIds: replaced.map((r) => r.id),
      keep: outsideParts<ServiceStatus>(replaced, range),
      insert: segments,
    };
    servicePlans.set(s.id, plan);
    const after = [
      ...rows.filter((r) => r.source === 'live' || !overlaps(r, range)),
      ...plan.keep,
      ...segments,
    ].map(toSegment);
    servicePreviews.push({
      serviceId: s.id,
      name: s.name,
      skipped: segments.length === 0 ? 'no_data' : null,
      gapMs: totalLength(gaps),
      filledMs: totalLength(segments),
      downMs: totalLength(segments.filter((x) => DOWN.has(x.value))),
      uptime: averageUptime(after, new Date(range.start), new Date(range.end)),
      uptimeBefore,
      segmentCount: segments.length,
      segments: segments.slice(0, PREVIEW_SEGMENTS).map((x) => ({ status: x.value, startedAt: iso(x.start), endedAt: iso(x.end) })),
    });
  }

  // --- Check preview ------------------------------------------------------------
  const checkMeta =
    importedCheckIds.length === 0
      ? []
      : await db
          .selectFrom('monitor_checks')
          .select(['id', 'name', 'host', 'external_id'])
          .where('id', 'in', importedCheckIds)
          .execute();
  const checkPreviews: HistoryImportCheckPreview[] = checkMeta
    .map((c) => {
      const insert = checkPlans.get(c.id)?.insert ?? [];
      const covered = unionSpans(insert);
      return {
        checkId: c.id,
        name: c.name,
        host: c.host,
        externalId: c.external_id,
        intervals: insert.length,
        coveredMs: totalLength(insert),
        firstAt: covered[0] ? iso(covered[0].start) : null,
        lastAt: covered.length > 0 ? iso(covered[covered.length - 1]!.end) : null,
        stateMs: stateTimes(insert),
      };
    })
    .sort((a, b) => (a.host ?? '').localeCompare(b.host ?? '') || a.name.localeCompare(b.name));

  return {
    checks: checkPlans,
    services: servicePlans,
    preview: { from: iso(range.start), to: iso(range.end), checks: checkPreviews, services: servicePreviews },
  };
}
