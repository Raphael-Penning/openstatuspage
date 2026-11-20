/**
 * JSON:API resource objects of the auth, user, settings, overview and
 * subscription routes. Inputs are the explicitly serialized plain objects
 * (AdminUser, AdminApiToken, PublicSubscription, ...).
 */
import type {
  AdminApiToken,
  AdminPageSettings,
  AdminService,
  AdminSubscriber,
  AdminUser,
  AuditLogEntry,
  AuthConfig,
  NotificationStatus,
  PublicPageSettings,
  PublicSubscription,
  ResourceObject,
} from '@openstatuspage/shared';
import { Included, resource, toMany, toOne } from '../lib/jsonapi.js';
import { adminServiceResource } from './catalog.js';

export const AUTH_TYPES = {
  authConfig: 'auth-configs',
  session: 'sessions',
  user: 'users',
  apiToken: 'api-tokens',
  settings: 'settings',
  auditEntry: 'audit-entries',
  overview: 'overviews',
  service: 'services',
  subscriber: 'subscribers',
  subscription: 'subscriptions',
  notificationStatus: 'notification-statuses',
} as const;

/** Id of singleton resources that describe "the current one" (session, overview, ...). */
export const CURRENT_ID = 'current';
/** Singleton id of the site settings (same as the public settings resource). */
export const SITE_SETTINGS_ID = 'site';

export function authConfigResource(config: AuthConfig): ResourceObject {
  return resource(AUTH_TYPES.authConfig, CURRENT_ID, config, { links: { self: '/api/auth/config' } });
}

export function userResource(user: AdminUser): ResourceObject {
  return resource(AUTH_TYPES.user, user.id, user, { links: { self: `/api/admin/users/${user.id}` } });
}

/** The signed-in session; the user goes to `included`. */
export function sessionResource(info: { user: AdminUser; oidcEnabled: boolean }, included: Included): ResourceObject {
  included.add(userResource(info.user));
  return resource(
    AUTH_TYPES.session,
    CURRENT_ID,
    { oidcEnabled: info.oidcEnabled },
    { relationships: { user: toOne(AUTH_TYPES.user, info.user.id) }, links: { self: '/api/auth/session' } },
  );
}

/** API token; `token` is only part of the create response. */
export function apiTokenResource(token: AdminApiToken): ResourceObject {
  return resource(AUTH_TYPES.apiToken, token.id, token, { links: { self: `/api/admin/api-tokens/${token.id}` } });
}

/** The page settings for the management UI, plus `analyticsAvailable` (whether this instance has UMAMI_URL). */
export function adminSettingsResource(settings: PublicPageSettings, instance: { analyticsAvailable: boolean }): ResourceObject {
  const attributes: AdminPageSettings = { ...settings, analyticsAvailable: instance.analyticsAvailable };
  return resource(AUTH_TYPES.settings, SITE_SETTINGS_ID, attributes, { links: { self: '/api/admin/settings' } });
}

/** Audit entry; the acting user is a relationship (`userName` stays: users may be deleted). */
export function auditEntryResource(entry: AuditLogEntry): ResourceObject {
  const { userId, ...attributes } = entry;
  return resource(AUTH_TYPES.auditEntry, entry.id, attributes, {
    relationships: { user: toOne(AUTH_TYPES.user, userId) },
  });
}

export interface OverviewData {
  counts: Record<string, number>;
  services: AdminService[];
  recentAudit: AuditLogEntry[];
}

/** Dashboard overview: counts as attributes, services and recent audit entries included. */
export function overviewResource(overview: OverviewData, included: Included): ResourceObject {
  included.add(...overview.services.map(adminServiceResource), ...overview.recentAudit.map(auditEntryResource));
  return resource(
    AUTH_TYPES.overview,
    CURRENT_ID,
    { counts: overview.counts },
    {
      relationships: {
        services: toMany(AUTH_TYPES.service, overview.services.map((s) => s.id)),
        recentAudit: toMany(AUTH_TYPES.auditEntry, overview.recentAudit.map((e) => e.id)),
      },
      links: { self: '/api/admin/overview' },
    },
  );
}

/** Admin subscriber; the selected services (id + name) go to `included`. */
export function subscriberResource(subscriber: AdminSubscriber, included: Included): ResourceObject {
  const { services, ...attributes } = subscriber;
  included.add(...services.map((s) => resource(AUTH_TYPES.service, s.id, { name: s.name })));
  return resource(AUTH_TYPES.subscriber, subscriber.id, attributes, {
    relationships: { services: toMany(AUTH_TYPES.service, services.map((s) => s.id)) },
  });
}

export function notificationStatusResource(status: NotificationStatus): ResourceObject {
  return resource(AUTH_TYPES.notificationStatus, CURRENT_ID, status, { links: { self: '/api/admin/notifications/status' } });
}

/**
 * Public subscription (manage API). `manageToken` is only part of the confirm
 * response; it is the token for the following manage requests.
 */
export function subscriptionResource(subscription: PublicSubscription, extra: { manageToken?: string } = {}): ResourceObject {
  const { serviceIds, ...attributes } = subscription;
  return resource(
    AUTH_TYPES.subscription,
    subscription.id,
    { ...attributes, ...extra },
    {
      relationships: { services: toMany(AUTH_TYPES.service, serviceIds) },
      links: { self: `/api/public/subscriptions/${subscription.id}` },
    },
  );
}
