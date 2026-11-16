/**
 * TanStack Query hooks for the public API. Every query refreshes every 60 s
 * so an open status page stays current without a reload.
 */
import type {
  DailyUptime,
  HistoryItem,
  HistoryQuery,
  Paginated,
  PublicIncident,
  PublicLocationsResponse,
  PublicMaintenance,
  PublicPageSettings,
  PublicService,
  PublicServiceGroup,
  PublicSummary,
  ServiceStatus,
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
    queryFn: () => api.get<PublicServicesResponse>('/api/public/services'),
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
    queryFn: () => api.get<PublicLocationsResponse>('/api/public/locations'),
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
    queryFn: () => api.get<Paginated<HistoryItem>>('/api/public/history', query),
    placeholderData: keepPreviousData,
    ...common,
  });
}
