/**
 * TanStack Query hooks for the admin API. Every admin query key starts with
 * "admin" so a mutation can refresh all admin data with one invalidation.
 */
import type {
  AdminApiToken,
  AdminCheckBundle,
  AdminCorrection,
  AdminHistoryImport,
  AdminIncident,
  AdminLocation,
  AdminMaintenance,
  AdminMonitorCheck,
  AdminMonitorSource,
  AdminService,
  AdminServiceGroup,
  AdminServiceHistory,
  AdminSubscriber,
  AdminUser,
  AuditLogEntry,
  AuthConfig,
  BundleCandidateSource,
  CheckState,
  ConfigurableSourceType,
  NotificationStatus,
  Paginated,
  PublicPageSettings,
  ServiceStatus,
  SessionInfo,
  SubscriberListQuery,
} from '@openstatuspage/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast';
import { api, ApiError } from '../../lib/api';
import { apiErrorMessage } from './errors';

export interface AdminOverview {
  counts: {
    services: number;
    incidentsActive: number;
    maintenancesActive: number;
    maintenancesUpcoming: number;
    sources: number;
    sourcesFailing: number;
    checks: number;
    checksFailing: number;
  };
  services: AdminService[];
  recentAudit: AuditLogEntry[];
}

export interface ChecksFilter {
  sourceId?: string;
  q?: string;
  state?: CheckState;
  unlinked?: boolean;
}

export interface CorrectionsFilter {
  serviceId?: string;
  /** ISO timestamps; only corrections overlapping [from, to). */
  from?: string;
  to?: string;
  page: number;
}

export const keys = {
  session: ['auth', 'session'] as const,
  authConfig: ['auth', 'config'] as const,
  overview: ['admin', 'overview'] as const,
  services: ['admin', 'services'] as const,
  service: (id: string) => ['admin', 'services', id] as const,
  groups: ['admin', 'service-groups'] as const,
  locations: ['admin', 'locations'] as const,
  location: (id: string) => ['admin', 'locations', id] as const,
  incidents: (status: string, page: number) => ['admin', 'incidents', 'list', status, page] as const,
  incident: (id: string) => ['admin', 'incidents', id] as const,
  maintenances: (status: string, page: number) => ['admin', 'maintenances', 'list', status, page] as const,
  maintenance: (id: string) => ['admin', 'maintenances', id] as const,
  sources: ['admin', 'monitor-sources'] as const,
  source: (id: string) => ['admin', 'monitor-sources', id] as const,
  historyImports: (sourceId: string) => ['admin', 'monitor-sources', sourceId, 'history-imports'] as const,
  historyImport: (sourceId: string, id: string) => ['admin', 'monitor-sources', sourceId, 'history-imports', id] as const,
  checks: (filter: ChecksFilter) => ['admin', 'checks', filter] as const,
  bundles: ['admin', 'check-bundles'] as const,
  bundleCandidates: (type: string) => ['admin', 'check-bundles', 'candidates', type] as const,
  settings: ['admin', 'settings'] as const,
  users: ['admin', 'users'] as const,
  tokens: ['admin', 'api-tokens'] as const,
  audit: (page: number, entityType: string) => ['admin', 'audit-log', page, entityType] as const,
  subscribers: (query: SubscriberListQuery) => ['admin', 'subscribers', query] as const,
  notificationStatus: ['admin', 'notifications', 'status'] as const,
  corrections: (filter: CorrectionsFilter) => ['admin', 'corrections', 'list', filter] as const,
  serviceHistory: (id: string, from: string, to: string) => ['admin', 'services', id, 'history', from, to] as const,
};

const notRetryingClientErrors = (failureCount: number, error: unknown) =>
  !(error instanceof ApiError && error.status < 500) && failureCount < 1;

// --- Auth ----------------------------------------------------------------------

export function useAuthConfig() {
  return useQuery({ queryKey: keys.authConfig, queryFn: () => api.get<AuthConfig>('/api/auth/config'), staleTime: 5 * 60_000 });
}

export function useSessionQuery() {
  return useQuery({
    queryKey: keys.session,
    queryFn: () => api.get<SessionInfo>('/api/auth/session'),
    retry: notRetryingClientErrors,
    staleTime: 60_000,
  });
}

// --- Generic ---------------------------------------------------------------------

function useAdminQuery<T>(queryKey: readonly unknown[], path: string, query?: Record<string, string | number | boolean | undefined>, enabled = true) {
  return useQuery({
    queryKey,
    queryFn: () => api.get<T>(path, query),
    retry: notRetryingClientErrors,
    enabled,
  });
}

export const useOverview = () => useAdminQuery<AdminOverview>(keys.overview, '/api/admin/overview');
export const useServices = () => useAdminQuery<AdminService[]>(keys.services, '/api/admin/services');
export const useService = (id: string | undefined) =>
  useAdminQuery<AdminService>(keys.service(id ?? ''), `/api/admin/services/${id}`, undefined, Boolean(id));
export const useGroups = () => useAdminQuery<AdminServiceGroup[]>(keys.groups, '/api/admin/service-groups');
export const useLocations = () => useAdminQuery<AdminLocation[]>(keys.locations, '/api/admin/locations');
export const useLocation = (id: string | undefined) =>
  useAdminQuery<AdminLocation>(keys.location(id ?? ''), `/api/admin/locations/${id}`, undefined, Boolean(id));
export const useIncidents = (status: string, page: number, pageSize = 20) =>
  useQuery({
    queryKey: keys.incidents(status, page),
    queryFn: () =>
      api.getPage<AdminIncident>('/api/admin/incidents', { page: { number: page, size: pageSize }, filter: { status } }),
    retry: notRetryingClientErrors,
  });
export const useIncident = (id: string | undefined) =>
  useAdminQuery<AdminIncident>(keys.incident(id ?? ''), `/api/admin/incidents/${id}`, undefined, Boolean(id));
export const useMaintenances = (status: string, page: number, pageSize = 20) =>
  useQuery({
    queryKey: keys.maintenances(status, page),
    queryFn: () =>
      api.getPage<AdminMaintenance>('/api/admin/maintenances', { page: { number: page, size: pageSize }, filter: { status } }),
    retry: notRetryingClientErrors,
  });
export const useMaintenance = (id: string | undefined) =>
  useAdminQuery<AdminMaintenance>(keys.maintenance(id ?? ''), `/api/admin/maintenances/${id}`, undefined, Boolean(id));
export const useSources = (enabled = true) =>
  useAdminQuery<AdminMonitorSource[]>(keys.sources, '/api/admin/monitor-sources', undefined, enabled);
export const useSource = (id: string | undefined) =>
  useAdminQuery<AdminMonitorSource>(keys.source(id ?? ''), `/api/admin/monitor-sources/${id}`, undefined, Boolean(id));
export const useHistoryImports = (sourceId: string | undefined) =>
  useAdminQuery<AdminHistoryImport[]>(
    keys.historyImports(sourceId ?? ''),
    `/api/admin/monitor-sources/${sourceId}/history-imports`,
    undefined,
    Boolean(sourceId),
  );
/** One import job; polled while it is fetching or being written. */
export const useHistoryImport = (sourceId: string, id: string | null) =>
  useQuery({
    queryKey: keys.historyImport(sourceId, id ?? ''),
    queryFn: () => api.get<AdminHistoryImport>(`/api/admin/monitor-sources/${sourceId}/history-imports/${id}`),
    retry: notRetryingClientErrors,
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'fetching' || status === 'applying' ? 1500 : false;
    },
  });
export const useChecks = (filter: ChecksFilter, enabled = true) =>
  useAdminQuery<AdminMonitorCheck[]>(
    keys.checks(filter),
    '/api/admin/checks',
    { sourceId: filter.sourceId, q: filter.q, state: filter.state, unlinked: filter.unlinked ? 'true' : undefined },
    enabled,
  );
/** Bundles with their live vote; refreshed regularly so the breakdown stays current. */
export const useBundles = () =>
  useQuery({
    queryKey: keys.bundles,
    queryFn: () => api.get<AdminCheckBundle[]>('/api/admin/check-bundles'),
    retry: notRetryingClientErrors,
    refetchInterval: 30_000,
  });
export const useBundleCandidates = (type: ConfigurableSourceType | '') =>
  useAdminQuery<BundleCandidateSource[]>(keys.bundleCandidates(type), '/api/admin/check-bundles/candidates', {
    type: type || undefined,
  });
export const useSettings = () => useAdminQuery<PublicPageSettings>(keys.settings, '/api/admin/settings');
export const useUsers = () => useAdminQuery<AdminUser[]>(keys.users, '/api/admin/users');
export const useApiTokens = () => useAdminQuery<AdminApiToken[]>(keys.tokens, '/api/admin/api-tokens');
export const useAuditLog = (page: number, entityType: string, pageSize = 25) =>
  useAdminQuery<Paginated<AuditLogEntry>>(keys.audit(page, entityType), '/api/admin/audit-log', {
    page,
    pageSize,
    entityType: entityType || undefined,
  });

export const useCorrections = (filter: CorrectionsFilter, pageSize = 20) =>
  useQuery({
    queryKey: keys.corrections(filter),
    queryFn: () => api.get<Paginated<AdminCorrection>>('/api/admin/corrections', { ...filter, pageSize }),
    retry: notRetryingClientErrors,
    placeholderData: keepPreviousData,
  });
export const useServiceHistory = (id: string, from: string, to: string, enabled = true) =>
  useAdminQuery<AdminServiceHistory>(keys.serviceHistory(id, from, to), `/api/admin/services/${id}/history`, { from, to }, enabled);

export const useSubscribers = (query: SubscriberListQuery) =>
  useQuery({
    queryKey: keys.subscribers(query),
    queryFn: () => api.get<Paginated<AdminSubscriber>>('/api/admin/subscribers', { ...query, q: query.q || undefined }),
    retry: notRetryingClientErrors,
    placeholderData: keepPreviousData,
  });
export const useNotificationStatus = () =>
  useQuery({
    queryKey: keys.notificationStatus,
    queryFn: () => api.get<NotificationStatus>('/api/admin/notifications/status'),
    retry: notRetryingClientErrors,
    refetchInterval: 30_000,
  });

export type PreviewResult = { monitorStatus: ServiceStatus; status?: ServiceStatus };

// --- Mutations ---------------------------------------------------------------------

interface AdminMutationOptions<TData, TVars> {
  /** Toast shown on success (already translated). */
  success?: string | ((data: TData, vars: TVars) => string);
  onSuccess?: (data: TData, vars: TVars) => void | Promise<void>;
  /**
   * Called on error before the default toast; return true when the error was
   * fully handled (e.g. validation errors mapped to form fields).
   */
  onError?: (error: unknown, vars: TVars) => boolean | void;
}

/**
 * Mutation with toast feedback that refreshes all admin queries on success
 * and the session on 401.
 */
export function useAdminMutation<TVars = void, TData = unknown>(
  fn: (vars: TVars) => Promise<TData>,
  options: AdminMutationOptions<TData, TVars> = {},
) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation('admin');
  return useMutation<TData, unknown, TVars>({
    mutationFn: fn,
    onSuccess: async (data, vars) => {
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      if (options.success) {
        toast.success(typeof options.success === 'function' ? options.success(data, vars) : options.success);
      }
      await options.onSuccess?.(data, vars);
    },
    onError: (error, vars) => {
      if (error instanceof ApiError && error.status === 401) {
        void queryClient.invalidateQueries({ queryKey: keys.session });
      }
      if (options.onError?.(error, vars) === true) return;
      toast.error(apiErrorMessage(error, t));
    },
  });
}
