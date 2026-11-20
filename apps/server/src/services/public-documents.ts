/**
 * The JSON:API documents of /api/public (everything but the feeds and the
 * subscription API), built without a request round trip. The routes in
 * routes/public.ts send them; server-side rendering of the public pages
 * (ssr/source.ts) calls the same builders in-process, so a server-rendered page
 * sees exactly the data the client would fetch.
 *
 * Only public entities are returned and every object is serialized explicitly
 * (see public-catalog.ts, incidents.ts, maintenances.ts, serializers/public.ts).
 * Nothing about monitoring sources or checks is ever exposed here.
 */
import { overallStatus, shiftUptimeDay, uptimeDayStart, zId, type DataDocument, type PublicIncident, type PublicMaintenance, type PublicPageSettings, type ResourceObject } from '@openstatuspage/shared';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { HttpError, notFound } from '../lib/errors.js';
import { collection, document, Included, resource, selfLink, toMany, toOne, type DocumentRequest } from '../lib/jsonapi.js';
import { parseInclude, parseListQuery } from '../lib/jsonapi-query.js';
import { mailerConfigured, type Mailer } from '../mail/mailer.js';
import {
  groupResource,
  incidentResource,
  locationResource,
  maintenanceResource,
  PUBLIC_TYPES,
  serviceDayResource,
  serviceResource,
  settingsResource,
  SETTINGS_ID,
} from '../serializers/public.js';
import { loadIncidents, toPublicIncident } from './incidents.js';
import { loadMaintenances, toPublicMaintenance } from './maintenances.js';
import { countStatuses, loadPublicCatalog, loadPublicLocations, loadPublicService } from './public-catalog.js';
import { bucketAttributes, dayIncidentIds, dayMaintenanceIds, loadDaySegments } from './service-days.js';
import { getSettings } from './settings.js';

const DAY_MS = 86400_000;
const SERVICE_INCIDENT_DAYS = 90;

/** Filters of /api/public/history (all values refer to public entities only). */
const HistoryFilter = {
  type: z.enum(['all', 'incident', 'maintenance']).default('all'),
  service: zId.optional(),
  location: zId.optional(),
  /** Month, YYYY-MM. */
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM')
    .optional(),
};

/** `include` paths of a resource with updates (incidents, maintenances). */
const UPDATE_INCLUDES = ['updates'];

/** `include` paths of a service day; all of them by default (what the day page shows). */
const DAY_INCLUDES = ['service', 'incidents', 'incidents.updates', 'maintenances', 'maintenances.updates'];

// --- Queries (ids only; records are loaded and serialized afterwards) ----------

export async function activeIncidentIds(db: DB): Promise<string[]> {
  const rows = await db
    .selectFrom('incidents')
    .select('id')
    .where('is_public', '=', 1)
    .where('status', '!=', 'resolved')
    .orderBy('started_at', 'desc')
    .execute();
  return rows.map((r) => r.id);
}

export async function recentIncidentIds(db: DB, since: string): Promise<string[]> {
  const rows = await db
    .selectFrom('incidents')
    .select('id')
    .where('is_public', '=', 1)
    .where('status', '=', 'resolved')
    .where('resolved_at', '>=', since)
    .orderBy('resolved_at', 'desc')
    .execute();
  return rows.map((r) => r.id);
}

export async function activeMaintenanceIds(db: DB): Promise<string[]> {
  const rows = await db
    .selectFrom('maintenances')
    .select('id')
    .where('is_public', '=', 1)
    .where('status', '=', 'in_progress')
    .orderBy('scheduled_start')
    .execute();
  return rows.map((r) => r.id);
}

export async function upcomingMaintenanceIds(db: DB, now: string): Promise<string[]> {
  const rows = await db
    .selectFrom('maintenances')
    .select('id')
    .where('is_public', '=', 1)
    .where('status', '=', 'scheduled')
    .where('scheduled_end', '>', now)
    .orderBy('scheduled_start')
    .execute();
  return rows.map((r) => r.id);
}

export async function publicIncidents(db: DB, ids: string[]): Promise<PublicIncident[]> {
  return (await loadIncidents(db, ids)).map(toPublicIncident);
}

export async function publicMaintenances(db: DB, ids: string[]): Promise<PublicMaintenance[]> {
  return (await loadMaintenances(db, ids)).map(toPublicMaintenance);
}

/** A malformed day in the path (not YYYY-MM-DD or no real calendar day). */
const invalidDay = () => new HttpError(400, 'invalid_date', 'Expected a day as YYYY-MM-DD');

function monthRange(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return [new Date(Date.UTC(y, m - 1, 1)).toISOString(), new Date(Date.UTC(y, m, 1)).toISOString()];
}

// --- Documents -------------------------------------------------------------------

export interface PublicDocumentsOptions {
  /** The instance has an analytics upstream (UMAMI_URL). Without it `analyticsEnabled` is always false. */
  analytics?: boolean;
}

/** Builds the documents of the public read API (one instance per app). */
export class PublicDocuments {
  constructor(
    private readonly db: DB,
    private readonly mailer: Mailer,
    private readonly options: PublicDocumentsOptions = {},
  ) {}

  /**
   * The settings as the public pages use them: `analyticsEnabled` says whether
   * analytics actually runs (the setting and UMAMI_URL on this instance).
   */
  private publicSettings(settings: PublicPageSettings): PublicPageSettings {
    const analyticsEnabled = settings.analyticsEnabled && Boolean(this.options.analytics);
    return analyticsEnabled === settings.analyticsEnabled ? settings : { ...settings, analyticsEnabled };
  }

  /** GET /api/public/settings */
  async settings(req: DocumentRequest): Promise<DataDocument> {
    return document(settingsResource(this.publicSettings(await getSettings(this.db))), { links: { self: selfLink(req) } });
  }

  /** GET /api/public/summary: everything the overview page shows. */
  async summary(req: DocumentRequest): Promise<DataDocument> {
    const now = new Date();
    const nowIso = now.toISOString();
    const settings = await getSettings(this.db);
    const since = new Date(now.getTime() - settings.recentIncidentDays * DAY_MS).toISOString();
    const [catalog, active, recent, activeMaint, upcoming] = await Promise.all([
      loadPublicCatalog(this.db, settings, now),
      activeIncidentIds(this.db).then((ids) => publicIncidents(this.db, ids)),
      recentIncidentIds(this.db, since).then((ids) => publicIncidents(this.db, ids)),
      activeMaintenanceIds(this.db).then((ids) => publicMaintenances(this.db, ids)),
      upcomingMaintenanceIds(this.db, nowIso).then((ids) => publicMaintenances(this.db, ids)),
    ]);
    const included = new Included().add(settingsResource(this.publicSettings(settings)));
    included.add(...catalog.groups.map((g) => groupResource(g, included)));
    included.add(...catalog.ungrouped.map((s) => serviceResource(s)));
    for (const inc of [...active, ...recent]) included.add(incidentResource(inc, included));
    for (const m of [...activeMaint, ...upcoming]) included.add(maintenanceResource(m, included));
    const ids = (list: { id: string }[]) => list.map((x) => x.id);
    const summary = resource(
      PUBLIC_TYPES.summary,
      'current',
      {
        overall: overallStatus(catalog.services.map((s) => s.status)),
        emailSubscriptions: settings.emailSubscriptionsEnabled && mailerConfigured(this.mailer),
        generatedAt: nowIso,
      },
      {
        relationships: {
          page: toOne(PUBLIC_TYPES.settings, SETTINGS_ID),
          groups: toMany(PUBLIC_TYPES.group, ids(catalog.groups)),
          ungrouped: toMany(PUBLIC_TYPES.service, ids(catalog.ungrouped)),
          activeIncidents: toMany(PUBLIC_TYPES.incident, ids(active)),
          recentIncidents: toMany(PUBLIC_TYPES.incident, ids(recent)),
          activeMaintenances: toMany(PUBLIC_TYPES.maintenance, ids(activeMaint)),
          upcomingMaintenances: toMany(PUBLIC_TYPES.maintenance, ids(upcoming)),
        },
      },
    );
    return document(summary, { included, links: { self: selfLink(req) } });
  }

  /**
   * GET /api/public/status: compact status for widgets and monitoring: overall status and
   * the public services, active incidents and active maintenances as relationships.
   */
  async status(req: DocumentRequest): Promise<DataDocument> {
    const now = new Date();
    const settings = await getSettings(this.db);
    // Uptime is not part of the status; skip computing it.
    const catalog = await loadPublicCatalog(this.db, { ...settings, showUptime: false }, now);
    const [incidents, maintenances] = await Promise.all([
      activeIncidentIds(this.db).then((ids) => publicIncidents(this.db, ids)),
      activeMaintenanceIds(this.db).then((ids) => publicMaintenances(this.db, ids)),
    ]);
    const included = new Included();
    included.add(...catalog.groups.map((g) => groupResource(g, included)));
    included.add(...catalog.ungrouped.map((s) => serviceResource(s)));
    for (const inc of incidents) included.add(incidentResource(inc, included));
    for (const m of maintenances) included.add(maintenanceResource(m, included));
    const ids = (list: { id: string }[]) => list.map((x) => x.id);
    const status = resource(
      PUBLIC_TYPES.status,
      'current',
      { overall: overallStatus(catalog.services.map((s) => s.status)), updatedAt: now.toISOString() },
      {
        relationships: {
          services: toMany(PUBLIC_TYPES.service, ids(catalog.services)),
          activeIncidents: toMany(PUBLIC_TYPES.incident, ids(incidents)),
          activeMaintenances: toMany(PUBLIC_TYPES.maintenance, ids(maintenances)),
        },
        links: { self: '/api/public/status' },
      },
    );
    return document(status, { included, links: { self: selfLink(req) } });
  }

  /** GET /api/public/services: public services in display order (grouped ones in group order, then ungrouped); groups in `included`. */
  async services(req: DocumentRequest): Promise<DataDocument> {
    const settings = await getSettings(this.db);
    const catalog = await loadPublicCatalog(this.db, settings, new Date());
    const services = [...catalog.groups.flatMap((g) => g.services), ...catalog.ungrouped];
    // The group's services are primary data already. loadPublicCatalog drops groups
    // without public services, so every included group is linked from a service.
    const included = catalog.groups.map((g) => groupResource(g, new Included()));
    return collection(
      req,
      services.map((s) => serviceResource(s)),
      { included, meta: { counts: catalog.counts } },
    );
  }

  /** GET /api/public/services/:idOrSlug (404 for unknown or hidden services). */
  async service(req: DocumentRequest, idOrSlug: string): Promise<DataDocument> {
    const include = parseInclude(
      req.query as Record<string, unknown>,
      ['incidents', 'incidents.updates', 'maintenances', 'maintenances.updates'],
      ['incidents.updates', 'maintenances.updates'],
    );
    const now = new Date();
    const settings = await getSettings(this.db);
    const service = await loadPublicService(this.db, idOrSlug, settings, now);
    if (!service) throw notFound('Service');

    const since = new Date(now.getTime() - SERVICE_INCIDENT_DAYS * DAY_MS).toISOString();
    const [incidentRows, maintenanceRows] = await Promise.all([
      this.db
        .selectFrom('incidents')
        .innerJoin('incident_services', 'incident_services.incident_id', 'incidents.id')
        .select('incidents.id')
        .where('incident_services.service_id', '=', service.id)
        .where('incidents.is_public', '=', 1)
        .where((eb) => eb.or([eb('incidents.started_at', '>=', since), eb('incidents.status', '!=', 'resolved')]))
        .orderBy('incidents.started_at', 'desc')
        .execute(),
      this.db
        .selectFrom('maintenances')
        .innerJoin('maintenance_services', 'maintenance_services.maintenance_id', 'maintenances.id')
        .select('maintenances.id')
        .where('maintenance_services.service_id', '=', service.id)
        .where('maintenances.is_public', '=', 1)
        .where((eb) =>
          eb.or([
            eb('maintenances.status', '=', 'in_progress'),
            eb.and([eb('maintenances.status', '=', 'scheduled'), eb('maintenances.scheduled_end', '>', now.toISOString())]),
          ]),
        )
        .orderBy('maintenances.scheduled_start')
        .execute(),
    ]);

    const incidentIds = incidentRows.map((r) => r.id);
    const maintenanceIds = maintenanceRows.map((r) => r.id);

    const included = new Included();
    const wants = (path: string) => include.has(path) || include.has(`${path}.updates`);
    if (wants('incidents')) {
      const updates = include.has('incidents.updates') ? included : undefined;
      for (const inc of await publicIncidents(this.db, incidentIds)) included.add(incidentResource(inc, updates));
    }
    if (wants('maintenances')) {
      const updates = include.has('maintenances.updates') ? included : undefined;
      for (const m of await publicMaintenances(this.db, maintenanceIds)) included.add(maintenanceResource(m, updates));
    }
    const data = serviceResource(
      // Empty when uptime display is disabled in the settings.
      { ...service, uptime: service.uptime ?? [] },
      {
        incidents: toMany(PUBLIC_TYPES.incident, incidentIds),
        maintenances: toMany(PUBLIC_TYPES.maintenance, maintenanceIds),
      },
    );
    return document(data, { included, links: { self: selfLink(req) } });
  }

  /**
   * GET /api/public/services/:idOrSlug/days/:date: one UTC day of the uptime bar
   * in detail. 400 for a malformed date; 404 for unknown or hidden services, for
   * days outside the uptime range (settings.uptimeDays, ending today) and while
   * uptime is not shown at all.
   */
  async serviceDay(req: DocumentRequest, idOrSlug: string, date: string): Promise<DataDocument> {
    const dayStart = uptimeDayStart(date);
    if (dayStart === null) throw invalidDay();
    const include = parseInclude(req.query as Record<string, unknown>, DAY_INCLUDES, DAY_INCLUDES);
    const now = new Date();
    const settings = await getSettings(this.db);
    if (!settings.showUptime) throw notFound('Day');
    const service = await loadPublicService(this.db, idOrSlug, settings, now);
    if (!service) throw notFound('Service');
    const days = service.uptime ?? [];
    const index = days.findIndex((d) => d.date === date);
    if (index < 0) throw notFound('Day');

    const [segments, incidentIds, maintenanceIds] = await Promise.all([
      loadDaySegments(this.db, service.id, dayStart, now),
      dayIncidentIds(this.db, service.id, dayStart),
      dayMaintenanceIds(this.db, service.id, dayStart, now),
    ]);
    const included = new Included();
    const wants = (path: string) => include.has(path) || include.has(`${path}.updates`);
    // The bars stay on the service resource; the day carries its own bucket.
    if (include.has('service')) {
      const { uptime: _bars, ...withoutBars } = service;
      included.add(serviceResource(withoutBars));
    }
    if (wants('incidents')) {
      const updates = include.has('incidents.updates') ? included : undefined;
      for (const inc of await publicIncidents(this.db, incidentIds)) included.add(incidentResource(inc, updates));
    }
    if (wants('maintenances')) {
      const updates = include.has('maintenances.updates') ? included : undefined;
      for (const m of await publicMaintenances(this.db, maintenanceIds)) included.add(maintenanceResource(m, updates));
    }
    const data = serviceDayResource(
      {
        id: `${service.id}:${date}`,
        ...bucketAttributes(days[index]!),
        startsAt: new Date(dayStart).toISOString(),
        endsAt: new Date(dayStart + DAY_MS).toISOString(),
        complete: dayStart + DAY_MS <= now.getTime(),
        segments,
        previousDate: index > 0 ? shiftUptimeDay(date, -1) : null,
        nextDate: index < days.length - 1 ? shiftUptimeDay(date, 1) : null,
      },
      service,
      incidentIds,
      maintenanceIds,
    );
    return document(data, { included, links: { self: selfLink(req) } });
  }

  /** GET /api/public/locations (404 while the locations page is disabled). */
  async locations(req: DocumentRequest): Promise<DataDocument> {
    if (!(await getSettings(this.db)).showLocations) throw notFound('Locations');
    const locations = await loadPublicLocations(this.db);
    return collection(req, locations.map(locationResource), {
      meta: { counts: countStatuses(locations.map((l) => l.status)) },
    });
  }

  /** GET /api/public/incidents/:id (404 for unknown or hidden incidents). */
  async incident(req: DocumentRequest, id: string): Promise<DataDocument> {
    const include = parseInclude(req.query as Record<string, unknown>, UPDATE_INCLUDES, UPDATE_INCLUDES);
    const [rec] = await loadIncidents(this.db, [id]);
    if (!rec || rec.row.is_public !== 1) throw notFound('Incident');
    const included = new Included();
    const data = incidentResource(toPublicIncident(rec), include.has('updates') ? included : undefined);
    return document(data, { included, links: { self: selfLink(req) } });
  }

  /** GET /api/public/maintenances/:id (404 for unknown or hidden windows). */
  async maintenance(req: DocumentRequest, id: string): Promise<DataDocument> {
    const include = parseInclude(req.query as Record<string, unknown>, UPDATE_INCLUDES, UPDATE_INCLUDES);
    const [rec] = await loadMaintenances(this.db, [id]);
    if (!rec || rec.row.is_public !== 1) throw notFound('Maintenance');
    const included = new Included();
    const data = maintenanceResource(toPublicMaintenance(rec), include.has('updates') ? included : undefined);
    return document(data, { included, links: { self: selfLink(req) } });
  }

  /**
   * GET /api/public/history: incidents and maintenance windows, newest first: a
   * heterogeneous collection (`incidents` ordered by startedAt, `maintenances` by scheduledStart).
   */
  async history(req: DocumentRequest): Promise<DataDocument> {
    const q = parseListQuery(req.query, {
      filter: HistoryFilter,
      include: { allowed: UPDATE_INCLUDES, default: UPDATE_INCLUDES },
    });
    const now = new Date().toISOString();
    const range = q.filter.month ? monthRange(q.filter.month) : null;
    const serviceFilter = q.filter.service;
    const locationFilter = q.filter.location;
    const emptyPage = () => collection(req, [], { page: q.page, total: 0 });

    // Filters must only match public entities, otherwise the result would reveal hidden links.
    if (serviceFilter) {
      const svc = await this.db
        .selectFrom('services')
        .select('id')
        .where('id', '=', serviceFilter)
        .where('is_public', '=', 1)
        .executeTakeFirst();
      if (!svc) return emptyPage();
    }
    if (locationFilter) {
      const loc = await this.db
        .selectFrom('locations')
        .select('id')
        .where('id', '=', locationFilter)
        .where('is_public', '=', 1)
        .executeTakeFirst();
      if (!loc) return emptyPage();
    }

    const entries: { type: 'incident' | 'maintenance'; id: string; date: string }[] = [];

    if (q.filter.type !== 'maintenance') {
      let iq = this.db.selectFrom('incidents').select(['id', 'started_at as date']).where('is_public', '=', 1);
      if (range) iq = iq.where('started_at', '>=', range[0]).where('started_at', '<', range[1]);
      if (serviceFilter) {
        const serviceId = serviceFilter;
        iq = iq.where('id', 'in', (eb) =>
          eb.selectFrom('incident_services').select('incident_id').where('service_id', '=', serviceId),
        );
      }
      if (locationFilter) {
        const locationId = locationFilter;
        iq = iq.where((eb) =>
          eb.or([
            eb('id', 'in', eb.selectFrom('incident_locations').select('incident_id').where('location_id', '=', locationId)),
            eb(
              'id',
              'in',
              eb
                .selectFrom('incident_services')
                .innerJoin('service_locations', 'service_locations.service_id', 'incident_services.service_id')
                .innerJoin('services', 'services.id', 'incident_services.service_id')
                .select('incident_services.incident_id')
                .where('service_locations.location_id', '=', locationId)
                // Hidden services must not reveal where they run.
                .where('services.is_public', '=', 1),
            ),
          ]),
        );
      }
      for (const r of await iq.execute()) entries.push({ type: 'incident', id: r.id, date: r.date });
    }

    if (q.filter.type !== 'incident') {
      let mq = this.db
        .selectFrom('maintenances')
        .select(['id', 'scheduled_start as date'])
        .where('is_public', '=', 1)
        // Future windows that have not started yet are announcements, not history.
        .where((eb) => eb.not(eb.and([eb('status', '=', 'scheduled'), eb('scheduled_start', '>', now)])));
      if (range) mq = mq.where('scheduled_start', '>=', range[0]).where('scheduled_start', '<', range[1]);
      if (serviceFilter) {
        const serviceId = serviceFilter;
        mq = mq.where('id', 'in', (eb) =>
          eb.selectFrom('maintenance_services').select('maintenance_id').where('service_id', '=', serviceId),
        );
      }
      if (locationFilter) {
        const locationId = locationFilter;
        mq = mq.where((eb) =>
          eb.or([
            eb(
              'id',
              'in',
              eb.selectFrom('maintenance_locations').select('maintenance_id').where('location_id', '=', locationId),
            ),
            eb(
              'id',
              'in',
              eb
                .selectFrom('maintenance_services')
                .innerJoin('service_locations', 'service_locations.service_id', 'maintenance_services.service_id')
                .innerJoin('services', 'services.id', 'maintenance_services.service_id')
                .select('maintenance_services.maintenance_id')
                .where('service_locations.location_id', '=', locationId)
                // Hidden services must not reveal where they run.
                .where('services.is_public', '=', 1),
            ),
          ]),
        );
      }
      for (const r of await mq.execute()) entries.push({ type: 'maintenance', id: r.id, date: r.date });
    }

    // Ids are UUIDs: a plain comparison orders them like localeCompare, without ICU collation.
    entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const page = entries.slice(q.page.offset, q.page.offset + q.page.size);

    const [incidents, maintenances] = await Promise.all([
      loadIncidents(
        this.db,
        page.filter((e) => e.type === 'incident').map((e) => e.id),
      ),
      loadMaintenances(
        this.db,
        page.filter((e) => e.type === 'maintenance').map((e) => e.id),
      ),
    ]);
    const incidentById = new Map(incidents.map((r) => [r.row.id, r]));
    const maintenanceById = new Map(maintenances.map((r) => [r.row.id, r]));

    const included = new Included();
    const updates = q.include.has('updates') ? included : undefined;
    const data = page.flatMap((e): ResourceObject[] => {
      if (e.type === 'incident') {
        const rec = incidentById.get(e.id);
        return rec ? [incidentResource(toPublicIncident(rec), updates)] : [];
      }
      const rec = maintenanceById.get(e.id);
      return rec ? [maintenanceResource(toPublicMaintenance(rec), updates)] : [];
    });
    return collection(req, data, { included, page: q.page, total: entries.length });
  }
}
