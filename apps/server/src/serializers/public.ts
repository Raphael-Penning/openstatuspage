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
  PublicPrivatePage,
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
  privatePage: 'private-pages',
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

/** Base path of the private page API (the token travels in a header, never in the URL). */
export const PRIVATE_PAGE_API = `${BASE}/private-page`;

/** A service of a private page: like a public service, with its link below the private page API. */
export function privateServiceResource(service: PublicService, extra: Record<string, RelationshipObject> = {}): ResourceObject {
  return {
    ...serviceResource(service, extra),
    links: { self: `${PRIVATE_PAGE_API}/services/${encodeURIComponent(service.slug || service.id)}` },
  };
}

/**
 * A private page as its visitors see it (`private-pages`). Services, incidents
 * and maintenance windows are relationships; their resources (and the updates)
 * go to `included`.
 */
export function privatePageResource(page: PublicPrivatePage, included: Included): ResourceObject {
  const { services, activeIncidents, activeMaintenances, upcomingMaintenances, ...attributes } = page;
  included.add(...services.map((s) => privateServiceResource(s)));
  for (const i of activeIncidents) included.add(incidentResource(i, included));
  for (const m of [...activeMaintenances, ...upcomingMaintenances]) included.add(maintenanceResource(m, included));
  const ids = (list: { id: string }[]) => list.map((x) => x.id);
  return resource(PUBLIC_TYPES.privatePage, page.id, attributes, {
    relationships: {
      services: toMany(PUBLIC_TYPES.service, ids(services)),
      activeIncidents: toMany(PUBLIC_TYPES.incident, ids(activeIncidents)),
      activeMaintenances: toMany(PUBLIC_TYPES.maintenance, ids(activeMaintenances)),
      upcomingMaintenances: toMany(PUBLIC_TYPES.maintenance, ids(upcomingMaintenances)),
    },
    links: { self: PRIVATE_PAGE_API },
  });
}
