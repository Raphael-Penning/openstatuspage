/**
 * Form model of the service builder and its conversion to the API payload.
 */
import type {
  AdminMonitorCheck,
  AdminService,
  AggregationMode,
  ServiceCheckLinkInput,
  ServiceKind,
  ServiceStatus,
  StatusMode,
} from '@openstatuspage/shared';

export interface ServiceFormValues {
  name: string;
  slug: string;
  description: string;
  kind: ServiceKind;
  url: string;
  groupId: string;
  sortOrder: number;
  isPublic: boolean;
  statusMode: StatusMode;
  manualStatus: ServiceStatus;
  aggregation: AggregationMode;
  locationIds: string[];
  checks: (ServiceCheckLinkInput & { check?: AdminMonitorCheck })[];
}

export const emptyServiceForm = (sortOrder = 0): ServiceFormValues => ({
  name: '',
  slug: '',
  description: '',
  kind: 'service',
  url: '',
  groupId: '',
  sortOrder,
  isPublic: true,
  statusMode: 'auto',
  manualStatus: 'operational',
  aggregation: 'worst',
  locationIds: [],
  checks: [],
});

export function serviceToForm(s: AdminService): ServiceFormValues {
  return {
    name: s.name,
    slug: s.slug,
    description: s.description ?? '',
    kind: s.kind,
    url: s.url ?? '',
    groupId: s.groupId ?? '',
    sortOrder: s.sortOrder,
    isPublic: s.isPublic,
    statusMode: s.statusMode,
    manualStatus: s.manualStatus,
    aggregation: s.aggregation,
    locationIds: s.locationIds,
    checks: s.checks.map((c) => ({
      checkId: c.checkId,
      warningStatus: c.warningStatus,
      criticalStatus: c.criticalStatus,
      unknownStatus: c.unknownStatus,
      check: c.check,
    })),
  };
}

/** API payload (ServiceInput shape) from the form values. Empty strings become null. */
export function serviceFormToPayload(v: ServiceFormValues) {
  const trimmed = (s: string) => (s.trim() === '' ? null : s.trim());
  return {
    name: v.name.trim(),
    slug: trimmed(v.slug),
    description: trimmed(v.description),
    kind: v.kind,
    // The URL is only meaningful for sites.
    url: v.kind === 'site' ? trimmed(v.url) : null,
    groupId: v.groupId || null,
    sortOrder: v.sortOrder,
    isPublic: v.isPublic,
    statusMode: v.statusMode,
    manualStatus: v.manualStatus,
    aggregation: v.aggregation,
    locationIds: v.locationIds,
    checks: v.checks.map(({ checkId, warningStatus, criticalStatus, unknownStatus }) => ({
      checkId,
      warningStatus,
      criticalStatus,
      unknownStatus,
    })),
  };
}
