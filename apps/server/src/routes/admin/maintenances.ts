import {
  MaintenanceCreateInput,
  MaintenancePatchInput,
  MaintenanceUpdateInput,
  type AdminMaintenance,
} from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { IdParams, offsetOf, PageQuery, paginated, parse, unique } from '../../lib/http.js';
import { nowIso, toIso } from '../../lib/time.js';
import { actorUserId } from '../../plugins/auth.js';
import { nextUpdateTimestamp } from '../../services/incidents.js';
import { runMaintenanceTransitions } from '../../services/maintenance-scheduler.js';
import { loadMaintenance, loadMaintenances, toAdminMaintenance } from '../../services/maintenances.js';
import { assertExist, auditRequest, editor } from './util.js';

const ListQuery = PageQuery.extend({ status: z.enum(['upcoming', 'active', 'past', 'all']).default('all') });

async function getMaintenance(db: DB, id: string): Promise<AdminMaintenance> {
  const rec = await loadMaintenance(db, id);
  if (!rec) throw notFound('Maintenance');
  return toAdminMaintenance(rec);
}

async function replaceServices(trx: DB, maintenanceId: string, serviceIds: string[]) {
  await trx.deleteFrom('maintenance_services').where('maintenance_id', '=', maintenanceId).execute();
  const ids = unique(serviceIds);
  if (ids.length > 0) {
    await trx
      .insertInto('maintenance_services')
      .values(ids.map((service_id) => ({ maintenance_id: maintenanceId, service_id })))
      .execute();
  }
}

async function replaceLocations(trx: DB, maintenanceId: string, locationIds: string[]) {
  await trx.deleteFrom('maintenance_locations').where('maintenance_id', '=', maintenanceId).execute();
  const ids = unique(locationIds);
  if (ids.length > 0) {
    await trx
      .insertInto('maintenance_locations')
      .values(ids.map((location_id) => ({ maintenance_id: maintenanceId, location_id })))
      .execute();
  }
}

async function serviceIdsOf(db: DB, maintenanceId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('maintenance_services')
    .select('service_id')
    .where('maintenance_id', '=', maintenanceId)
    .execute();
  return rows.map((r) => r.service_id);
}

/** /api/admin/maintenances (editor) */
export async function registerMaintenanceRoutes(app: FastifyInstance): Promise<void> {
  const { db, engine } = app.ctx;

  /** Applies due automatic transitions right away instead of waiting for the next worker tick. */
  const applyDueTransitions = () => runMaintenanceTransitions(db, engine);

  app.get('/api/admin/maintenances', editor, async (req) => {
    const q = parse(ListQuery, req.query);
    const now = nowIso();
    let base = db.selectFrom('maintenances');
    if (q.status === 'upcoming') base = base.where('status', '=', 'scheduled').where('scheduled_end', '>', now);
    if (q.status === 'active') base = base.where('status', '=', 'in_progress');
    if (q.status === 'past') base = base.where('status', 'in', ['completed', 'cancelled']);
    const [total, rows] = await Promise.all([
      base
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .executeTakeFirstOrThrow()
        .then((r) => Number(r.n)),
      base
        .select('id')
        // Upcoming windows soonest first, everything else newest first.
        .orderBy('scheduled_start', q.status === 'upcoming' ? 'asc' : 'desc')
        .orderBy('id')
        .limit(q.pageSize)
        .offset(offsetOf(q))
        .execute(),
    ]);
    const records = await loadMaintenances(
      db,
      rows.map((r) => r.id),
    );
    return paginated(records.map(toAdminMaintenance), total, q);
  });

  app.post('/api/admin/maintenances', editor, async (req, reply) => {
    const input = parse(MaintenanceCreateInput, req.body);
    const serviceIds = await assertExist(db, 'services', input.serviceIds, 'service');
    await assertExist(db, 'locations', input.locationIds, 'location');
    const id = newId();
    const now = nowIso();
    const userId = actorUserId(req);
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('maintenances')
        .values({
          id,
          title: input.title,
          description: input.description,
          status: 'scheduled',
          scheduled_start: toIso(input.scheduledStart),
          scheduled_end: toIso(input.scheduledEnd),
          actual_start: null,
          actual_end: null,
          auto_start: input.autoStart ? 1 : 0,
          auto_complete: input.autoComplete ? 1 : 0,
          is_public: input.isPublic ? 1 : 0,
          notify_subscribers: input.notify ? 1 : 0,
          reminder_sent_at: null,
          created_by: userId,
          created_at: now,
          updated_at: now,
        })
        .execute();
      // Empty message: clients render a localized "scheduled" text.
      await trx
        .insertInto('maintenance_updates')
        .values({ id: newId(), maintenance_id: id, status: 'scheduled', message: '', created_by: userId, created_at: now })
        .execute();
      await replaceServices(trx, id, serviceIds);
      await replaceLocations(trx, id, input.locationIds);
    });
    await applyDueTransitions();
    await engine.recompute(serviceIds);
    await auditRequest(db, req, 'maintenance.create', 'maintenance', id, {
      title: input.title,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
    });
    return reply.status(201).send(await getMaintenance(db, id));
  });

  app.get('/api/admin/maintenances/:id', editor, async (req) => getMaintenance(db, parse(IdParams, req.params).id));

  app.patch('/api/admin/maintenances/:id', editor, async (req) => {
    const { id } = parse(IdParams, req.params);
    const input = parse(MaintenancePatchInput, req.body);
    const current = await db.selectFrom('maintenances').selectAll().where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Maintenance');
    if (input.serviceIds) await assertExist(db, 'services', input.serviceIds, 'service');
    if (input.locationIds) await assertExist(db, 'locations', input.locationIds, 'location');

    const start = input.scheduledStart ? toIso(input.scheduledStart) : current.scheduled_start;
    const end = input.scheduledEnd ? toIso(input.scheduledEnd) : current.scheduled_end;
    if (end <= start) throw badRequest('scheduledEnd must be after scheduledStart');

    const before = await serviceIdsOf(db, id);
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('maintenances')
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.autoStart !== undefined ? { auto_start: input.autoStart ? 1 : 0 } : {}),
          ...(input.autoComplete !== undefined ? { auto_complete: input.autoComplete ? 1 : 0 } : {}),
          ...(input.isPublic !== undefined ? { is_public: input.isPublic ? 1 : 0 } : {}),
          ...(input.notify !== undefined ? { notify_subscribers: input.notify ? 1 : 0 } : {}),
          scheduled_start: start,
          scheduled_end: end,
          updated_at: nowIso(),
        })
        .where('id', '=', id)
        .execute();
      if (input.serviceIds) await replaceServices(trx, id, input.serviceIds);
      if (input.locationIds) await replaceLocations(trx, id, input.locationIds);
    });
    await applyDueTransitions();
    await engine.recompute([...before, ...(input.serviceIds ?? [])]);
    await auditRequest(db, req, 'maintenance.update', 'maintenance', id, { fields: Object.keys(input) });
    return getMaintenance(db, id);
  });

  app.delete('/api/admin/maintenances/:id', editor, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const current = await db.selectFrom('maintenances').select(['title']).where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Maintenance');
    const before = await serviceIdsOf(db, id);
    await db.deleteFrom('maintenances').where('id', '=', id).execute();
    await engine.recompute(before);
    await auditRequest(db, req, 'maintenance.delete', 'maintenance', id, { title: current.title });
    return reply.status(204).send();
  });

  app.post('/api/admin/maintenances/:id/updates', editor, async (req) => {
    const { id } = parse(IdParams, req.params);
    const input = parse(MaintenanceUpdateInput, req.body);
    const current = await db.selectFrom('maintenances').selectAll().where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Maintenance');
    const now = await nextUpdateTimestamp(db, 'maintenance_updates', id);
    const ended = input.status === 'completed' || input.status === 'cancelled';
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('maintenance_updates')
        .values({
          id: newId(),
          maintenance_id: id,
          status: input.status,
          message: input.message,
          created_by: actorUserId(req),
          created_at: now,
        })
        .execute();
      await trx
        .updateTable('maintenances')
        .set({
          status: input.status,
          ...(input.status === 'in_progress' ? { actual_start: current.actual_start ?? now, actual_end: null } : {}),
          ...(ended ? { actual_end: now } : {}),
          updated_at: now,
        })
        .where('id', '=', id)
        .execute();
    });
    await engine.recompute(await serviceIdsOf(db, id));
    await auditRequest(db, req, 'maintenance.update_posted', 'maintenance', id, { status: input.status });
    return getMaintenance(db, id);
  });
}
