/**
 * /api/public: unauthenticated read API for the public status page (JSON:API 1.1).
 *
 * Only public entities are returned and every object is serialized
 * explicitly (see services/public-catalog.ts, incidents.ts, maintenances.ts,
 * serializers/public.ts). Nothing about monitoring sources or checks is ever
 * exposed here.
 *
 * /api/public/status.json and the feeds are not JSON:API (stable formats for
 * third-party tools and feed readers).
 */
import { overallStatus, zId, type PublicIncident, type PublicMaintenance, type ResourceObject } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import { parse } from '../lib/http.js';
import { collection, document, Included, resource, selfLink, toMany, toOne } from '../lib/jsonapi.js';
import { parseInclude, parseListQuery } from '../lib/jsonapi-query.js';
import { mailerConfigured } from '../mail/mailer.js';
import { loadIncidents, toPublicIncident } from '../services/incidents.js';
import { loadMaintenances, toPublicMaintenance } from '../services/maintenances.js';
import {
  countStatuses,
  loadPublicCatalog,
  loadPublicLocations,
  loadPublicService,
} from '../services/public-catalog.js';
import { getSettings } from '../services/settings.js';
import { useJsonApi, withInclude } from '../plugins/jsonapi.js';
import {
  groupResource,
  incidentResource,
  locationResource,
  maintenanceResource,
  PUBLIC_TYPES,
  serviceResource,
  settingsResource,
  SETTINGS_ID,
} from '../serializers/public.js';
import { registerFeedRoutes } from './feeds.js';

const DAY_MS = 86400_000;
const SERVICE_INCIDENT_DAYS = 90;

const IdOrSlugParams = z.object({ idOrSlug: z.string().min(1).max(100) });
const IdParams = z.object({ id: z.string().min(1).max(64) });

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

const cacheHeaders = (scope: FastifyInstance) =>
  scope.addHook('onSend', async (req, reply, payload) => {
    if (req.method === 'GET' && reply.statusCode === 200) {
      reply.header('cache-control', 'public, max-age=30');
    }
    return payload;
  });

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

async function recentIncidentIds(db: DB, since: string): Promise<string[]> {
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

async function upcomingMaintenanceIds(db: DB, now: string): Promise<string[]> {
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

async function publicIncidents(db: DB, ids: string[]): Promise<PublicIncident[]> {
  return (await loadIncidents(db, ids)).map(toPublicIncident);
}

async function publicMaintenances(db: DB, ids: string[]): Promise<PublicMaintenance[]> {
  return (await loadMaintenances(db, ids)).map(toPublicMaintenance);
}

function monthRange(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return [new Date(Date.UTC(y, m - 1, 1)).toISOString(), new Date(Date.UTC(y, m, 1)).toISOString()];
}

// --- Routes ----------------------------------------------------------------------

export async function registerPublicRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  // JSON:API routes.
  await app.register(async (scope) => {
    useJsonApi(scope);
    cacheHeaders(scope);

    scope.get('/api/public/settings', async (req) =>
      document(settingsResource(await getSettings(db)), { links: { self: selfLink(req) } }),
    );

    scope.get('/api/public/summary', async (req) => {
      const now = new Date();
      const nowIso = now.toISOString();
      const settings = await getSettings(db);
      const since = new Date(now.getTime() - settings.recentIncidentDays * DAY_MS).toISOString();
      const [catalog, active, recent, activeMaint, upcoming] = await Promise.all([
        loadPublicCatalog(db, settings, now),
        activeIncidentIds(db).then((ids) => publicIncidents(db, ids)),
        recentIncidentIds(db, since).then((ids) => publicIncidents(db, ids)),
        activeMaintenanceIds(db).then((ids) => publicMaintenances(db, ids)),
        upcomingMaintenanceIds(db, nowIso).then((ids) => publicMaintenances(db, ids)),
      ]);
      const included = new Included().add(settingsResource(settings));
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
          emailSubscriptions: settings.emailSubscriptionsEnabled && mailerConfigured(app.ctx.mailer),
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
    });

    /** Public services in display order (grouped ones in group order, then ungrouped); groups in `included`. */
    scope.get('/api/public/services', async (req) => {
      const settings = await getSettings(db);
      const catalog = await loadPublicCatalog(db, settings, new Date());
      const services = [...catalog.groups.flatMap((g) => g.services), ...catalog.ungrouped];
      // The group's services are primary data already. loadPublicCatalog drops groups
      // without public services, so every included group is linked from a service.
      const included = catalog.groups.map((g) => groupResource(g, new Included()));
      return collection(
        req,
        services.map((s) => serviceResource(s)),
        { included, meta: { counts: catalog.counts } },
      );
    });

    scope.get('/api/public/services/:idOrSlug', withInclude, async (req) => {
      const { idOrSlug } = parse(IdOrSlugParams, req.params);
      const include = parseInclude(
        req.query as Record<string, unknown>,
        ['incidents', 'incidents.updates', 'maintenances', 'maintenances.updates'],
        ['incidents.updates', 'maintenances.updates'],
      );
      const now = new Date();
      const settings = await getSettings(db);
      const service = await loadPublicService(db, idOrSlug, settings, now);
      if (!service) throw notFound('Service');

      const since = new Date(now.getTime() - SERVICE_INCIDENT_DAYS * DAY_MS).toISOString();
      const [incidentRows, maintenanceRows] = await Promise.all([
        db
          .selectFrom('incidents')
          .innerJoin('incident_services', 'incident_services.incident_id', 'incidents.id')
          .select('incidents.id')
          .where('incident_services.service_id', '=', service.id)
          .where('incidents.is_public', '=', 1)
          .where((eb) => eb.or([eb('incidents.started_at', '>=', since), eb('incidents.status', '!=', 'resolved')]))
          .orderBy('incidents.started_at', 'desc')
          .execute(),
        db
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
        for (const inc of await publicIncidents(db, incidentIds)) included.add(incidentResource(inc, updates));
      }
      if (wants('maintenances')) {
        const updates = include.has('maintenances.updates') ? included : undefined;
        for (const m of await publicMaintenances(db, maintenanceIds)) included.add(maintenanceResource(m, updates));
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
    });

    scope.get('/api/public/locations', async (req) => {
      if (!(await getSettings(db)).showLocations) throw notFound('Locations');
      const locations = await loadPublicLocations(db);
      return collection(req, locations.map(locationResource), {
        meta: { counts: countStatuses(locations.map((l) => l.status)) },
      });
    });

    scope.get('/api/public/incidents/:id', withInclude, async (req) => {
      const { id } = parse(IdParams, req.params);
      const include = parseInclude(req.query as Record<string, unknown>, UPDATE_INCLUDES, UPDATE_INCLUDES);
      const [rec] = await loadIncidents(db, [id]);
      if (!rec || rec.row.is_public !== 1) throw notFound('Incident');
      const included = new Included();
      const data = incidentResource(toPublicIncident(rec), include.has('updates') ? included : undefined);
      return document(data, { included, links: { self: selfLink(req) } });
    });

    scope.get('/api/public/maintenances/:id', withInclude, async (req) => {
      const { id } = parse(IdParams, req.params);
      const include = parseInclude(req.query as Record<string, unknown>, UPDATE_INCLUDES, UPDATE_INCLUDES);
      const [rec] = await loadMaintenances(db, [id]);
      if (!rec || rec.row.is_public !== 1) throw notFound('Maintenance');
      const included = new Included();
      const data = maintenanceResource(toPublicMaintenance(rec), include.has('updates') ? included : undefined);
      return document(data, { included, links: { self: selfLink(req) } });
    });

    /**
     * Incidents and maintenance windows, newest first: a heterogeneous collection
     * (`incidents` ordered by startedAt, `maintenances` by scheduledStart).
     */
    scope.get('/api/public/history', withInclude, async (req) => {
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
        const svc = await db
          .selectFrom('services')
          .select('id')
          .where('id', '=', serviceFilter)
          .where('is_public', '=', 1)
          .executeTakeFirst();
        if (!svc) return emptyPage();
      }
      if (locationFilter) {
        const loc = await db
          .selectFrom('locations')
          .select('id')
          .where('id', '=', locationFilter)
          .where('is_public', '=', 1)
          .executeTakeFirst();
        if (!loc) return emptyPage();
      }

      const entries: { type: 'incident' | 'maintenance'; id: string; date: string }[] = [];

      if (q.filter.type !== 'maintenance') {
        let iq = db.selectFrom('incidents').select(['id', 'started_at as date']).where('is_public', '=', 1);
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
        let mq = db
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

      entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id.localeCompare(b.id)));
      const page = entries.slice(q.page.offset, q.page.offset + q.page.size);

      const [incidents, maintenances] = await Promise.all([
        loadIncidents(
          db,
          page.filter((e) => e.type === 'incident').map((e) => e.id),
        ),
        loadMaintenances(
          db,
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
    });
  });

  // Plain JSON and feeds (not JSON:API).
  await app.register(async (scope) => {
    cacheHeaders(scope);

    scope.get('/api/public/status.json', async () => {
      const now = new Date();
      const settings = await getSettings(db);
      // Uptime is not part of status.json; skip computing it.
      const catalog = await loadPublicCatalog(db, { ...settings, showUptime: false }, now);
      const [incidents, maintenances] = await Promise.all([
        activeIncidentIds(db).then((ids) => loadIncidents(db, ids)),
        activeMaintenanceIds(db).then((ids) => loadMaintenances(db, ids)),
      ]);
      return {
        overall: overallStatus(catalog.services.map((s) => s.status)),
        updatedAt: now.toISOString(),
        services: catalog.services.map((s) => ({
          id: s.id,
          name: s.name,
          group: s.groupId ? (catalog.groupNames.get(s.groupId) ?? null) : null,
          status: s.status,
        })),
        activeIncidents: incidents.map((r) => ({
          id: r.row.id,
          title: r.row.title,
          status: r.row.status,
          impact: r.row.impact,
        })),
        activeMaintenances: maintenances.map((r) => ({
          id: r.row.id,
          title: r.row.title,
          scheduledEnd: r.row.scheduled_end,
        })),
      };
    });

    await registerFeedRoutes(scope);
  });
}
