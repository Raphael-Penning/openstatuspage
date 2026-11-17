/**
 * API contract between server and web client.
 *
 * Input schemas (suffix `Input`) are validated on the server. Output types
 * (prefix `Public` or `Admin`) describe JSON responses. See docs/api.md for the
 * endpoint list.
 */
import { z } from 'zod';
import {
  AGGREGATION_MODES,
  CHECK_STATES,
  IMPACT_STATUSES,
  INCIDENT_IMPACTS,
  INCIDENT_STATUSES,
  MAINTENANCE_STATUSES,
  MONITOR_SOURCE_TYPES,
  REGIONS,
  SERVICE_KINDS,
  SERVICE_STATUSES,
  STATUS_MODES,
  USER_ROLES,
  type CheckState,
  type IncidentImpact,
  type IncidentStatus,
  type MaintenanceStatus,
  type MonitorSourceType,
  type Region,
  type ServiceKind,
  type ServiceStatus,
  type UserRole,
  type AggregationMode,
  type StatusMode,
  type ImpactStatus,
  type OverallStatus,
} from './status.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const zServiceStatus = z.enum(SERVICE_STATUSES);
export const zImpactStatus = z.enum(IMPACT_STATUSES);
export const zCheckState = z.enum(CHECK_STATES);
export const zIncidentStatus = z.enum(INCIDENT_STATUSES);
export const zIncidentImpact = z.enum(INCIDENT_IMPACTS);
export const zMaintenanceStatus = z.enum(MAINTENANCE_STATUSES);
export const zAggregationMode = z.enum(AGGREGATION_MODES);
export const zStatusMode = z.enum(STATUS_MODES);
export const zServiceKind = z.enum(SERVICE_KINDS);
export const zMonitorSourceType = z.enum(MONITOR_SOURCE_TYPES);
export const zUserRole = z.enum(USER_ROLES);
export const zRegion = z.enum(REGIONS);

/** ISO-8601 timestamp, always serialized in UTC by the server. */
export const zTimestamp = z.iso.datetime({ offset: true });
/** URL-safe identifier; generated from the name when omitted. */
export const zSlug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and dashes only');
export const zId = z.string().min(1).max(64);
const zOptionalText = (max: number) => z.string().max(max).nullish();

/** Absolute http(s) URL. Rejects javascript:, data: and other schemes. */
export const zHttpUrl = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).max(500);
/** http(s) URL or a path on this site (`/logo.svg`), e.g. for logos. */
export const zHttpUrlOrPath = z
  .string()
  .max(500)
  .refine((v) => (v.startsWith('/') && !v.startsWith('//')) || zHttpUrl.safeParse(v).success, 'must be an http(s) URL or a path');

/** Value the server returns in place of stored secrets. Sending it back keeps the stored value. */
export const SECRET_MASK = '••••••••';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const zFooterLink = z.object({
  label: z.string().min(1).max(60),
  url: zHttpUrl,
});

export const SettingsInput = z.object({
  siteName: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  logoUrl: zHttpUrlOrPath.nullish(),
  faviconUrl: zHttpUrlOrPath.nullish(),
  /** CSS color used as accent (hex). */
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#7c6cf2'),
  defaultLocale: z.enum(['en', 'de']).default('en'),
  defaultTheme: z.enum(['system', 'dark', 'light']).default('system'),
  footerLinks: z.array(zFooterLink).max(10).default([]),
  supportUrl: zHttpUrl.nullish(),
  showLocations: z.boolean().default(true),
  showUptime: z.boolean().default(true),
  /** Number of days shown in uptime bars. */
  uptimeDays: z.number().int().min(7).max(180).default(90),
  /** How many days of resolved incidents appear on the overview. */
  recentIncidentDays: z.number().int().min(1).max(90).default(7),
  /** Offer email subscriptions on the public page (needs a configured mail transport). */
  emailSubscriptionsEnabled: z.boolean().default(false),
  /** Hours before a scheduled maintenance to remind subscribers; 0 disables reminders. */
  maintenanceReminderHours: z.number().int().min(0).max(168).default(24),
});
export type SettingsInput = z.infer<typeof SettingsInput>;
export type PublicPageSettings = SettingsInput;

// ---------------------------------------------------------------------------
// Auth & users
// ---------------------------------------------------------------------------

export const LoginInput = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const UserCreateInput = z.object({
  email: z.email().max(254),
  name: z.string().min(1).max(120),
  role: zUserRole,
  /** Optional for OIDC-only users. */
  password: z.string().min(10).max(256).nullish(),
});
export type UserCreateInput = z.infer<typeof UserCreateInput>;

export const UserUpdateInput = UserCreateInput.partial();
export type UserUpdateInput = z.infer<typeof UserUpdateInput>;

export const ChangePasswordInput = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(10).max(256),
});

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  hasPassword: boolean;
  oidcLinked: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionInfo {
  user: AdminUser;
  /** Whether OIDC login is configured (controls the SSO button). */
  oidcEnabled: boolean;
}

export interface AuthConfig {
  oidcEnabled: boolean;
  oidcLabel: string;
  localLoginEnabled: boolean;
}

export const ApiTokenCreateInput = z.object({
  name: z.string().min(1).max(120),
  role: zUserRole.default('editor'),
});

export interface AdminApiToken {
  id: string;
  name: string;
  role: UserRole;
  createdAt: string;
  lastUsedAt: string | null;
  /** Only present in the create response. */
  token?: string;
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export const LocationInput = z.object({
  name: z.string().min(1).max(120),
  slug: zSlug.nullish(),
  /** Short public code, e.g. "FRA-1". */
  code: zOptionalText(32),
  city: zOptionalText(120),
  /** ISO 3166-1 alpha-2 country code. */
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullish(),
  region: zRegion,
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  description: zOptionalText(1000),
  sortOrder: z.number().int().default(0),
  isPublic: z.boolean().default(true),
  /** Forces a status regardless of services. null = automatic. */
  statusOverride: zServiceStatus.nullish(),
});
export type LocationInput = z.infer<typeof LocationInput>;

export interface PublicLocation {
  id: string;
  slug: string;
  name: string;
  code: string | null;
  city: string | null;
  country: string | null;
  region: Region;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  status: ServiceStatus;
  serviceIds: string[];
}

export interface AdminLocation extends PublicLocation {
  sortOrder: number;
  isPublic: boolean;
  statusOverride: ServiceStatus | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Service groups & services
// ---------------------------------------------------------------------------

export const ServiceGroupInput = z.object({
  name: z.string().min(1).max(120),
  slug: zSlug.nullish(),
  description: zOptionalText(1000),
  sortOrder: z.number().int().default(0),
  isPublic: z.boolean().default(true),
  collapsedByDefault: z.boolean().default(false),
});
export type ServiceGroupInput = z.infer<typeof ServiceGroupInput>;

/** Link between a public service and an internal monitoring check. */
export const ServiceCheckLinkInput = z.object({
  checkId: zId,
  /** Service status when the check is in WARNING. null = ignore. */
  warningStatus: zImpactStatus.nullable().default('degraded'),
  /** Service status when the check is CRITICAL. null = ignore. */
  criticalStatus: zImpactStatus.nullable().default('major_outage'),
  /** Service status when the check is UNKNOWN. null = ignore (default). */
  unknownStatus: zImpactStatus.nullable().default(null),
});
export type ServiceCheckLinkInput = z.infer<typeof ServiceCheckLinkInput>;

export const ServiceInput = z.object({
  name: z.string().min(1).max(120),
  slug: zSlug.nullish(),
  description: zOptionalText(1000),
  kind: zServiceKind.default('service'),
  /** Public URL for sites. */
  url: zHttpUrl.nullish(),
  groupId: zId.nullish(),
  sortOrder: z.number().int().default(0),
  isPublic: z.boolean().default(true),
  statusMode: zStatusMode.default('auto'),
  /** Used when statusMode = manual. */
  manualStatus: zServiceStatus.default('operational'),
  aggregation: zAggregationMode.default('worst'),
  locationIds: z.array(zId).default([]),
  checks: z.array(ServiceCheckLinkInput).default([]),
});
export type ServiceInput = z.infer<typeof ServiceInput>;

export interface DailyUptime {
  /** YYYY-MM-DD in UTC. */
  date: string;
  /** Worst status observed that day. null = no data (before the service existed). */
  status: ServiceStatus | null;
  /**
   * 0..100, share of the observed time without partial_outage or major_outage.
   * Degraded performance and maintenance count as up. null = no data.
   */
  uptime: number | null;
  /** Minutes per non-operational status that day. */
  minutes: Partial<Record<ServiceStatus, number>>;
}

export interface PublicService {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: ServiceKind;
  url: string | null;
  groupId: string | null;
  status: ServiceStatus;
  locationIds: string[];
  /** Average uptime over the shown range in percent, null without data. */
  uptimePercent: number | null;
  /** Present when settings.showUptime is true. Oldest first. */
  uptime?: DailyUptime[];
}

export interface PublicServiceGroup {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  collapsedByDefault: boolean;
  status: ServiceStatus;
  services: PublicService[];
}

export interface AdminServiceCheckLink {
  checkId: string;
  warningStatus: ImpactStatus | null;
  criticalStatus: ImpactStatus | null;
  unknownStatus: ImpactStatus | null;
  check: AdminMonitorCheck;
}

export interface AdminService {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: ServiceKind;
  url: string | null;
  groupId: string | null;
  sortOrder: number;
  isPublic: boolean;
  statusMode: StatusMode;
  manualStatus: ServiceStatus;
  aggregation: AggregationMode;
  /** Effective public status. */
  status: ServiceStatus;
  /** Status derived from checks only (before incidents / maintenance). */
  monitorStatus: ServiceStatus;
  statusChangedAt: string | null;
  locationIds: string[];
  checks: AdminServiceCheckLink[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminServiceGroup {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isPublic: boolean;
  collapsedByDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Bulk reorder: `ids` in the desired order. */
export const ReorderInput = z.object({ ids: z.array(zId).min(1) });

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export const AffectedServiceInput = z.object({
  serviceId: zId,
  status: zImpactStatus,
});

export const IncidentCreateInput = z.object({
  title: z.string().min(1).max(200),
  status: zIncidentStatus.default('investigating'),
  impact: zIncidentImpact.default('minor'),
  /** First public update text. */
  message: z.string().min(1).max(10000),
  startedAt: zTimestamp.nullish(),
  isPublic: z.boolean().default(true),
  affectedServices: z.array(AffectedServiceInput).default([]),
  locationIds: z.array(zId).default([]),
  /** Email subscribers about this incident (only if public). */
  notify: z.boolean().default(true),
});
export type IncidentCreateInput = z.infer<typeof IncidentCreateInput>;

export const IncidentPatchInput = z.object({
  title: z.string().min(1).max(200).optional(),
  impact: zIncidentImpact.optional(),
  startedAt: zTimestamp.optional(),
  resolvedAt: zTimestamp.nullish(),
  isPublic: z.boolean().optional(),
  affectedServices: z.array(AffectedServiceInput).optional(),
  locationIds: z.array(zId).optional(),
});
export type IncidentPatchInput = z.infer<typeof IncidentPatchInput>;

/** Posting an update also moves the incident to `status`. "resolved" closes it. */
export const IncidentUpdateInput = z.object({
  status: zIncidentStatus,
  message: z.string().min(1).max(10000),
  /** Replaces the affected services when present. */
  affectedServices: z.array(AffectedServiceInput).optional(),
  /** Email subscribers about this update (only if the incident is public). */
  notify: z.boolean().default(true),
});
export type IncidentUpdateInput = z.infer<typeof IncidentUpdateInput>;

export const IncidentUpdateEditInput = z.object({
  message: z.string().min(1).max(10000),
});

export interface IncidentUpdateEntry {
  id: string;
  status: IncidentStatus;
  message: string;
  createdAt: string;
}

export interface AffectedService {
  id: string;
  name: string;
  status: ImpactStatus;
}

export interface PublicIncident {
  id: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  startedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
  affectedServices: AffectedService[];
  locationIds: string[];
  /** Newest first. */
  updates: IncidentUpdateEntry[];
}

export interface AdminIncident extends PublicIncident {
  isPublic: boolean;
  source: 'manual' | 'auto';
  createdAt: string;
  createdBy: string | null;
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export const MaintenanceCreateInput = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(10000).default(''),
    scheduledStart: zTimestamp,
    scheduledEnd: zTimestamp,
    /** Switch to in_progress automatically at scheduledStart. */
    autoStart: z.boolean().default(true),
    /** Switch to completed automatically at scheduledEnd. */
    autoComplete: z.boolean().default(true),
    isPublic: z.boolean().default(true),
    serviceIds: z.array(zId).default([]),
    locationIds: z.array(zId).default([]),
    /**
     * Email subscribers about this maintenance: the announcement, the reminder,
     * automatic start/completion. Stored on the maintenance.
     */
    notify: z.boolean().default(true),
  })
  .refine((m) => new Date(m.scheduledEnd) > new Date(m.scheduledStart), {
    message: 'scheduledEnd must be after scheduledStart',
    path: ['scheduledEnd'],
  });
export type MaintenanceCreateInput = z.infer<typeof MaintenanceCreateInput>;

export const MaintenancePatchInput = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(10000).optional(),
  scheduledStart: zTimestamp.optional(),
  scheduledEnd: zTimestamp.optional(),
  autoStart: z.boolean().optional(),
  autoComplete: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  serviceIds: z.array(zId).optional(),
  locationIds: z.array(zId).optional(),
  /** Changes the stored notification flag (does not send anything itself). */
  notify: z.boolean().optional(),
});
export type MaintenancePatchInput = z.infer<typeof MaintenancePatchInput>;

export const MaintenanceUpdateInput = z.object({
  status: zMaintenanceStatus,
  message: z.string().min(1).max(10000),
  /** Email subscribers about this update (only if the maintenance is public). */
  notify: z.boolean().default(true),
});
export type MaintenanceUpdateInput = z.infer<typeof MaintenanceUpdateInput>;

export interface MaintenanceUpdateEntry {
  id: string;
  status: MaintenanceStatus;
  message: string;
  createdAt: string;
}

export interface PublicMaintenance {
  id: string;
  title: string;
  description: string;
  status: MaintenanceStatus;
  scheduledStart: string;
  scheduledEnd: string;
  actualStart: string | null;
  actualEnd: string | null;
  affectedServices: { id: string; name: string }[];
  locationIds: string[];
  /** Newest first. */
  updates: MaintenanceUpdateEntry[];
}

export interface AdminMaintenance extends PublicMaintenance {
  autoStart: boolean;
  autoComplete: boolean;
  isPublic: boolean;
  /** Subscribers are notified about this maintenance (see MaintenanceCreateInput.notify). */
  notify: boolean;
  /** When the reminder email was queued, null if not (yet). */
  reminderSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Monitoring sources & checks (internal only)
// ---------------------------------------------------------------------------

const zHttpBase = z.object({
  baseUrl: zHttpUrl,
  /** Disable only for self-signed certificates in trusted networks. */
  verifyTls: z.boolean().default(true),
});

export const Icinga2Config = zHttpBase.extend({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
  /** Optional Icinga 2 API filter expression, e.g. `"customer-facing" in service.groups`. */
  filter: z.string().max(2000).nullish(),
  /** Import host checks in addition to service checks. */
  includeHosts: z.boolean().default(true),
});

export const UptimeKumaConfig = zHttpBase.extend({
  /** API key from Uptime Kuma (Settings → API Keys), used for the /metrics endpoint. */
  apiKey: z.string().min(1).max(500),
});

export const OpenItCockpitConfig = zHttpBase.extend({
  /** API key from openITCockpit (user profile → API keys). */
  apiKey: z.string().min(1).max(500),
  includeHosts: z.boolean().default(true),
});

export const WebhookConfig = z.object({});

export const MonitorSourceInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('icinga2'), config: Icinga2Config }),
  z.object({ type: z.literal('uptimekuma'), config: UptimeKumaConfig }),
  z.object({ type: z.literal('openitcockpit'), config: OpenItCockpitConfig }),
  z.object({ type: z.literal('webhook'), config: WebhookConfig }),
]).and(
  z.object({
    name: z.string().min(1).max(120),
    enabled: z.boolean().default(true),
    /** Polling interval. Ignored for type "webhook". */
    pollIntervalSeconds: z.number().int().min(10).max(86400).default(60),
  }),
);
export type MonitorSourceInput = z.infer<typeof MonitorSourceInput>;

export interface AdminMonitorSource {
  id: string;
  name: string;
  type: MonitorSourceType;
  enabled: boolean;
  pollIntervalSeconds: number;
  /** Secrets are replaced with SECRET_MASK. */
  config: Record<string, unknown>;
  /** Absolute URL monitoring systems can push to. */
  ingestUrl: string;
  lastPollAt: string | null;
  lastPollOk: boolean | null;
  lastError: string | null;
  checkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminMonitorCheck {
  id: string;
  sourceId: string;
  sourceName: string;
  externalId: string;
  name: string;
  host: string | null;
  state: CheckState;
  output: string | null;
  lastCheckAt: string | null;
  lastStateChangeAt: string | null;
  /** Number of services this check feeds into. */
  serviceCount: number;
}

/** Result of "test connection" on a monitoring source. */
export interface MonitorSourceTestResult {
  ok: boolean;
  message: string;
  checkCount?: number;
}

/**
 * Generic push format accepted by POST /api/ingest/:sourceId
 * (Authorization: Bearer <source token>).
 */
export const GenericIngestPayload = z.object({
  checks: z
    .array(
      z.object({
        id: z.string().min(1).max(500),
        name: z.string().max(500).optional(),
        host: z.string().max(500).optional(),
        state: z.union([zCheckState, z.number().int().min(0).max(3)]),
        output: z.string().max(5000).optional(),
        timestamp: zTimestamp.optional(),
      }),
    )
    .min(1)
    .max(5000),
  /** When true, checks of this source missing from the payload are removed (webhook sources only). */
  full: z.boolean().default(false),
});
export type GenericIngestPayload = z.infer<typeof GenericIngestPayload>;

// ---------------------------------------------------------------------------
// Public aggregate responses
// ---------------------------------------------------------------------------

export interface PublicSummary {
  page: PublicPageSettings;
  overall: OverallStatus;
  groups: PublicServiceGroup[];
  /** Services without a (public) group. */
  ungrouped: PublicService[];
  activeIncidents: PublicIncident[];
  /** Resolved within settings.recentIncidentDays. */
  recentIncidents: PublicIncident[];
  activeMaintenances: PublicMaintenance[];
  upcomingMaintenances: PublicMaintenance[];
  /** Email subscriptions are enabled in the settings AND a mail transport is configured. */
  emailSubscriptions: boolean;
  generatedAt: string;
}

export interface PublicLocationsResponse {
  locations: PublicLocation[];
  counts: Record<ServiceStatus, number>;
}

export const HistoryQuery = z.object({
  type: z.enum(['all', 'incident', 'maintenance']).default('all'),
  serviceId: zId.optional(),
  locationId: zId.optional(),
  /** Month filter, YYYY-MM. */
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type HistoryQuery = z.infer<typeof HistoryQuery>;

export type HistoryItem =
  | { type: 'incident'; date: string; incident: PublicIncident }
  | { type: 'maintenance'; date: string; maintenance: PublicMaintenance };

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuditLogEntry {
  id: string;
  userId: string | null;
  userName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Email subscriptions
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_LOCALES = ['en', 'de'] as const;
export type SubscriptionLocale = (typeof SUBSCRIPTION_LOCALES)[number];
export const zSubscriptionLocale = z.enum(SUBSCRIPTION_LOCALES);

const subscriptionScope = {
  /** All public incidents and maintenance. When false, only those affecting `serviceIds`. */
  allServices: z.boolean().default(true),
  /** Public service ids; required (non-empty) when allServices is false. */
  serviceIds: z.array(zId).max(500).default([]),
};
const requireServices = <T extends { allServices: boolean; serviceIds: string[] }>(s: T) =>
  s.allServices || s.serviceIds.length > 0;
const requireServicesIssue = { message: 'Select at least one service', path: ['serviceIds'] };

/** POST /api/public/subscriptions. Always answered with 202 (no address enumeration). */
export const SubscribeInput = z
  .object({
    email: z.email().max(254),
    locale: zSubscriptionLocale.default('en'),
    ...subscriptionScope,
    /**
     * Honeypot for bots (hidden field, humans leave it empty). A filled-in value is
     * accepted and answered like a successful subscribe, but nothing is created or sent.
     */
    website: z.string().max(500).optional(),
  })
  .refine(requireServices, requireServicesIssue);
export type SubscribeInput = z.infer<typeof SubscribeInput>;

/** PUT /api/public/subscriptions/:id (token in the X-Subscription-Token header). */
export const SubscriptionPreferencesInput = z
  .object({ locale: zSubscriptionLocale.default('en'), ...subscriptionScope })
  .refine(requireServices, requireServicesIssue);
export type SubscriptionPreferencesInput = z.infer<typeof SubscriptionPreferencesInput>;

/** POST /api/public/subscriptions/:id/confirm */
export const SubscriptionConfirmInput = z.object({ token: z.string().min(16).max(256) });
export type SubscriptionConfirmInput = z.infer<typeof SubscriptionConfirmInput>;

/** Header carrying the manage token for GET/PUT/DELETE /api/public/subscriptions/:id. */
export const SUBSCRIPTION_TOKEN_HEADER = 'x-subscription-token';

/** GET /api/public/subscriptions/:id (only with a valid manage token). */
export interface PublicSubscription {
  id: string;
  email: string;
  locale: SubscriptionLocale;
  allServices: boolean;
  serviceIds: string[];
  confirmed: boolean;
}

export const SubscriberListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  /** Substring match on the email address. */
  q: z.string().max(254).optional(),
  status: z.enum(['all', 'confirmed', 'pending']).default('all'),
});
export type SubscriberListQuery = z.infer<typeof SubscriberListQuery>;

/** GET /api/admin/subscribers (admin only). */
export interface AdminSubscriber {
  id: string;
  email: string;
  locale: SubscriptionLocale;
  allServices: boolean;
  /** Selected services when allServices is false. */
  services: { id: string; name: string }[];
  confirmed: boolean;
  createdAt: string;
  confirmedAt: string | null;
}

export type MailTransportKind = 'smtp' | 'log' | 'none';

/** GET /api/admin/notifications/status (admin only). */
export interface NotificationStatus {
  transport: MailTransportKind;
  /** A transport that can deliver mail is configured (smtp or log). */
  configured: boolean;
  from: string | null;
  /** settings.emailSubscriptionsEnabled */
  subscriptionsEnabled: boolean;
  subscribers: { confirmed: number; pending: number };
  queue: { pending: number; failed: number };
  lastSentAt: string | null;
  lastError: { message: string; at: string } | null;
}

/** POST /api/admin/notifications/test (admin only). */
export const TestEmailInput = z.object({ to: z.email().max(254) });
export type TestEmailInput = z.infer<typeof TestEmailInput>;

/** Error body for every non-2xx response. */
export interface ApiError {
  error: string;
  message: string;
  /** Zod issues for 400 responses. */
  issues?: unknown;
}

