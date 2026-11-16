/**
 * Pure helpers mapping public entities to display states.
 */
import {
  REGIONS,
  type IncidentImpact,
  type MaintenanceStatus,
  type PublicIncident,
  type PublicLocation,
  type PublicMaintenance,
  type PublicService,
  type PublicServiceGroup,
  type Region,
  type ServiceStatus,
} from '@openstatuspage/shared';

/** Color used for an incident of the given impact. */
export function impactStatus(impact: IncidentImpact): ServiceStatus {
  switch (impact) {
    case 'critical':
      return 'major_outage';
    case 'major':
      return 'partial_outage';
    default:
      return 'degraded';
  }
}

/** Color of an incident: green once resolved, otherwise by impact. */
export function incidentTone(incident: Pick<PublicIncident, 'status' | 'impact'>): ServiceStatus {
  return incident.status === 'resolved' ? 'operational' : impactStatus(incident.impact);
}

/** Color of a maintenance; null = neutral (cancelled). */
export function maintenanceTone(status: MaintenanceStatus): ServiceStatus | null {
  switch (status) {
    case 'completed':
      return 'operational';
    case 'cancelled':
      return null;
    default:
      return 'maintenance';
  }
}

/** Summary counters shown on the services and locations pages. */
export interface StatusCounters {
  operational: number;
  degraded: number;
  /** partial_outage + major_outage */
  offline: number;
  maintenance: number;
}

export function toCounters(counts: Partial<Record<ServiceStatus, number>>): StatusCounters {
  return {
    operational: counts.operational ?? 0,
    degraded: counts.degraded ?? 0,
    offline: (counts.partial_outage ?? 0) + (counts.major_outage ?? 0),
    maintenance: counts.maintenance ?? 0,
  };
}

export type CounterKey = keyof StatusCounters;

/** Whether a status belongs to a counter bucket. */
export function matchesCounter(status: ServiceStatus, key: CounterKey): boolean {
  if (key === 'offline') return status === 'partial_outage' || status === 'major_outage';
  return status === key;
}

/** Locations grouped by region in the canonical region order; empty regions are omitted. */
export function groupByRegion(locations: readonly PublicLocation[]): { region: Region; locations: PublicLocation[] }[] {
  return REGIONS.map((region) => ({ region, locations: locations.filter((l) => l.region === region) })).filter(
    (g) => g.locations.length > 0,
  );
}

function normalize(text: string): string {
  return text.toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export interface ServiceFilter {
  query?: string;
  counter?: CounterKey | null;
}

function serviceMatches(service: PublicService, groupName: string | null, filter: ServiceFilter): boolean {
  if (filter.counter && !matchesCounter(service.status, filter.counter)) return false;
  const q = normalize(filter.query?.trim() ?? '');
  if (!q) return true;
  return normalize(service.name).includes(q) || (groupName !== null && normalize(groupName).includes(q));
}

/**
 * Filters groups and ungrouped services by a search query (service or group
 * name) and an optional counter bucket. Groups without matches are removed.
 */
export function filterServices(
  groups: readonly PublicServiceGroup[],
  ungrouped: readonly PublicService[],
  filter: ServiceFilter,
): { groups: PublicServiceGroup[]; ungrouped: PublicService[] } {
  return {
    groups: groups
      .map((g) => ({ ...g, services: g.services.filter((s) => serviceMatches(s, g.name, filter)) }))
      .filter((g) => g.services.length > 0),
    ungrouped: ungrouped.filter((s) => serviceMatches(s, null, filter)),
  };
}

/** All services of a catalog in display order. */
export function flattenServices(groups: readonly PublicServiceGroup[], ungrouped: readonly PublicService[]): PublicService[] {
  return [...groups.flatMap((g) => g.services), ...ungrouped];
}

/** Message of a maintenance update; empty messages fall back to a localized default (handled by the caller). */
export function isAutoMessage(message: string): boolean {
  return message.trim().length === 0;
}

/** Latest update (updates are newest first). */
export function latestUpdate<T extends { updates: { createdAt: string }[] }>(item: T): T['updates'][number] | undefined {
  return item.updates[0];
}

/** Start of a maintenance as it is displayed: actual start if known, else scheduled. */
export function maintenanceStart(m: PublicMaintenance): string {
  return m.actualStart ?? m.scheduledStart;
}

/** End of a maintenance as it is displayed: actual end if known, else scheduled. */
export function maintenanceEnd(m: PublicMaintenance): string {
  return m.actualEnd ?? m.scheduledEnd;
}
