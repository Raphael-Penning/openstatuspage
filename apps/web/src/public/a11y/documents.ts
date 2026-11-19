/**
 * JSON:API documents of the public API for the fake API of the a11y tests,
 * built from the plain fixtures like the server's serializers/public.ts does.
 */
import type {
  DataDocument,
  HistoryItem,
  Paginated,
  PublicIncident,
  PublicLocation,
  PublicMaintenance,
  PublicPageSettings,
  PublicService,
  PublicServiceGroup,
  PublicSubscription,
  PublicSummary,
  RelationshipObject,
  ResourceObject,
  ServiceStatus,
} from '@openstatuspage/shared';

type Included = Map<string, ResourceObject>;

const ids = (type: string, list: { id: string }[]): RelationshipObject => ({
  data: list.map((x) => ({ type, id: x.id })),
});
const idList = (type: string, list: string[]): RelationshipObject => ({ data: list.map((id) => ({ type, id })) });

function add(included: Included, ...resources: ResourceObject[]) {
  for (const r of resources) included.set(`${r.type}:${r.id}`, r);
}

function doc(data: ResourceObject | ResourceObject[], included: Included = new Map(), meta?: Record<string, unknown>): DataDocument {
  return { jsonapi: { version: '1.1' }, data, included: [...included.values()], ...(meta ? { meta } : {}) };
}

const settingsResource = (s: PublicPageSettings): ResourceObject => ({ type: 'settings', id: 'site', attributes: { ...s } });

function serviceResource(s: PublicService, extra: Record<string, RelationshipObject> = {}): ResourceObject {
  const { id, groupId, locationIds, ...attributes } = s;
  return {
    type: 'services',
    id,
    attributes,
    relationships: {
      group: { data: groupId ? { type: 'service-groups', id: groupId } : null },
      locations: idList('locations', locationIds),
      ...extra,
    },
  };
}

function groupResource(g: PublicServiceGroup, included?: Included): ResourceObject {
  const { id, services, ...attributes } = g;
  if (included) add(included, ...services.map((s) => serviceResource(s)));
  return { type: 'service-groups', id, attributes, relationships: { services: ids('services', services) } };
}

function incidentResource(i: PublicIncident, included: Included): ResourceObject {
  const { id, locationIds, updates, ...attributes } = i;
  add(included, ...updates.map(({ id: uid, ...u }) => ({ type: 'incident-updates', id: uid, attributes: u })));
  return {
    type: 'incidents',
    id,
    attributes,
    relationships: { locations: idList('locations', locationIds), updates: ids('incident-updates', updates) },
  };
}

function maintenanceResource(m: PublicMaintenance, included: Included): ResourceObject {
  const { id, locationIds, updates, ...attributes } = m;
  add(included, ...updates.map(({ id: uid, ...u }) => ({ type: 'maintenance-updates', id: uid, attributes: u })));
  return {
    type: 'maintenances',
    id,
    attributes,
    relationships: { locations: idList('locations', locationIds), updates: ids('maintenance-updates', updates) },
  };
}

export const settingsDocument = (s: PublicPageSettings) => doc(settingsResource(s));

export function summaryDocument(s: PublicSummary): DataDocument {
  const included: Included = new Map();
  add(included, settingsResource(s.page));
  add(included, ...s.groups.map((g) => groupResource(g, included)));
  add(included, ...s.ungrouped.map((x) => serviceResource(x)));
  for (const i of [...s.activeIncidents, ...s.recentIncidents]) add(included, incidentResource(i, included));
  for (const m of [...s.activeMaintenances, ...s.upcomingMaintenances]) add(included, maintenanceResource(m, included));
  const data: ResourceObject = {
    type: 'summaries',
    id: 'current',
    attributes: { overall: s.overall, emailSubscriptions: s.emailSubscriptions, generatedAt: s.generatedAt },
    relationships: {
      page: { data: { type: 'settings', id: 'site' } },
      groups: ids('service-groups', s.groups),
      ungrouped: ids('services', s.ungrouped),
      activeIncidents: ids('incidents', s.activeIncidents),
      recentIncidents: ids('incidents', s.recentIncidents),
      activeMaintenances: ids('maintenances', s.activeMaintenances),
      upcomingMaintenances: ids('maintenances', s.upcomingMaintenances),
    },
  };
  return doc(data, included);
}

export function servicesDocument(
  groups: PublicServiceGroup[],
  ungrouped: PublicService[],
  counts: Record<ServiceStatus, number>,
): DataDocument {
  const services = [...groups.flatMap((g) => g.services), ...ungrouped];
  const included: Included = new Map();
  add(included, ...groups.map((g) => groupResource(g)));
  return doc(services.map((s) => serviceResource(s)), included, { total: services.length, counts });
}

export function serviceDocument(
  service: PublicService,
  incidents: PublicIncident[],
  maintenances: PublicMaintenance[],
): DataDocument {
  const included: Included = new Map();
  for (const i of incidents) add(included, incidentResource(i, included));
  for (const m of maintenances) add(included, maintenanceResource(m, included));
  const data = serviceResource(service, { incidents: ids('incidents', incidents), maintenances: ids('maintenances', maintenances) });
  return doc(data, included);
}

export function locationsDocument(locations: PublicLocation[], counts: Record<ServiceStatus, number>): DataDocument {
  const data = locations.map(({ id, serviceIds, ...attributes }) => ({
    type: 'locations',
    id,
    attributes,
    relationships: { services: idList('services', serviceIds) },
  }));
  return doc(data, new Map(), { total: locations.length, counts });
}

export function incidentDocument(i: PublicIncident): DataDocument {
  const included: Included = new Map();
  return doc(incidentResource(i, included), included);
}

export function maintenanceDocument(m: PublicMaintenance): DataDocument {
  const included: Included = new Map();
  return doc(maintenanceResource(m, included), included);
}

export function historyDocument(history: Paginated<HistoryItem>): DataDocument {
  const included: Included = new Map();
  const data = history.items.map((item) =>
    item.type === 'incident' ? incidentResource(item.incident, included) : maintenanceResource(item.maintenance, included),
  );
  return doc(data, included, { total: history.total, page: { number: history.page, size: history.pageSize } });
}

/** `subscriptions` resource; `manageToken` only in the confirm response (like the server). */
export function subscriptionDocument(sub: PublicSubscription, manageToken?: string): DataDocument {
  const { id, serviceIds, ...attributes } = sub;
  return doc({
    type: 'subscriptions',
    id,
    attributes: { ...attributes, ...(manageToken ? { manageToken } : {}) },
    relationships: { services: idList('services', serviceIds) },
  });
}

/** Answer of POST /api/public/subscriptions (always the same meta-only document). */
export const subscribeAcceptedDocument = { jsonapi: { version: '1.1' }, meta: { accepted: true } };
