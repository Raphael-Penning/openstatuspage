/**
 * TanStack Query hooks for the public API (JSON:API). Every query refreshes
 * every 60 s so an open status page stays current without a reload. The hooks
 * return the plain shapes of @openstatuspage/shared (see lib/api.ts).
 *
 * The query options come from `publicQueries`, which takes the source of the
 * JSON:API documents: HTTP in the browser (default), the server's own document
 * builders during server-side rendering (entry-server.tsx). Both sides therefore
 * use the same query keys and the same deserialization, and the dehydrated
 * server state is exactly what the hooks expect.
 */
import {
  deserialize,
  deserializeDocument,
  deserializePage,
  resourceType,
  toQueryParams,
  type DailyUptime,
  type DataDocument,
  type HistoryItem,
  type HistoryQuery,
  type Paginated,
  type PublicIncident,
  type PublicLocation,
  type PublicLocationsResponse,
  type PublicMaintenance,
  type PublicPageSettings,
  type PublicService,
  type PublicServiceDay,
  type PublicServiceGroup,
  type PublicSummary,
  type ServiceStatus,
} from '@openstatuspage/shared';
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
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

/** A day of a service (GET /api/public/services/{idOrSlug}/days/{date}) with what it includes by default. */
export type PublicServiceDayDetail = PublicServiceDay & {
  service: PublicService;
  incidents: PublicIncident[];
  maintenances: PublicMaintenance[];
};

/** Reads one JSON:API document of the public API: GET `path` with JSON:API query parameters. */
export type GetDocument = (path: string, query?: Record<string, string>) => Promise<DataDocument>;

/** The browser's source: the public API over HTTP. */
export const httpDocuments: GetDocument = (path, query) => api.document(path, query);

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
export async function fetchServices(get: GetDocument = httpDocuments): Promise<PublicServicesResponse> {
  const { data, included, meta } = deserializeDocument<PublicService[]>(await get('/api/public/services'));
  const groups = included.filter((r) => resourceType(r) === 'service-groups') as unknown as PublicServiceGroup[];
  return {
    groups,
    ungrouped: data.filter((s) => s.groupId === null),
    counts: meta.counts as Record<ServiceStatus, number>,
  };
}

export async function fetchLocations(get: GetDocument = httpDocuments): Promise<PublicLocationsResponse> {
  const { data, meta } = deserializeDocument<PublicLocation[]>(await get('/api/public/locations'));
  return { locations: data, counts: meta.counts as Record<ServiceStatus, number> };
}

/** History page: incidents and maintenance windows as HistoryItems. */
export async function fetchHistory(query: Partial<HistoryQuery>, get: GetDocument = httpDocuments): Promise<Paginated<HistoryItem>> {
  const params = toQueryParams({
    page: { number: query.page, size: query.pageSize },
    filter: {
      type: query.type === 'all' ? undefined : query.type,
      service: query.serviceId,
      location: query.locationId,
      month: query.month,
    },
  });
  const page = deserializePage<PublicIncident | PublicMaintenance>(await get('/api/public/history', params));
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

const one = async <T,>(get: GetDocument, path: string): Promise<T> => deserialize<T>(await get(path));

/**
 * Query options of the public pages, bound to a document source. Use them for
 * hooks, prefetching (route loaders in routes.tsx) and cache access alike.
 */
export const publicQueries = {
  settings: (get: GetDocument = httpDocuments) =>
    queryOptions({
      queryKey: ['public', 'settings'],
      queryFn: () => one<PublicPageSettings>(get, '/api/public/settings'),
      ...common,
    }),
  summary: (get: GetDocument = httpDocuments) =>
    queryOptions({
      queryKey: ['public', 'summary'],
      queryFn: () => one<PublicSummary>(get, '/api/public/summary'),
      ...common,
    }),
  services: (get: GetDocument = httpDocuments) =>
    queryOptions({ queryKey: ['public', 'services'], queryFn: () => fetchServices(get), ...common }),
  service: (idOrSlug: string, get: GetDocument = httpDocuments) =>
    queryOptions({
      queryKey: ['public', 'service', idOrSlug],
      queryFn: () => one<PublicServiceDetail>(get, `/api/public/services/${encodeURIComponent(idOrSlug)}`),
      ...common,
    }),
  serviceDay: (idOrSlug: string, date: string, get: GetDocument = httpDocuments) =>
    queryOptions({
      queryKey: ['public', 'service-day', idOrSlug, date],
      queryFn: () =>
        one<PublicServiceDayDetail>(get, `/api/public/services/${encodeURIComponent(idOrSlug)}/days/${encodeURIComponent(date)}`),
      ...common,
      // A past day does not change any more (unless corrected); today does.
      refetchInterval: (query) => (query.state.data?.complete ? false : REFRESH_INTERVAL),
    }),
  locations: (get: GetDocument = httpDocuments) =>
    queryOptions({ queryKey: ['public', 'locations'], queryFn: () => fetchLocations(get), ...common }),
  incident: (id: string, get: GetDocument = httpDocuments) =>
    queryOptions({
      queryKey: ['public', 'incident', id],
      queryFn: () => one<PublicIncident>(get, `/api/public/incidents/${encodeURIComponent(id)}`),
      ...common,
    }),
  maintenance: (id: string, get: GetDocument = httpDocuments) =>
    queryOptions({
      queryKey: ['public', 'maintenance', id],
      queryFn: () => one<PublicMaintenance>(get, `/api/public/maintenances/${encodeURIComponent(id)}`),
      ...common,
    }),
  history: (query: Partial<HistoryQuery>, get: GetDocument = httpDocuments) =>
    queryOptions({
      queryKey: ['public', 'history', query],
      queryFn: () => fetchHistory(query, get),
      placeholderData: keepPreviousData,
      ...common,
    }),
};

export function usePublicSettings() {
  return useQuery(publicQueries.settings());
}

export function useSummary() {
  return useQuery(publicQueries.summary());
}

export function useServices() {
  return useQuery(publicQueries.services());
}

export function useService(idOrSlug: string) {
  return useQuery(publicQueries.service(idOrSlug));
}

/** A day of a service; disabled for a malformed date (the page shows "not found" without asking). */
export function useServiceDay(idOrSlug: string, date: string, enabled = true) {
  return useQuery({ ...publicQueries.serviceDay(idOrSlug, date), enabled });
}

export function useLocations(enabled = true) {
  return useQuery({ ...publicQueries.locations(), enabled });
}

export function useIncident(id: string) {
  return useQuery(publicQueries.incident(id));
}

export function useMaintenance(id: string) {
  return useQuery(publicQueries.maintenance(id));
}

export function useHistory(query: Partial<HistoryQuery>) {
  return useQuery(publicQueries.history(query));
}
