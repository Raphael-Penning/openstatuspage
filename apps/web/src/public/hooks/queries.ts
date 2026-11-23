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
  PRIVATE_PAGE_TOKEN_HEADER,
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
  type PublicPrivatePage,
  type PublicService,
  type PublicServiceDay,
  type PublicServiceGroup,
  type PublicSiteExtras,
  type PublicSitePage,
  type PublicSummary,
  type ServiceStatus,
} from '@openstatuspage/shared';
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { usePrivatePageToken } from './private-page';

export const REFRESH_INTERVAL = 60_000;

/** The public settings document: page settings, published content pages, size of an uploaded logo. */
export type PublicSiteSettings = PublicPageSettings & PublicSiteExtras;

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
      queryFn: () => one<PublicSiteSettings>(get, '/api/public/settings'),
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
  /** A published content page by its slug (about, legal-notice, privacy, accessibility or a custom page). */
  page: (slug: string, get: GetDocument = httpDocuments) =>
    queryOptions({
      queryKey: ['public', 'page', slug],
      queryFn: () => one<PublicSitePage>(get, `/api/public/pages/${encodeURIComponent(slug)}`),
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

/**
 * The document source of a private page: in the browser the token travels in
 * the X-Private-Page-Token header, never in an API URL; on the server (`get`,
 * the route loaders) the in-process source takes it as the `token` value.
 */
export function privateDocuments(token: string, get?: GetDocument): GetDocument {
  if (get) return (path, query) => get(path, { ...query, token });
  return (path, query) => api.document(path, query, { headers: { [PRIVATE_PAGE_TOKEN_HEADER]: token } });
}

const PRIVATE_API = '/api/public/private-page';

/** Query options of a private page (/p/<token>), like publicQueries. */
export const privateQueries = {
  page: (token: string, get?: GetDocument) =>
    queryOptions({
      queryKey: ['private', token, 'page'],
      queryFn: () => one<PublicPrivatePage>(privateDocuments(token, get), PRIVATE_API),
      ...common,
    }),
  service: (token: string, idOrSlug: string, get?: GetDocument) =>
    queryOptions({
      queryKey: ['private', token, 'service', idOrSlug],
      queryFn: () => one<PublicServiceDetail>(privateDocuments(token, get), `${PRIVATE_API}/services/${encodeURIComponent(idOrSlug)}`),
      ...common,
    }),
  serviceDay: (token: string, idOrSlug: string, date: string, get?: GetDocument) =>
    queryOptions({
      queryKey: ['private', token, 'service-day', idOrSlug, date],
      queryFn: () =>
        one<PublicServiceDayDetail>(
          privateDocuments(token, get),
          `${PRIVATE_API}/services/${encodeURIComponent(idOrSlug)}/days/${encodeURIComponent(date)}`,
        ),
      ...common,
      refetchInterval: (query) => (query.state.data?.complete ? false : REFRESH_INTERVAL),
    }),
  incident: (token: string, id: string, get?: GetDocument) =>
    queryOptions({
      queryKey: ['private', token, 'incident', id],
      queryFn: () => one<PublicIncident>(privateDocuments(token, get), `${PRIVATE_API}/incidents/${encodeURIComponent(id)}`),
      ...common,
    }),
  maintenance: (token: string, id: string, get?: GetDocument) =>
    queryOptions({
      queryKey: ['private', token, 'maintenance', id],
      queryFn: () => one<PublicMaintenance>(privateDocuments(token, get), `${PRIVATE_API}/maintenances/${encodeURIComponent(id)}`),
      ...common,
    }),
};

/** The private page of the token (disabled for a malformed token: "not found" without asking). */
export function usePrivatePage(token: string, enabled = true) {
  return useQuery({ ...privateQueries.page(token), enabled });
}

export function usePublicSettings() {
  return useQuery(publicQueries.settings());
}

export function useSummary() {
  return useQuery(publicQueries.summary());
}

export function useServices() {
  return useQuery(publicQueries.services());
}

/** A service with its bars, incidents and maintenance; of the private page when inside one. */
export function useService(idOrSlug: string) {
  const token = usePrivatePageToken();
  return useQuery(token ? privateQueries.service(token, idOrSlug) : publicQueries.service(idOrSlug));
}

/**
 * A day of a service (of the private page when inside one); disabled for a
 * malformed date (the page shows "not found" without asking).
 */
export function useServiceDay(idOrSlug: string, date: string, enabled = true) {
  const token = usePrivatePageToken();
  return useQuery({ ...(token ? privateQueries.serviceDay(token, idOrSlug, date) : publicQueries.serviceDay(idOrSlug, date)), enabled });
}

export function useLocations(enabled = true) {
  return useQuery({ ...publicQueries.locations(), enabled });
}

/** An incident; of the private page when inside one (only the page's services). */
export function useIncident(id: string) {
  const token = usePrivatePageToken();
  return useQuery(token ? privateQueries.incident(token, id) : publicQueries.incident(id));
}

/** A maintenance window; of the private page when inside one. */
export function useMaintenance(id: string) {
  const token = usePrivatePageToken();
  return useQuery(token ? privateQueries.maintenance(token, id) : publicQueries.maintenance(id));
}

/** A published content page. */
export function useSitePage(slug: string) {
  return useQuery(publicQueries.page(slug));
}

export function useHistory(query: Partial<HistoryQuery>) {
  return useQuery(publicQueries.history(query));
}
