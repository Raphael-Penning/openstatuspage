/**
 * TanStack Query hooks for the public API (JSON:API). Every query refreshes
 * every 60 s so an open status page stays current without a reload. The hooks
 * return the plain shapes of @openstatuspage/shared (see lib/api.ts).
 */
import {
  resourceType,
  type DailyUptime,
  type HistoryItem,
  type HistoryQuery,
  type Paginated,
  type PublicIncident,
  type PublicLocation,
  type PublicLocationsResponse,
  type PublicMaintenance,
  type PublicPageSettings,
  type PublicService,
  type PublicServiceGroup,
  type PublicSummary,
  type ServiceStatus,
} from '@openstatuspage/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';

export const REFRESH_INTERVAL = 60_000;

export interface PublicServicesResponse {
  groups: PublicServiceGroup[];
  ungrouped: PublicService[];
  counts: Record<ServiceStatus, number>;
}

export type PublicServiceDetail = PublicService & {
  uptime: DailyUptime[];
  incidents: PublicIncident[];
  maintenances: PublicMaintenance[];
};

/** Retry transient errors once, never "not found". */
function retry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

const common = { refetchInterval: REFRESH_INTERVAL, retry } as const;

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Services in display order, regrouped by the groups of the compound document. */
export async function fetchServices(): Promise<PublicServicesResponse> {
  const { data, included, meta } = await api.getDocument<PublicService[]>('/api/public/services');
  const groups = included.filter((r) => resourceType(r) === 'service-groups') as unknown as PublicServiceGroup[];
  return {
    groups,
    ungrouped: data.filter((s) => s.groupId === null),
    counts: meta.counts as Record<ServiceStatus, number>,
  };
}

export async function fetchLocations(): Promise<PublicLocationsResponse> {
  const { data, meta } = await api.getDocument<PublicLocation[]>('/api/public/locations');
  return { locations: data, counts: meta.counts as Record<ServiceStatus, number> };
}

/** History page: incidents and maintenance windows as HistoryItems. */
export async function fetchHistory(query: Partial<HistoryQuery>): Promise<Paginated<HistoryItem>> {
  const page = await api.getPage<PublicIncident | PublicMaintenance>('/api/public/history', {
    page: { number: query.page, size: query.pageSize },
    filter: {
      type: query.type === 'all' ? undefined : query.type,
      service: query.serviceId,
      location: query.locationId,
      month: query.month,
    },
  });
  const items = page.items.map((item): HistoryItem => {
    if (resourceType(item) === 'maintenances') {
      const maintenance = item as PublicMaintenance;
      return { type: 'maintenance', date: maintenance.scheduledStart, maintenance };
    }
    const incident = item as PublicIncident;
    return { type: 'incident', date: incident.startedAt, incident };
  });
  return { ...page, items };
}

export function usePublicSettings() {
  return useQuery({
    queryKey: ['public', 'settings'],
    queryFn: () => api.get<PublicPageSettings>('/api/public/settings'),
    ...common,
  });
}

export function useSummary() {
  return useQuery({
    queryKey: ['public', 'summary'],
    queryFn: () => api.get<PublicSummary>('/api/public/summary'),
    ...common,
  });
}

export function useServices() {
  return useQuery({
    queryKey: ['public', 'services'],
    queryFn: () => fetchServices(),
    ...common,
  });
}

export function useService(idOrSlug: string) {
  return useQuery({
    queryKey: ['public', 'service', idOrSlug],
    queryFn: () => api.get<PublicServiceDetail>(`/api/public/services/${encodeURIComponent(idOrSlug)}`),
    ...common,
  });
}

export function useLocations(enabled = true) {
  return useQuery({
    queryKey: ['public', 'locations'],
    queryFn: () => fetchLocations(),
    enabled,
    ...common,
  });
}

export function useIncident(id: string) {
  return useQuery({
    queryKey: ['public', 'incident', id],
    queryFn: () => api.get<PublicIncident>(`/api/public/incidents/${encodeURIComponent(id)}`),
    ...common,
  });
}

export function useMaintenance(id: string) {
  return useQuery({
    queryKey: ['public', 'maintenance', id],
    queryFn: () => api.get<PublicMaintenance>(`/api/public/maintenances/${encodeURIComponent(id)}`),
    ...common,
  });
}

export function useHistory(query: Partial<HistoryQuery>) {
  return useQuery({
    queryKey: ['public', 'history', query],
    queryFn: () => fetchHistory(query),
    placeholderData: keepPreviousData,
    ...common,
  });
}
