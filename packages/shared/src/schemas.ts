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
  /**
   * Present (true) when a correction marked as public changed this day's data
   * afterwards. Values above already include all corrections.
   */
  corrected?: true;
  /** Public notes of those corrections (may be empty). */
  correctionNotes?: string[];
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

/** An `incident-updates` resource as answered by the admin API, with its incident (without the updates). */
export interface AdminIncidentUpdate extends IncidentUpdateEntry {
  incidentId: string;
  incident?: Omit<AdminIncident, 'updates'>;
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
  /** When the window was entered and last changed (publication dates of the report). */
  createdAt: string;
  updatedAt: string;
}

export interface AdminMaintenance extends PublicMaintenance {
  autoStart: boolean;
  autoComplete: boolean;
  isPublic: boolean;
  /** Subscribers are notified about this maintenance (see MaintenanceCreateInput.notify). */
  notify: boolean;
  /** When the reminder email was queued, null if not (yet). */
  reminderSentAt: string | null;
  /**
   * The window had already started when it was entered. It counts as
   * "maintenance" in the corrected history; no announcement or reminder is sent,
   * and a window that had already ended is created as completed without any email.
   */
  retroactive: boolean;
}

/** A `maintenance-updates` resource as answered by the admin API, with its maintenance (without the updates). */
export interface AdminMaintenanceUpdate extends MaintenanceUpdateEntry {
  maintenanceId: string;
  maintenance?: Omit<AdminMaintenance, 'updates'>;
}

// ---------------------------------------------------------------------------
// History corrections (status overrides for a past time range)
// ---------------------------------------------------------------------------

/** Longest time range of one correction and of the admin history comparison. */
export const CORRECTION_MAX_DAYS = 366;
const DAY_MS = 86_400_000;

const correctionFields = {
  serviceIds: z.array(zId).min(1).max(500),
  startsAt: zTimestamp,
  /** Exclusive. Must not be in the future: corrections only change the past. */
  endsAt: zTimestamp,
  /** Status the services had in [startsAt, endsAt), e.g. operational for a false alarm. */
  status: zServiceStatus,
  /** Internal reason (required). Never shown publicly. */
  reason: z.string().trim().min(1).max(2000),
  /** Mark the affected days as "corrected afterwards" on the public page. */
  showPublic: z.boolean(),
  /** Optional text shown with the public marker. */
  publicNote: z.string().trim().max(500).nullish(),
};

function validRange(v: { startsAt?: string; endsAt?: string }): boolean {
  if (!v.startsAt || !v.endsAt) return true;
  return new Date(v.endsAt) > new Date(v.startsAt);
}
function notTooLong(v: { startsAt?: string; endsAt?: string }): boolean {
  if (!v.startsAt || !v.endsAt) return true;
  return new Date(v.endsAt).getTime() - new Date(v.startsAt).getTime() <= CORRECTION_MAX_DAYS * DAY_MS;
}

export const CorrectionInput = z
  .object({ ...correctionFields, showPublic: correctionFields.showPublic.default(false) })
  .refine(validRange, { message: 'endsAt must be after startsAt', path: ['endsAt'] })
  .refine(notTooLong, { message: `at most ${CORRECTION_MAX_DAYS} days`, path: ['endsAt'] });
export type CorrectionInput = z.infer<typeof CorrectionInput>;

export const CorrectionPatchInput = z
  .object(correctionFields)
  .partial()
  .refine(validRange, { message: 'endsAt must be after startsAt', path: ['endsAt'] })
  .refine(notTooLong, { message: `at most ${CORRECTION_MAX_DAYS} days`, path: ['endsAt'] });
export type CorrectionPatchInput = z.infer<typeof CorrectionPatchInput>;

/** `filter[...]` parameters of GET /api/admin/corrections. */
export const CorrectionListFilter = {
  service: zId.optional(),
  /** Only corrections overlapping [from, to). */
  from: zTimestamp.optional(),
  to: zTimestamp.optional(),
};

export interface AdminCorrection {
  id: string;
  services: { id: string; name: string }[];
  startsAt: string;
  endsAt: string;
  status: ServiceStatus;
  reason: string;
  showPublic: boolean;
  publicNote: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `filter[from]` and `filter[to]` of GET /api/admin/services/:id/history. */
export const ServiceHistoryQuery = z
  .object({ from: zTimestamp, to: zTimestamp })
  .refine((v) => new Date(v.to) > new Date(v.from), { message: 'to must be after from', path: ['to'] })
  .refine((v) => new Date(v.to).getTime() - new Date(v.from).getTime() <= CORRECTION_MAX_DAYS * DAY_MS, {
    message: `at most ${CORRECTION_MAX_DAYS} days`,
    path: ['to'],
  });
export type ServiceHistoryQuery = z.infer<typeof ServiceHistoryQuery>;

/** Where a history segment comes from. */
export type HistorySegmentSource = 'measured' | 'maintenance' | 'correction';

export interface HistorySegment {
  status: ServiceStatus;
  startedAt: string;
  /** null = still open (only for the measured current segment). */
  endedAt: string | null;
  source: HistorySegmentSource;
  /** Maintenance or correction id for corrected segments. */
  sourceId: string | null;
}

/** Measured vs corrected status history of one service in [from, to) (admin only). */
export interface AdminServiceHistory {
  from: string;
  to: string;
  measured: HistorySegment[];
  corrected: HistorySegment[];
  measuredUptime: number | null;
  correctedUptime: number | null;
  /** Corrections overlapping the range. */
  corrections: AdminCorrection[];
  /** Retroactive maintenance windows overlapping the range. */
  maintenances: { id: string; title: string; start: string; end: string }[];
}

// ---------------------------------------------------------------------------
// Monitoring sources & checks (internal only)
// ---------------------------------------------------------------------------

/** Connection string of a MySQL/MariaDB or PostgreSQL database. */
export const zDatabaseUrl = z
  .string()
  .max(2000)
  .refine((v) => /^(mysql|mariadb|postgres|postgresql):\/\/[^\s]+$/i.test(v) || v === SECRET_MASK, {
    message: 'must be a mysql://, mariadb:// or postgres:// URL',
  });

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
  /**
   * Icinga DB database for history imports (secret), e.g.
   * `mysql://reader:secret@db.example.com:3306/icingadb` or `postgres://...`.
   */
  icingaDbUrl: zDatabaseUrl.nullish(),
});

export const UptimeKumaConfig = zHttpBase.extend({
  /** API key from Uptime Kuma (Settings → API Keys), used for the /metrics endpoint. */
  apiKey: z.string().min(1).max(500),
  /** Uptime Kuma login for history imports (the API key cannot read heartbeats). */
  historyUsername: z.string().max(200).nullish(),
  /** Secret. */
  historyPassword: z.string().max(500).nullish(),
});

export const OpenItCockpitConfig = zHttpBase.extend({
  /** API key from openITCockpit (user profile → API keys). */
  apiKey: z.string().min(1).max(500),
  includeHosts: z.boolean().default(true),
});

export const WebhookConfig = z.object({});

/**
 * Create/update a monitoring source. Only configurable types (not the virtual "bundle" source).
 * The kind of source is `sourceType`: JSON:API reserves `type` for the resource type.
 */
export const MonitorSourceInput = z.discriminatedUnion('sourceType', [
  z.object({ sourceType: z.literal('icinga2'), config: Icinga2Config }),
  z.object({ sourceType: z.literal('uptimekuma'), config: UptimeKumaConfig }),
  z.object({ sourceType: z.literal('openitcockpit'), config: OpenItCockpitConfig }),
  z.object({ sourceType: z.literal('webhook'), config: WebhookConfig }),
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
  sourceType: MonitorSourceType;
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
  /** Type of the source; "bundle" for the checks of check bundles. */
  sourceType: MonitorSourceType;
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

// ---------------------------------------------------------------------------
// History import (internal only)
// ---------------------------------------------------------------------------

/** Longest time range of one history import. */
export const HISTORY_IMPORT_MAX_DAYS = 731;
/** Upper bound for an uploaded CSV file (characters). */
export const HISTORY_CSV_MAX_CHARS = 5 * 1024 * 1024;
/** Upper bound for the data rows of a CSV import. */
export const HISTORY_CSV_MAX_ROWS = 100_000;

export const HISTORY_IMPORT_STATUSES = ['fetching', 'ready', 'applying', 'completed', 'failed', 'cancelled'] as const;
export type HistoryImportStatus = (typeof HISTORY_IMPORT_STATUSES)[number];

/** One-off credentials for an import; never stored beyond the fetch and never returned. */
export const HistoryImportCredentials = z.object({
  /** Uptime Kuma login. */
  username: z.string().min(1).max(200).optional(),
  password: z.string().min(1).max(500).optional(),
  /** Uptime Kuma 2FA code (6 digits) when the account uses two-factor authentication. */
  totp: z
    .string()
    .regex(/^\d{6}$/, 'must be a 6-digit code')
    .optional(),
  /** Icinga DB connection string. */
  databaseUrl: zDatabaseUrl.optional(),
});
export type HistoryImportCredentials = z.infer<typeof HistoryImportCredentials>;

/** POST /api/admin/monitor-sources/:id/history-imports */
export const HistoryImportCreateInput = z
  .object({
    from: zTimestamp,
    to: zTimestamp,
    /** Only checks that feed a service or a check bundle (fewer requests). */
    onlyLinkedChecks: z.boolean().default(true),
    credentials: HistoryImportCredentials.optional(),
    /** CSV content (source type "webhook" or any source when given). */
    csv: z.string().min(1).max(HISTORY_CSV_MAX_CHARS).optional(),
  })
  .refine((v) => Date.parse(v.from) < Date.parse(v.to), { message: '"from" must be before "to"', path: ['to'] })
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) <= HISTORY_IMPORT_MAX_DAYS * 86_400_000, {
    message: `the range must not exceed ${HISTORY_IMPORT_MAX_DAYS} days`,
    path: ['from'],
  });
export type HistoryImportCreateInput = z.infer<typeof HistoryImportCreateInput>;

export interface HistoryImportProgress {
  /** connecting | fetching | planning | writing */
  phase: string;
  done: number;
  total: number;
}

export interface HistoryImportCheckPreview {
  checkId: string;
  name: string;
  host: string | null;
  externalId: string;
  /** Intervals that would be written (inside periods without check history). */
  intervals: number;
  /** Time covered by those intervals in ms. */
  coveredMs: number;
  /** First and last imported instant, null when nothing is written. */
  firstAt: string | null;
  lastAt: string | null;
  /** Time per state in ms (written intervals only). */
  stateMs: Partial<Record<CheckState, number>>;
}

export interface HistoryImportSegment {
  status: ServiceStatus;
  startedAt: string;
  endedAt: string;
}

export interface HistoryImportServicePreview {
  serviceId: string;
  name: string;
  /** "manual": status mode is manual, nothing is rebuilt. "no_data": no usable check history in the gaps. */
  skipped: 'manual' | 'no_data' | null;
  /** Time in the range without recorded (live) history, in ms. */
  gapMs: number;
  /** Time that gets a status from the import, in ms. */
  filledMs: number;
  /** Time counted as down (partial or major outage) in the filled periods, in ms. */
  downMs: number;
  /** Uptime over the whole range after the import (recorded + imported), null without data. */
  uptime: number | null;
  /** Uptime over the range before the import, null without data. */
  uptimeBefore: number | null;
  segmentCount: number;
  /** The first segments (up to 100) for display. */
  segments: HistoryImportSegment[];
}

/** Non-fatal note of a fetch; `message` is the English fallback for unknown codes. */
export interface HistoryImportWarning {
  /**
   * kuma_retention {earliest} | kuma_duplicate_name {name} |
   * kuma_monitor_failed {name, reason} | oitc_utc
   */
  code: string;
  params: Record<string, string | number>;
  message: string;
}

/**
 * Why a job failed or was cancelled by the server:
 * source (the monitoring system or the file; see `error`), timeout, shutdown,
 * interrupted, expired, apply_failed (see `error`).
 */
export type HistoryImportErrorCode = 'source' | 'timeout' | 'shutdown' | 'interrupted' | 'expired' | 'apply_failed';

/** A problem in an uploaded CSV file (400 response `issues`). */
export interface HistoryCsvIssue {
  line: number;
  /**
   * unterminated_quote | empty | missing_columns {columns} | no_rows | too_many_rows {max} |
   * field_count {expected, found} | check_xor_service | id_too_long | timestamp_format |
   * invalid_date | start_not_before_end | check_state {allowed} | service_status {allowed} |
   * overlap {other, kind}
   */
  code: string;
  params: Record<string, string | number>;
  /** English fallback. */
  message: string;
}

export interface HistoryImportPreview {
  from: string;
  to: string;
  checks: HistoryImportCheckPreview[];
  services: HistoryImportServicePreview[];
  /** External ids returned by the source that match no check of this source (first 50). */
  unmatched: string[];
  unmatchedCount: number;
  /** Local checks that were requested but returned no history. */
  checksWithoutData: number;
  warnings: HistoryImportWarning[];
}

export interface HistoryImportResult {
  checkIntervals: number;
  serviceSegments: number;
  services: number;
}

/** GET /api/admin/monitor-sources/:id/history-imports[/:importId] (type "history-imports", relationship `source`) */
export interface AdminHistoryImport {
  id: string;
  sourceId: string;
  status: HistoryImportStatus;
  from: string;
  to: string;
  onlyLinkedChecks: boolean;
  progress: HistoryImportProgress | null;
  preview: HistoryImportPreview | null;
  result: HistoryImportResult | null;
  /** English message (detail for "source" and "apply_failed"). */
  error: string | null;
  errorCode: HistoryImportErrorCode | null;
  /** JSON:API: the relationship `createdBy` (type "users", included with its name). */
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Check bundles: weighted voting over checks of several sources (internal only)
// ---------------------------------------------------------------------------

/** Upper bound for the votes of one bundle member. */
export const MAX_BUNDLE_MEMBER_VOTES = 1000;
/** Upper bound for the members of one bundle. */
export const MAX_BUNDLE_MEMBERS = 100;

export const CheckBundleMemberInput = z.object({
  checkId: zId,
  /** Weight of this member in the vote (integer >= 1). */
  votes: z.number().int().min(1).max(MAX_BUNDLE_MEMBER_VOTES).default(1),
});
export type CheckBundleMemberInput = z.infer<typeof CheckBundleMemberInput>;

export const CheckBundleInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullish(),
  members: z
    .array(CheckBundleMemberInput)
    .max(MAX_BUNDLE_MEMBERS)
    .default([])
    .refine((list) => new Set(list.map((m) => m.checkId)).size === list.length, {
      message: 'each check may only be added once',
    }),
});
export type CheckBundleInput = z.infer<typeof CheckBundleInput>;

/**
 * Why a member counts (`reporting`) or does not count in the vote.
 * - source_disabled: its monitoring source is disabled
 * - poll_failed: the last poll of its (pull) source failed
 * - state_unknown: the check reports "unknown"
 * - never_checked: no result received yet
 * - stale: the last result is too old (see docs/adapters/README.md)
 */
export const BUNDLE_MEMBER_REASONS = [
  'reporting',
  'source_disabled',
  'poll_failed',
  'state_unknown',
  'never_checked',
  'stale',
] as const;
export type BundleMemberReason = (typeof BUNDLE_MEMBER_REASONS)[number];

/** Result of the weighted vote of a bundle. */
export interface BundleVoteSummary {
  /** ok | warning | critical, or unknown when no member reports. */
  state: CheckState;
  /** Votes of all members. */
  totalVotes: number;
  /** Votes of the members that report; the base for the majority. */
  reportingVotes: number;
  criticalVotes: number;
  warningVotes: number;
  okVotes: number;
}

export interface AdminCheckBundleMember {
  checkId: string;
  votes: number;
  checkName: string;
  host: string | null;
  sourceId: string;
  sourceName: string;
  sourceType: MonitorSourceType;
  state: CheckState;
  lastCheckAt: string | null;
  reporting: boolean;
  reason: BundleMemberReason;
}

export interface AdminCheckBundle {
  id: string;
  name: string;
  description: string | null;
  /** The bundle's own check (source type "bundle"); link it to services like any check. */
  checkId: string;
  /** Live result, evaluated when the response was built. */
  vote: BundleVoteSummary;
  members: AdminCheckBundleMember[];
  /** Number of services the bundle check feeds into. */
  serviceCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Checks that can become bundle members, grouped by source. */
export interface BundleCandidateSource {
  id: string;
  name: string;
  sourceType: MonitorSourceType;
  enabled: boolean;
  checks: {
    id: string;
    name: string;
    host: string | null;
    state: CheckState;
    lastCheckAt: string | null;
  }[];
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

/**
 * History view state of the web client. The API takes it as `page[number]`, `page[size]`,
 * `filter[type]`, `filter[service]`, `filter[location]` and `filter[month]`.
 */
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

/** Subscriber list state of the admin UI; sent as page[number], page[size], filter[q] and filter[status]. */
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

/**
 * Error of a failed request as the web client exposes it (`ApiError.body`), built from
 * the JSON:API error document: code and detail of the first error, field issues.
 */
export interface ApiError {
  error: string;
  message: string;
  /** Zod issues for 400 responses. */
  issues?: unknown;
}

