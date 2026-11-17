/**
 * /api/public: unauthenticated read API for the public status page.
 *
 * Only public entities are returned and every object is serialized
 * explicitly (see services/public-catalog.ts, incidents.ts, maintenances.ts).
 * Nothing about monitoring sources or checks is ever exposed here.
 */
import {
  HistoryQuery,
  overallStatus,
  type HistoryItem,
  type PublicIncident,
  type PublicLocationsResponse,
  type PublicMaintenance,
  type PublicSummary,
} from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import { offsetOf, paginated, parse } from '../lib/http.js';
import { loadIncidents, toPublicIncident } from '../services/incidents.js';
import { loadMaintenances, toPublicMaintenance } from '../services/maintenances.js';
import {
  countStatuses,
  loadPublicCatalog,
  loadPublicLocations,
  loadPublicService,
} from '../services/public-catalog.js';
import { getSettings } from '../services/settings.js';
import { registerFeedRoutes } from './feeds.js';

const DAY_MS = 86400_000;
const SERVICE_INCIDENT_DAYS = 90;

const IdOrSlugParams = z.object({ idOrSlug: z.string().min(1).max(100) });
const IdParams = z.object({ id: z.string().min(1).max(64) });

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
  await app.register(async (scope) => {
    const { db } = app.ctx;

    scope.addHook('onSend', async (req, reply, payload) => {
      if (req.method === 'GET' && reply.statusCode === 200) {
        reply.header('cache-control', 'public, max-age=30');
      }
      return payload;
    });

    scope.get('/api/public/settings', async () => getSettings(db));

    scope.get('/api/public/summary', async (): Promise<PublicSummary> => {
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
      return {
        page: settings,
        overall: overallStatus(catalog.services.map((s) => s.status)),
        groups: catalog.groups,
        ungrouped: catalog.ungrouped,
        activeIncidents: active,
        recentIncidents: recent,
        activeMaintenances: activeMaint,
        upcomingMaintenances: upcoming,
        generatedAt: nowIso,
      };
    });

    scope.get('/api/public/services', async () => {
      const settings = await getSettings(db);
      const catalog = await loadPublicCatalog(db, settings, new Date());
      return { groups: catalog.groups, ungrouped: catalog.ungrouped, counts: catalog.counts };
    });

    scope.get('/api/public/services/:idOrSlug', async (req) => {
      const { idOrSlug } = parse(IdOrSlugParams, req.params);
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

      return {
        ...service,
        // Empty when uptime display is disabled in the settings.
        uptime: service.uptime ?? [],
        incidents: await publicIncidents(
          db,
          incidentRows.map((r) => r.id),
        ),
        maintenances: await publicMaintenances(
          db,
          maintenanceRows.map((r) => r.id),
        ),
      };
    });

    scope.get('/api/public/locations', async (): Promise<PublicLocationsResponse> => {
      if (!(await getSettings(db)).showLocations) throw notFound('Locations');
      const locations = await loadPublicLocations(db);
      return { locations, counts: countStatuses(locations.map((l) => l.status)) };
    });

    scope.get('/api/public/incidents/:id', async (req): Promise<PublicIncident> => {
      const { id } = parse(IdParams, req.params);
      const [rec] = await loadIncidents(db, [id]);
      if (!rec || rec.row.is_public !== 1) throw notFound('Incident');
      return toPublicIncident(rec);
    });

    scope.get('/api/public/maintenances/:id', async (req): Promise<PublicMaintenance> => {
      const { id } = parse(IdParams, req.params);
      const [rec] = await loadMaintenances(db, [id]);
      if (!rec || rec.row.is_public !== 1) throw notFound('Maintenance');
      return toPublicMaintenance(rec);
    });

    scope.get('/api/public/history', async (req) => {
      const q = parse(HistoryQuery, req.query);
      const now = new Date().toISOString();
      const range = q.month ? monthRange(q.month) : null;

      // Filters must only match public entities, otherwise the result would reveal hidden links.
      if (q.serviceId) {
        const svc = await db
          .selectFrom('services')
          .select('id')
          .where('id', '=', q.serviceId)
          .where('is_public', '=', 1)
          .executeTakeFirst();
        if (!svc) return paginated([], 0, q);
      }
      if (q.locationId) {
        const loc = await db
          .selectFrom('locations')
          .select('id')
          .where('id', '=', q.locationId)
          .where('is_public', '=', 1)
          .executeTakeFirst();
        if (!loc) return paginated([], 0, q);
      }

      const entries: { type: 'incident' | 'maintenance'; id: string; date: string }[] = [];

      if (q.type !== 'maintenance') {
        let iq = db.selectFrom('incidents').select(['id', 'started_at as date']).where('is_public', '=', 1);
        if (range) iq = iq.where('started_at', '>=', range[0]).where('started_at', '<', range[1]);
        if (q.serviceId) {
          const serviceId = q.serviceId;
          iq = iq.where('id', 'in', (eb) =>
            eb.selectFrom('incident_services').select('incident_id').where('service_id', '=', serviceId),
          );
        }
        if (q.locationId) {
          const locationId = q.locationId;
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

      if (q.type !== 'incident') {
        let mq = db
          .selectFrom('maintenances')
          .select(['id', 'scheduled_start as date'])
          .where('is_public', '=', 1)
          // Future windows that have not started yet are announcements, not history.
          .where((eb) => eb.not(eb.and([eb('status', '=', 'scheduled'), eb('scheduled_start', '>', now)])));
        if (range) mq = mq.where('scheduled_start', '>=', range[0]).where('scheduled_start', '<', range[1]);
        if (q.serviceId) {
          const serviceId = q.serviceId;
          mq = mq.where('id', 'in', (eb) =>
            eb.selectFrom('maintenance_services').select('maintenance_id').where('service_id', '=', serviceId),
          );
        }
        if (q.locationId) {
          const locationId = q.locationId;
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
      const page = entries.slice(offsetOf(q), offsetOf(q) + q.pageSize);

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

      const items: HistoryItem[] = page.flatMap((e): HistoryItem[] => {
        if (e.type === 'incident') {
          const rec = incidentById.get(e.id);
          return rec ? [{ type: 'incident', date: e.date, incident: toPublicIncident(rec) }] : [];
        }
        const rec = maintenanceById.get(e.id);
        return rec ? [{ type: 'maintenance', date: e.date, maintenance: toPublicMaintenance(rec) }] : [];
      });
      return paginated(items, entries.length, q);
    });

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
