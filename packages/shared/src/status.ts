/**
 * Core status vocabulary shared by server and web client.
 *
 * Everything here is pure and side-effect free so it can run in the browser,
 * in Node and in tests.
 */

/** Public status of a service, site or location. Ordered by severity (see SERVICE_STATUS_SEVERITY). */
export const SERVICE_STATUSES = [
  'operational',
  'maintenance',
  'degraded',
  'partial_outage',
  'major_outage',
] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/**
 * Severity used for "worst status wins" aggregation. Maintenance ranks above
 * operational but below any real impact, so an outage reported by an incident
 * is still shown during a maintenance window.
 */
export const SERVICE_STATUS_SEVERITY: Record<ServiceStatus, number> = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
};

/** Statuses an incident or a check mapping can impose on a service (no "maintenance"). */
export const IMPACT_STATUSES = ['degraded', 'partial_outage', 'major_outage'] as const;
export type ImpactStatus = (typeof IMPACT_STATUSES)[number];

/** Normalized state of an internal monitoring check (never exposed publicly). */
export const CHECK_STATES = ['ok', 'warning', 'critical', 'unknown'] as const;
export type CheckState = (typeof CHECK_STATES)[number];

export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_IMPACTS = ['none', 'minor', 'major', 'critical'] as const;
export type IncidentImpact = (typeof INCIDENT_IMPACTS)[number];

export const MAINTENANCE_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

/**
 * How the monitor-derived status of a service is calculated from its linked checks.
 *
 * - worst:  the worst mapped status of any linked check wins.
 * - quorum: for redundant setups. All linked checks failing yields the link's
 *           "critical" mapping; only some failing yields at most "partial_outage";
 *           warnings yield at most "degraded".
 */
export const AGGREGATION_MODES = ['worst', 'quorum'] as const;
export type AggregationMode = (typeof AGGREGATION_MODES)[number];

export const STATUS_MODES = ['auto', 'manual'] as const;
export type StatusMode = (typeof STATUS_MODES)[number];

export const SERVICE_KINDS = ['service', 'site'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

/** Source types an administrator can create and configure. */
export const CONFIGURABLE_SOURCE_TYPES = ['icinga2', 'uptimekuma', 'openitcockpit', 'webhook'] as const;
export type ConfigurableSourceType = (typeof CONFIGURABLE_SOURCE_TYPES)[number];

/**
 * Built-in virtual source holding one check per check bundle (weighted voting
 * over checks of other sources). Created automatically, never polled, no ingest.
 */
export const BUNDLE_SOURCE_TYPE = 'bundle' as const;

/** Every stored source type: the configurable ones plus the virtual bundle source. */
export const MONITOR_SOURCE_TYPES = [...CONFIGURABLE_SOURCE_TYPES, BUNDLE_SOURCE_TYPE] as const;
export type MonitorSourceType = (typeof MONITOR_SOURCE_TYPES)[number];

export const USER_ROLES = ['admin', 'editor'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Location groups used to cluster locations on the public page. */
export const REGIONS = [
  'europe',
  'north_america',
  'south_america',
  'asia',
  'middle_east',
  'africa',
  'oceania',
] as const;
export type Region = (typeof REGIONS)[number];

export function worstStatus(statuses: Iterable<ServiceStatus>): ServiceStatus {
  let worst: ServiceStatus = 'operational';
  for (const s of statuses) {
    if (SERVICE_STATUS_SEVERITY[s] > SERVICE_STATUS_SEVERITY[worst]) worst = s;
  }
  return worst;
}

export function isWorse(a: ServiceStatus, b: ServiceStatus): boolean {
  return SERVICE_STATUS_SEVERITY[a] > SERVICE_STATUS_SEVERITY[b];
}

/** Overall page indicator derived from all public service statuses. */
export type OverallStatus = 'operational' | 'maintenance' | 'degraded' | 'partial_outage' | 'major_outage';

export function overallStatus(statuses: Iterable<ServiceStatus>): OverallStatus {
  return worstStatus(statuses);
}

/**
 * Public status of a location: the override if set, otherwise the worst status
 * of the public services running there.
 */
export function locationStatus(
  override: ServiceStatus | null | undefined,
  serviceStatuses: Iterable<ServiceStatus>,
): ServiceStatus {
  return override ?? worstStatus(serviceStatuses);
}
