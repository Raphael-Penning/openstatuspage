/**
 * Rebuilds service status segments from check state history. Pure, no I/O.
 *
 * The replay applies exactly the live rules to past points in time:
 *   check states → link mapping + aggregation (status-rules.ts)
 *   check bundles → weighted majority vote of the members (bundle-rules.ts)
 *   + public maintenance in progress, + unresolved public incidents
 *
 * Differences that follow from the data:
 * - A check without history at a point in time does not take part (like a
 *   check that is not linked). A bundle member without history does not report.
 * - When none of a service's checks has history at a point in time, the
 *   service has no data there and no segment is produced (the gap stays).
 * - Service configuration (links, mappings, aggregation, bundle votes) is the
 *   current one; it is not versioned.
 */
import type { AggregationMode, CheckState, ImpactStatus, ServiceStatus } from '@openstatuspage/shared';
import { mergeAdjacent, valueAt, type Span, type Valued } from '../lib/intervals.js';
import { evaluateBundle } from './bundle-rules.js';
import { aggregateMonitorStatus, computeEffectiveStatus, type CheckLinkState } from './status-rules.js';

export interface ReplayLink {
  checkId: string;
  warningStatus: ImpactStatus | null;
  criticalStatus: ImpactStatus | null;
  unknownStatus: ImpactStatus | null;
}

export interface ReplayService {
  id: string;
  aggregation: AggregationMode;
  /** Links to checks of enabled sources only (as the live engine). */
  links: ReplayLink[];
  /** Where segments may be produced (sorted, disjoint). */
  windows: Span[];
}

export interface ReplayBundleMember {
  checkId: string;
  votes: number;
}

export interface ReplayInput {
  services: ReplayService[];
  /** State history per check id (sorted, disjoint). */
  checks: ReadonlyMap<string, readonly Valued<CheckState>[]>;
  /** Members per bundle check id (members of disabled sources already removed). */
  bundles: ReadonlyMap<string, readonly ReplayBundleMember[]>;
  /** Public incidents: end null = unresolved. */
  incidents: readonly { serviceId: string; status: ImpactStatus; start: number; end: number | null }[];
  /** Public maintenance windows that actually ran: end null = still in progress. */
  maintenances: readonly { serviceId: string; start: number; end: number | null }[];
  /** Explicit service statuses (CSV), used instead of the replay where present. */
  explicit?: ReadonlyMap<string, readonly Valued<ServiceStatus>[]>;
}

const MAX_BUNDLE_DEPTH = 3;

class CheckTimeline {
  constructor(private readonly input: ReplayInput) {}

  /** Breakpoints of a check (incl. bundle members, recursively). */
  breakpoints(checkId: string, into: Set<number>, depth = 0): void {
    for (const iv of this.input.checks.get(checkId) ?? []) {
      into.add(iv.start);
      into.add(iv.end);
    }
    const members = this.input.bundles.get(checkId);
    if (members && depth < MAX_BUNDLE_DEPTH) {
      for (const m of members) this.breakpoints(m.checkId, into, depth + 1);
    }
  }

  /** State of a check at `t`; undefined = no data. Recorded history wins over a computed bundle vote. */
  stateAt(checkId: string, t: number, depth = 0): CheckState | undefined {
    const own = valueAt(this.input.checks.get(checkId) ?? [], t);
    if (own !== undefined) return own;
    const members = this.input.bundles.get(checkId);
    if (!members || depth >= MAX_BUNDLE_DEPTH) return undefined;
    let anyData = false;
    const voting = members.map((m) => {
      const state = this.stateAt(m.checkId, t, depth + 1);
      if (state !== undefined) anyData = true;
      return { votes: m.votes, state: state ?? 'unknown', reporting: state !== undefined && state !== 'unknown' };
    });
    if (!anyData) return undefined;
    return evaluateBundle(voting).state;
  }
}

/** Service status at `t` from checks, maintenance and incidents; undefined = no monitor data. */
function statusAt(input: ReplayInput, timeline: CheckTimeline, service: ReplayService, t: number): ServiceStatus | undefined {
  const explicit = input.explicit?.get(service.id);
  if (explicit) {
    const value = valueAt(explicit, t);
    if (value !== undefined) return value;
  }
  const links: CheckLinkState[] = [];
  for (const link of service.links) {
    const state = timeline.stateAt(link.checkId, t);
    if (state === undefined) continue;
    links.push({
      state,
      warningStatus: link.warningStatus,
      criticalStatus: link.criticalStatus,
      unknownStatus: link.unknownStatus,
    });
  }
  if (links.length === 0) return undefined;
  const active = (start: number, end: number | null) => start <= t && (end === null || t < end);
  return computeEffectiveStatus({
    statusMode: 'auto',
    manualStatus: 'operational',
    monitorStatus: aggregateMonitorStatus(service.aggregation, links),
    incidentStatuses: input.incidents.filter((i) => i.serviceId === service.id && active(i.start, i.end)).map((i) => i.status),
    inMaintenance: input.maintenances.some((m) => m.serviceId === service.id && active(m.start, m.end)),
  });
}

/** Status segments per service, only inside the service's windows. */
export function replayServiceHistory(input: ReplayInput): Map<string, Valued<ServiceStatus>[]> {
  const timeline = new CheckTimeline(input);
  const result = new Map<string, Valued<ServiceStatus>[]>();
  for (const service of input.services) {
    const points = new Set<number>();
    for (const link of service.links) timeline.breakpoints(link.checkId, points);
    for (const i of input.incidents) {
      if (i.serviceId !== service.id) continue;
      points.add(i.start);
      if (i.end !== null) points.add(i.end);
    }
    for (const m of input.maintenances) {
      if (m.serviceId !== service.id) continue;
      points.add(m.start);
      if (m.end !== null) points.add(m.end);
    }
    for (const e of input.explicit?.get(service.id) ?? []) {
      points.add(e.start);
      points.add(e.end);
    }

    const segments: Valued<ServiceStatus>[] = [];
    for (const w of service.windows) {
      const cuts = [w.start, ...[...points].filter((p) => p > w.start && p < w.end), w.end].sort((a, b) => a - b);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const start = cuts[i]!;
        const end = cuts[i + 1]!;
        if (end <= start) continue;
        const status = statusAt(input, timeline, service, start);
        if (status !== undefined) segments.push({ start, end, value: status });
      }
    }
    result.set(service.id, mergeAdjacent(segments));
  }
  return result;
}
