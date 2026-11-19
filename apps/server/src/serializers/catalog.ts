/**
 * JSON:API resource objects of the admin catalog API: services, service groups,
 * locations, incidents (+ updates), maintenances (+ updates), corrections and the
 * measured/corrected history of a service.
 *
 * Foreign keys are relationships (named so that the client's relationshipKey()
 * gives back the plain field: `group` ↔ groupId, `locations` ↔ locationIds,
 * `services` ↔ serviceIds). Value objects (check links, affected services with
 * their impact, history segments) stay attributes.
 */
import type {
  AdminCorrection,
  AdminIncident,
  AdminLocation,
  AdminMaintenance,
  AdminService,
  AdminServiceGroup,
  AdminServiceHistory,
  IncidentUpdateEntry,
  MaintenanceUpdateEntry,
  ResourceObject,
} from '@openstatuspage/shared';
import { Included, resource, toMany, toOne } from '../lib/jsonapi.js';

const BASE = '/api/admin';

export const CATALOG_TYPES = {
  service: 'services',
  group: 'service-groups',
  location: 'locations',
  incident: 'incidents',
  incidentUpdate: 'incident-updates',
  maintenance: 'maintenances',
  maintenanceUpdate: 'maintenance-updates',
  correction: 'corrections',
  serviceHistory: 'service-histories',
  /** Request documents of the reorder actions (`attributes.ids` in display order). */
  ordering: 'orderings',
} as const;

export function adminServiceResource(service: AdminService): ResourceObject {
  const { groupId, locationIds, ...attributes } = service;
  return resource(CATALOG_TYPES.service, service.id, attributes, {
    relationships: {
      group: toOne(CATALOG_TYPES.group, groupId),
      locations: toMany(CATALOG_TYPES.location, locationIds),
    },
    links: { self: `${BASE}/services/${service.id}` },
  });
}

export function adminGroupResource(group: AdminServiceGroup): ResourceObject {
  return resource(CATALOG_TYPES.group, group.id, group, { links: { self: `${BASE}/service-groups/${group.id}` } });
}

export function adminLocationResource(location: AdminLocation): ResourceObject {
  const { serviceIds, ...attributes } = location;
  return resource(CATALOG_TYPES.location, location.id, attributes, {
    relationships: { services: toMany(CATALOG_TYPES.service, serviceIds) },
    links: { self: `${BASE}/locations/${location.id}` },
  });
}

export function incidentUpdateResource(incidentId: string, update: IncidentUpdateEntry): ResourceObject {
  return resource(CATALOG_TYPES.incidentUpdate, update.id, update, {
    relationships: { incident: toOne(CATALOG_TYPES.incident, incidentId) },
    links: { self: `${BASE}/incidents/${incidentId}/updates/${update.id}` },
  });
}

/**
 * Incident resource. `affectedServices` stays an attribute (impact per service);
 * with `included` the updates are added to the compound document.
 */
export function adminIncidentResource(incident: AdminIncident, included?: Included): ResourceObject {
  const { locationIds, updates, ...attributes } = incident;
  included?.add(...updates.map((u) => incidentUpdateResource(incident.id, u)));
  return resource(CATALOG_TYPES.incident, incident.id, attributes, {
    relationships: {
      locations: toMany(CATALOG_TYPES.location, locationIds),
      updates: toMany(CATALOG_TYPES.incidentUpdate, updates.map((u) => u.id)),
    },
    links: { self: `${BASE}/incidents/${incident.id}` },
  });
}

export function maintenanceUpdateResource(maintenanceId: string, update: MaintenanceUpdateEntry): ResourceObject {
  return resource(CATALOG_TYPES.maintenanceUpdate, update.id, update, {
    relationships: { maintenance: toOne(CATALOG_TYPES.maintenance, maintenanceId) },
    links: { self: `${BASE}/maintenances/${maintenanceId}/updates/${update.id}` },
  });
}

/** Maintenance resource, see {@link adminIncidentResource}. */
export function adminMaintenanceResource(maintenance: AdminMaintenance, included?: Included): ResourceObject {
  const { locationIds, updates, ...attributes } = maintenance;
  included?.add(...updates.map((u) => maintenanceUpdateResource(maintenance.id, u)));
  return resource(CATALOG_TYPES.maintenance, maintenance.id, attributes, {
    relationships: {
      services: toMany(CATALOG_TYPES.service, maintenance.affectedServices.map((s) => s.id)),
      locations: toMany(CATALOG_TYPES.location, locationIds),
      updates: toMany(CATALOG_TYPES.maintenanceUpdate, updates.map((u) => u.id)),
    },
    links: { self: `${BASE}/maintenances/${maintenance.id}` },
  });
}

/**
 * Correction resource. Its services are a relationship; with `included` they are
 * added as sparse `services` resources (name only).
 */
export function correctionResource(correction: AdminCorrection, included?: Included): ResourceObject {
  const { services, ...attributes } = correction;
  included?.add(...services.map((s) => resource(CATALOG_TYPES.service, s.id, { name: s.name })));
  return resource(CATALOG_TYPES.correction, correction.id, attributes, {
    relationships: { services: toMany(CATALOG_TYPES.service, services.map((s) => s.id)) },
    links: { self: `${BASE}/corrections/${correction.id}` },
  });
}

/**
 * Measured vs corrected history of one service (id = service id). The overlapping
 * corrections (and their services) are always included.
 */
export function serviceHistoryResource(serviceId: string, history: AdminServiceHistory, included: Included): ResourceObject {
  const { corrections, ...attributes } = history;
  included.add(...corrections.map((c) => correctionResource(c, included)));
  return resource(CATALOG_TYPES.serviceHistory, serviceId, attributes, {
    relationships: {
      service: toOne(CATALOG_TYPES.service, serviceId),
      corrections: toMany(CATALOG_TYPES.correction, corrections.map((c) => c.id)),
    },
  });
}
