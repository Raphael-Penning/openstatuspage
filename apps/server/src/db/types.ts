/**
 * Kysely table types.
 *
 * Portability rules (SQLite and PostgreSQL share one schema):
 * - IDs are text (generated in the app, see lib/ids.ts).
 * - Timestamps are ISO-8601 UTC strings (text), so lexical order = chronological order.
 * - Booleans are integers 0/1.
 * - JSON is stored as text.
 */
import type { Generated, Insertable, Selectable, Updateable } from 'kysely';
import type {
  AggregationMode,
  CheckState,
  ImpactStatus,
  IncidentImpact,
  IncidentStatus,
  MaintenanceStatus,
  MonitorSourceType,
  Region,
  ServiceKind,
  ServiceStatus,
  StatusMode,
  SubscriptionLocale,
  UserRole,
} from '@openstatuspage/shared';

type Bool = number; // 0 | 1

export interface SettingsTable {
  key: string;
  /** JSON encoded value. */
  value: string;
  updated_at: string;
}

export interface UsersTable {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  password_hash: string | null;
  oidc_subject: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface SessionsTable {
  /** SHA-256 of the session token. The token itself lives only in the cookie. */
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
}

export interface ApiTokensTable {
  id: string;
  name: string;
  role: UserRole;
  /** SHA-256 of the token. */
  token_hash: string;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface LocationsTable {
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
  sort_order: number;
  is_public: Bool;
  status_override: ServiceStatus | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceGroupsTable {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number;
  is_public: Bool;
  collapsed_by_default: Bool;
  created_at: string;
  updated_at: string;
}

export interface ServicesTable {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: ServiceKind;
  url: string | null;
  group_id: string | null;
  sort_order: number;
  is_public: Bool;
  status_mode: StatusMode;
  manual_status: ServiceStatus;
  aggregation: AggregationMode;
  /** Cached effective status, maintained by the status engine. */
  current_status: ServiceStatus;
  /** Cached status derived from checks only. */
  monitor_status: ServiceStatus;
  status_changed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceLocationsTable {
  service_id: string;
  location_id: string;
}

export interface ServiceChecksTable {
  service_id: string;
  check_id: string;
  warning_status: ImpactStatus | null;
  critical_status: ImpactStatus | null;
  unknown_status: ImpactStatus | null;
}

/** Closed/open status segments per service, used for uptime bars. */
export interface ServiceStatusHistoryTable {
  id: string;
  service_id: string;
  status: ServiceStatus;
  started_at: string;
  /** null = current segment. */
  ended_at: string | null;
}

export interface MonitorSourcesTable {
  id: string;
  name: string;
  type: MonitorSourceType;
  enabled: Bool;
  /** AES-256-GCM encrypted JSON (see lib/crypto.ts). */
  config_encrypted: string;
  poll_interval_seconds: number;
  /** SHA-256 of the push token. */
  ingest_token_hash: string;
  last_poll_at: string | null;
  last_poll_ok: Bool | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface MonitorChecksTable {
  id: string;
  source_id: string;
  /** Stable ID within the source (e.g. `host!service` for Icinga). */
  external_id: string;
  name: string;
  host: string | null;
  state: CheckState;
  output: string | null;
  last_check_at: string | null;
  last_state_change_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IncidentsTable {
  id: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  is_public: Bool;
  source: 'manual' | 'auto';
  started_at: string;
  resolved_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface IncidentUpdatesTable {
  id: string;
  incident_id: string;
  status: IncidentStatus;
  message: string;
  created_by: string | null;
  created_at: string;
}

export interface IncidentServicesTable {
  incident_id: string;
  service_id: string;
  status: ImpactStatus;
}

export interface IncidentLocationsTable {
  incident_id: string;
  location_id: string;
}

export interface MaintenancesTable {
  id: string;
  title: string;
  description: string;
  status: MaintenanceStatus;
  scheduled_start: string;
  scheduled_end: string;
  actual_start: string | null;
  actual_end: string | null;
  auto_start: Bool;
  auto_complete: Bool;
  is_public: Bool;
  /** Email subscribers about this maintenance (announcement, reminder, automatic transitions). */
  notify_subscribers: Bool;
  /** When the reminder mail was queued; reset when the window moves later. */
  reminder_sent_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface MaintenanceUpdatesTable {
  id: string;
  maintenance_id: string;
  status: MaintenanceStatus;
  message: string;
  created_by: string | null;
  created_at: string;
}

export interface MaintenanceServicesTable {
  maintenance_id: string;
  service_id: string;
}

export interface MaintenanceLocationsTable {
  maintenance_id: string;
  location_id: string;
}

export interface AuditLogTable {
  id: string;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  /** JSON. */
  details: string | null;
  created_at: string;
}

export interface SubscribersTable {
  id: string;
  /** Lowercase, unique. */
  email: string;
  locale: SubscriptionLocale;
  all_services: Bool;
  /** Random salt for the HMAC-derived confirm/manage tokens (tokens are never stored). */
  token_salt: string;
  /** null = pending (double opt-in not completed). */
  confirmed_at: string | null;
  /** Last confirmation or "manage" mail, for throttling. */
  confirmation_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriberServicesTable {
  subscriber_id: string;
  service_id: string;
}

export type OutboxStatus = 'pending' | 'sent' | 'failed';

export interface EmailOutboxTable {
  id: string;
  /** null for mails not tied to a subscriber. */
  subscriber_id: string | null;
  recipient: string;
  /** e.g. `confirm`, `manage`, `incident`, `maintenance`, `maintenance_reminder`. */
  kind: string;
  subject: string;
  text_body: string;
  html_body: string;
  /** JSON object of additional headers. */
  headers: string | null;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  last_attempt_at: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface Database {
  settings: SettingsTable;
  users: UsersTable;
  sessions: SessionsTable;
  api_tokens: ApiTokensTable;
  locations: LocationsTable;
  service_groups: ServiceGroupsTable;
  services: ServicesTable;
  service_locations: ServiceLocationsTable;
  service_checks: ServiceChecksTable;
  service_status_history: ServiceStatusHistoryTable;
  monitor_sources: MonitorSourcesTable;
  monitor_checks: MonitorChecksTable;
  incidents: IncidentsTable;
  incident_updates: IncidentUpdatesTable;
  incident_services: IncidentServicesTable;
  incident_locations: IncidentLocationsTable;
  maintenances: MaintenancesTable;
  maintenance_updates: MaintenanceUpdatesTable;
  maintenance_services: MaintenanceServicesTable;
  maintenance_locations: MaintenanceLocationsTable;
  audit_log: AuditLogTable;
  subscribers: SubscribersTable;
  subscriber_services: SubscriberServicesTable;
  email_outbox: EmailOutboxTable;
}

export type User = Selectable<UsersTable>;
export type Service = Selectable<ServicesTable>;
export type Location = Selectable<LocationsTable>;
export type ServiceGroup = Selectable<ServiceGroupsTable>;
export type MonitorSource = Selectable<MonitorSourcesTable>;
export type MonitorCheck = Selectable<MonitorChecksTable>;
export type Incident = Selectable<IncidentsTable>;
export type Maintenance = Selectable<MaintenancesTable>;
export type Subscriber = Selectable<SubscribersTable>;
export type OutboxRow = Selectable<EmailOutboxTable>;
export type NewService = Insertable<ServicesTable>;
export type ServiceUpdate = Updateable<ServicesTable>;

// Generated is re-exported for future auto-increment columns.
export type { Generated };
