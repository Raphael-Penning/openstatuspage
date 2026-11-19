import {
  IncidentCreateInput,
  IncidentPatchInput,
  IncidentUpdateEditInput,
  IncidentUpdateInput,
  zId,
  type AdminIncident,
  type ImpactStatus,
} from '@openstatuspage/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { IdParams, parse, unique } from '../../lib/http.js';
import { collection, created, document, Included, noContent, selfLink } from '../../lib/jsonapi.js';
import { parseInclude, parseListQuery } from '../../lib/jsonapi-query.js';
import { nowIso, toIso } from '../../lib/time.js';
import { actorUserId } from '../../plugins/auth.js';
import { useJsonApi, withInclude } from '../../plugins/jsonapi.js';
import { adminIncidentResource, CATALOG_TYPES, incidentUpdateResource } from '../../serializers/catalog.js';
import { loadIncident, loadIncidents, nextUpdateTimestamp, toAdminIncident } from '../../services/incidents.js';
import { assertExist, auditRequest, editor } from './util.js';

const ListFilter = { status: z.enum(['active', 'resolved', 'all']).default('all') };
/** `include` paths of an incident document. */
const INCLUDES = { allowed: ['updates'], default: ['updates'] };
const IncidentParams = z.object({ incidentId: zId });
const UpdateParams = z.object({ incidentId: zId, id: zId });

async function getIncident(db: DB, id: string): Promise<AdminIncident> {
  const rec = await loadIncident(db, id);
  if (!rec) throw notFound('Incident');
  return toAdminIncident(rec);
}

async function validateAffected(db: DB, affected: { serviceId: string; status: ImpactStatus }[] | undefined) {
  if (!affected) return;
  const ids = affected.map((a) => a.serviceId);
  if (unique(ids).length !== ids.length) throw badRequest('A service can only be listed once');
  await assertExist(db, 'services', ids, 'service');
}

async function replaceAffected(trx: DB, incidentId: string, affected: { serviceId: string; status: ImpactStatus }[]) {
  await trx.deleteFrom('incident_services').where('incident_id', '=', incidentId).execute();
  if (affected.length > 0) {
    await trx
      .insertInto('incident_services')
      .values(affected.map((a) => ({ incident_id: incidentId, service_id: a.serviceId, status: a.status })))
      .execute();
  }
}

async function replaceLocations(trx: DB, incidentId: string, locationIds: string[]) {
  await trx.deleteFrom('incident_locations').where('incident_id', '=', incidentId).execute();
  const ids = unique(locationIds);
  if (ids.length > 0) {
    await trx
      .insertInto('incident_locations')
      .values(ids.map((location_id) => ({ incident_id: incidentId, location_id })))
      .execute();
  }
}

async function affectedServiceIds(db: DB, incidentId: string): Promise<string[]> {
  const rows = await db.selectFrom('incident_services').select('service_id').where('incident_id', '=', incidentId).execute();
  return rows.map((r) => r.service_id);
}

/** /api/admin/incidents (editor, JSON:API) */
export async function registerIncidentRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    useJsonApi(scope);
    await registerRoutes(scope);
  });
}

async function registerRoutes(app: FastifyInstance): Promise<void> {
  const { db, engine, notifications } = app.ctx;
  const incidentType = { config: { jsonapi: { type: CATALOG_TYPES.incident, include: true } } };
  const updateType = { config: { jsonapi: { type: CATALOG_TYPES.incidentUpdate } } };

  /** Incident document; its updates are included unless `include` says otherwise. */
  const incidentDocument = async (req: FastifyRequest, id: string) => {
    const include = parseInclude((req.query ?? {}) as Record<string, unknown>, INCLUDES.allowed, INCLUDES.default);
    const included = new Included();
    const res = adminIncidentResource(await getIncident(db, id), include.has('updates') ? included : undefined);
    return document(res, { included, links: { self: selfLink(req) } });
  };

  /** Document of one update with its incident included. */
  const updateDocument = async (req: FastifyRequest, incidentId: string, updateId: string) => {
    const incident = await getIncident(db, incidentId);
    const update = incident.updates.find((u) => u.id === updateId);
    if (!update) throw notFound('Incident update');
    return document(incidentUpdateResource(incidentId, update), {
      included: [adminIncidentResource(incident)],
      links: { self: selfLink(req) },
    });
  };

  app.get('/api/admin/incidents', { ...editor, ...withInclude }, async (req) => {
    const q = parseListQuery(req.query, { filter: ListFilter, include: INCLUDES });
    let base = db.selectFrom('incidents');
    if (q.filter.status === 'active') base = base.where('status', '!=', 'resolved');
    if (q.filter.status === 'resolved') base = base.where('status', '=', 'resolved');
    const [total, rows] = await Promise.all([
      base
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .executeTakeFirstOrThrow()
        .then((r) => Number(r.n)),
      base
        .select('id')
        .orderBy('started_at', 'desc')
        .orderBy('id', 'desc')
        .limit(q.page.size)
        .offset(q.page.offset)
        .execute(),
    ]);
    const records = await loadIncidents(
      db,
      rows.map((r) => r.id),
    );
    const included = new Included();
    const resources = records.map((r) => adminIncidentResource(toAdminIncident(r), q.include.has('updates') ? included : undefined));
    return collection(req, resources, { page: q.page, total, included });
  });

  app.post('/api/admin/incidents', { ...editor, ...incidentType }, async (req, reply) => {
    const input = parse(IncidentCreateInput, req.body);
    await validateAffected(db, input.affectedServices);
    await assertExist(db, 'locations', input.locationIds, 'location');
    const id = newId();
    const now = nowIso();
    const userId = actorUserId(req);
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('incidents')
        .values({
          id,
          title: input.title,
          status: input.status,
          impact: input.impact,
          is_public: input.isPublic ? 1 : 0,
          source: 'manual',
          started_at: input.startedAt ? toIso(input.startedAt) : now,
          resolved_at: input.status === 'resolved' ? now : null,
          created_by: userId,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await trx
        .insertInto('incident_updates')
        .values({ id: newId(), incident_id: id, status: input.status, message: input.message, created_by: userId, created_at: now })
        .execute();
      await replaceAffected(trx, id, input.affectedServices);
      await replaceLocations(trx, id, input.locationIds);
    });
    await engine.recompute(input.affectedServices.map((a) => a.serviceId));
    await auditRequest(db, req, 'incident.create', 'incident', id, {
      title: input.title,
      status: input.status,
      impact: input.impact,
    });
    if (input.notify && input.isPublic) {
      await notifications.safely('incident.create', () => notifications.incidentPosted(id, { isNew: true }));
    }
    return created(reply, await incidentDocument(req, id), `/api/admin/incidents/${id}`);
  });

  app.get('/api/admin/incidents/:id', { ...editor, ...withInclude }, async (req) => incidentDocument(req, parse(IdParams, req.params).id));

  app.patch('/api/admin/incidents/:id', { ...editor, ...incidentType }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const input = parse(IncidentPatchInput, req.body);
    const current = await db.selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Incident');
    await validateAffected(db, input.affectedServices);
    if (input.locationIds) await assertExist(db, 'locations', input.locationIds, 'location');

    const startedAt = input.startedAt ? toIso(input.startedAt) : current.started_at;
    let resolvedAt = current.resolved_at;
    if (input.resolvedAt !== undefined) {
      if (current.status !== 'resolved' || input.resolvedAt === null) {
        throw badRequest('resolvedAt can only be changed on resolved incidents; post an update to resolve or re-open');
      }
      resolvedAt = toIso(input.resolvedAt);
    }
    if (resolvedAt && resolvedAt < startedAt) throw badRequest('resolvedAt must not be before startedAt');

    const before = await affectedServiceIds(db, id);
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('incidents')
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.impact !== undefined ? { impact: input.impact } : {}),
          ...(input.isPublic !== undefined ? { is_public: input.isPublic ? 1 : 0 } : {}),
          started_at: startedAt,
          resolved_at: resolvedAt,
          updated_at: nowIso(),
        })
        .where('id', '=', id)
        .execute();
      if (input.affectedServices) await replaceAffected(trx, id, input.affectedServices);
      if (input.locationIds) await replaceLocations(trx, id, input.locationIds);
    });
    await engine.recompute([...before, ...(input.affectedServices?.map((a) => a.serviceId) ?? [])]);
    await auditRequest(db, req, 'incident.update', 'incident', id, { fields: Object.keys(input) });
    return incidentDocument(req, id);
  });

  app.delete('/api/admin/incidents/:id', editor, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const current = await db.selectFrom('incidents').select(['title']).where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Incident');
    const before = await affectedServiceIds(db, id);
    await db.deleteFrom('incidents').where('id', '=', id).execute();
    await engine.recompute(before);
    await auditRequest(db, req, 'incident.delete', 'incident', id, { title: current.title });
    return noContent(reply);
  });

  // Posting an update creates an incident-updates resource and moves the incident to its status.
  app.post('/api/admin/incidents/:incidentId/updates', { ...editor, ...updateType }, async (req, reply) => {
    const { incidentId: id } = parse(IncidentParams, req.params);
    const input = parse(IncidentUpdateInput, req.body);
    const current = await db.selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Incident');
    await validateAffected(db, input.affectedServices);
    const now = await nextUpdateTimestamp(db, 'incident_updates', id);
    const before = await affectedServiceIds(db, id);
    const updateId = newId();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('incident_updates')
        .values({
          id: updateId,
          incident_id: id,
          status: input.status,
          message: input.message,
          created_by: actorUserId(req),
          created_at: now,
        })
        .execute();
      await trx
        .updateTable('incidents')
        .set({
          status: input.status,
          // Resolving sets resolved_at once; any other status re-opens the incident.
          resolved_at: input.status === 'resolved' ? (current.resolved_at ?? now) : null,
          updated_at: now,
        })
        .where('id', '=', id)
        .execute();
      if (input.affectedServices) await replaceAffected(trx, id, input.affectedServices);
    });
    await engine.recompute([...before, ...(input.affectedServices?.map((a) => a.serviceId) ?? [])]);
    await auditRequest(db, req, 'incident.update_posted', 'incident', id, { status: input.status });
    if (input.notify && current.is_public === 1) {
      await notifications.safely('incident.update', () => notifications.incidentPosted(id, { isNew: false }));
    }
    const location = `/api/admin/incidents/${id}/updates/${updateId}`;
    return created(reply, await updateDocument(req, id, updateId), location);
  });

  app.get('/api/admin/incidents/:incidentId/updates/:id', editor, async (req) => {
    const { incidentId, id } = parse(UpdateParams, req.params);
    return updateDocument(req, incidentId, id);
  });

  app.patch('/api/admin/incidents/:incidentId/updates/:id', { ...editor, ...updateType }, async (req) => {
    const { incidentId: id, id: updateId } = parse(UpdateParams, req.params);
    const { message } = parse(IncidentUpdateEditInput, req.body);
    const result = await db
      .updateTable('incident_updates')
      .set({ message })
      .where('id', '=', updateId)
      .where('incident_id', '=', id)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw notFound('Incident update');
    await db.updateTable('incidents').set({ updated_at: nowIso() }).where('id', '=', id).execute();
    await auditRequest(db, req, 'incident.update_edit', 'incident', id, { updateId });
    return updateDocument(req, id, updateId);
  });

  app.delete('/api/admin/incidents/:incidentId/updates/:id', editor, async (req, reply) => {
    const { incidentId: id, id: updateId } = parse(UpdateParams, req.params);
    const updates = await db.selectFrom('incident_updates').select('id').where('incident_id', '=', id).execute();
    if (!updates.some((u) => u.id === updateId)) throw notFound('Incident update');
    if (updates.length === 1) throw conflict('An incident needs at least one update');
    await db.deleteFrom('incident_updates').where('id', '=', updateId).execute();
    await db.updateTable('incidents').set({ updated_at: nowIso() }).where('id', '=', id).execute();
    await auditRequest(db, req, 'incident.update_delete', 'incident', id, { updateId });
    return noContent(reply);
  });
}
