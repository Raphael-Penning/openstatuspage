/**
 * JSON:API resource objects of the public API (/api/public/*). Input are the
 * explicitly serialized public objects (PublicService, PublicIncident, ...), so
 * nothing beyond what they already expose can end up in a response.
 */
import type {
  IncidentUpdateEntry,
  MaintenanceUpdateEntry,
  PublicIncident,
  PublicLocation,
  PublicMaintenance,
  PublicPageSettings,
  PublicService,
  PublicServiceDay,
  PublicServiceGroup,
  RelationshipObject,
  ResourceObject,
} from '@openstatuspage/shared';
import { Included, resource, toMany, toOne } from '../lib/jsonapi.js';

const BASE = '/api/public';

export const PUBLIC_TYPES = {
  settings: 'settings',
  summary: 'summaries',
  status: 'statuses',
  service: 'services',
  group: 'service-groups',
  location: 'locations',
  incident: 'incidents',
  incidentUpdate: 'incident-updates',
  maintenance: 'maintenances',
  maintenanceUpdate: 'maintenance-updates',
  serviceDay: 'service-days',
} as const;

/** Singleton id of the site settings resource. */
export const SETTINGS_ID = 'site';

export function settingsResource(settings: PublicPageSettings): ResourceObject {
  return resource(PUBLIC_TYPES.settings, SETTINGS_ID, settings, { links: { self: `${BASE}/settings` } });
}

export function serviceResource(service: PublicService, extra: Record<string, RelationshipObject> = {}): ResourceObject {
  const { groupId, locationIds, ...attributes } = service;
  return resource(PUBLIC_TYPES.service, service.id, attributes, {
    relationships: {
      group: toOne(PUBLIC_TYPES.group, groupId),
      locations: toMany(PUBLIC_TYPES.location, locationIds),
      ...extra,
    },
    links: { self: `${BASE}/services/${encodeURIComponent(service.slug || service.id)}` },
  });
}

/** Group resource; its services go to `included`. */
export function groupResource(group: PublicServiceGroup, included: Included): ResourceObject {
  const { services, ...attributes } = group;
  included.add(...services.map((s) => serviceResource(s)));
  return resource(PUBLIC_TYPES.group, group.id, attributes, {
    relationships: { services: toMany(PUBLIC_TYPES.service, services.map((s) => s.id)) },
  });
}

export function locationResource(location: PublicLocation): ResourceObject {
  const { serviceIds, ...attributes } = location;
  return resource(PUBLIC_TYPES.location, location.id, attributes, {
    relationships: { services: toMany(PUBLIC_TYPES.service, serviceIds) },
  });
}

function updateResource(type: string, update: IncidentUpdateEntry | MaintenanceUpdateEntry): ResourceObject {
  return resource(type, update.id, update);
}

/**
 * Incident resource. `affectedServices` stays an attribute (value objects with
 * the impact per service). With `includeUpdates` the updates go to `included`.
 */
export function incidentResource(incident: PublicIncident, included?: Included): ResourceObject {
  const { locationIds, updates, ...attributes } = incident;
  included?.add(...updates.map((u) => updateResource(PUBLIC_TYPES.incidentUpdate, u)));
  return resource(PUBLIC_TYPES.incident, incident.id, attributes, {
    relationships: {
      locations: toMany(PUBLIC_TYPES.location, locationIds),
      updates: toMany(PUBLIC_TYPES.incidentUpdate, updates.map((u) => u.id)),
    },
    links: { self: `${BASE}/incidents/${incident.id}` },
  });
}

/** Maintenance resource, see {@link incidentResource}. */
export function maintenanceResource(maintenance: PublicMaintenance, included?: Included): ResourceObject {
  const { locationIds, updates, ...attributes } = maintenance;
  included?.add(...updates.map((u) => updateResource(PUBLIC_TYPES.maintenanceUpdate, u)));
  return resource(PUBLIC_TYPES.maintenance, maintenance.id, attributes, {
    relationships: {
      locations: toMany(PUBLIC_TYPES.location, locationIds),
      updates: toMany(PUBLIC_TYPES.maintenanceUpdate, updates.map((u) => u.id)),
    },
    links: { self: `${BASE}/maintenances/${maintenance.id}` },
  });
}

/**
 * One day of a service (`service-days`): the bucket of the uptime bar with the
 * status periods of the day. The service, incidents and maintenance windows
 * are relationships (their resources go to `included` by the caller).
 */
export function serviceDayResource(
  day: PublicServiceDay,
  service: Pick<PublicService, 'id' | 'slug'>,
  incidentIds: string[],
  maintenanceIds: string[],
): ResourceObject {
  const { id, ...attributes } = day;
  return resource(PUBLIC_TYPES.serviceDay, id, attributes, {
    relationships: {
      service: toOne(PUBLIC_TYPES.service, service.id),
      incidents: toMany(PUBLIC_TYPES.incident, incidentIds),
      maintenances: toMany(PUBLIC_TYPES.maintenance, maintenanceIds),
    },
    links: { self: `${BASE}/services/${encodeURIComponent(service.slug || service.id)}/days/${day.date}` },
  });
}
