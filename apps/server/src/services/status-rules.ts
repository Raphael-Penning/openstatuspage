/**
 * Pure status calculation rules. No I/O here, so they are trivially testable.
 */
import {
  SERVICE_STATUS_SEVERITY,
  worstStatus,
  type AggregationMode,
  type CheckState,
  type ImpactStatus,
  type ServiceStatus,
  type StatusMode,
} from '@openstatuspage/shared';

export interface CheckLinkState {
  state: CheckState;
  warningStatus: ImpactStatus | null;
  criticalStatus: ImpactStatus | null;
  unknownStatus: ImpactStatus | null;
}

/** Service status a single check imposes through its link mapping, or null if ignored. */
export function mapCheckState(link: CheckLinkState): ImpactStatus | null {
  switch (link.state) {
    case 'ok':
      return null;
    case 'warning':
      return link.warningStatus;
    case 'critical':
      return link.criticalStatus;
    case 'unknown':
      return link.unknownStatus;
  }
}

function cap(status: ServiceStatus, max: ServiceStatus): ServiceStatus {
  return SERVICE_STATUS_SEVERITY[status] > SERVICE_STATUS_SEVERITY[max] ? max : status;
}

/**
 * Status derived from a service's linked checks.
 *
 * - worst:  worst mapped status of any check.
 * - quorum: redundancy-aware. Mapped critical results are capped at
 *           partial_outage unless *every* check with a critical mapping is
 *           critical; warning/unknown results are capped at degraded.
 */
export function aggregateMonitorStatus(mode: AggregationMode, links: CheckLinkState[]): ServiceStatus {
  if (links.length === 0) return 'operational';

  if (mode === 'worst') {
    return worstStatus(links.map(mapCheckState).filter((s): s is ImpactStatus => s !== null));
  }

  const relevant = links.filter((l) => l.criticalStatus !== null);
  const allDown = relevant.length > 0 && relevant.every((l) => l.state === 'critical');

  const statuses: ServiceStatus[] = [];
  for (const link of links) {
    const mapped = mapCheckState(link);
    if (!mapped) continue;
    if (link.state === 'critical') statuses.push(allDown ? mapped : cap(mapped, 'partial_outage'));
    else statuses.push(cap(mapped, 'degraded'));
  }
  return worstStatus(statuses);
}

export interface EffectiveStatusInput {
  statusMode: StatusMode;
  manualStatus: ServiceStatus;
  monitorStatus: ServiceStatus;
  /** Statuses imposed by unresolved public incidents. */
  incidentStatuses: ImpactStatus[];
  /** True when an in-progress public maintenance covers the service. */
  inMaintenance: boolean;
}

/**
 * Effective public status:
 * 1. base = manual status (manual mode) or monitor status (auto mode)
 * 2. during maintenance the base is replaced by "maintenance" (failing checks
 *    are expected while work is being done)
 * 3. incidents are always applied on top, worst status wins
 */
export function computeEffectiveStatus(input: EffectiveStatusInput): ServiceStatus {
  const base = input.statusMode === 'manual' ? input.manualStatus : input.monitorStatus;
  const incident = worstStatus(input.incidentStatuses);
  if (input.inMaintenance) return worstStatus(['maintenance', incident]);
  return worstStatus([base, incident]);
}
