import { ReorderInput, ServiceInput, type AdminService, type ServiceStatus } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { IdParams, parse, unique } from '../../lib/http.js';
import { collection, created, document, metaDocument, noContent, selfLink } from '../../lib/jsonapi.js';
import { nowIso } from '../../lib/time.js';
import { useJsonApi } from '../../plugins/jsonapi.js';
import { adminServiceResource, CATALOG_TYPES } from '../../serializers/catalog.js';
import { loadAdminServices } from '../../services/admin-catalog.js';
import { resolveSlug } from '../../services/slugs.js';
import { aggregateMonitorStatus, type CheckLinkState } from '../../services/status-rules.js';
import { admin, applyOrder, assertExist, auditRequest, editor } from './util.js';

async function getService(db: DB, id: string): Promise<AdminService> {
  const [svc] = await loadAdminServices(db, [id]);
  if (!svc) throw notFound('Service');
  return svc;
}

/** Validates all references of a service input. */
async function validateReferences(db: DB, input: ServiceInput): Promise<void> {
  if (input.groupId) await assertExist(db, 'service_groups', [input.groupId], 'service group');
  await assertExist(db, 'locations', input.locationIds, 'location');
  const checkIds = input.checks.map((c) => c.checkId);
  if (unique(checkIds).length !== checkIds.length) throw badRequest('A check can only be linked once per service');
  await assertExist(db, 'monitor_checks', checkIds, 'check');
}

function serviceValues(input: ServiceInput) {
  return {
    name: input.name,
    description: input.description ?? null,
    kind: input.kind,
    url: input.url ?? null,
    group_id: input.groupId ?? null,
    sort_order: input.sortOrder,
    is_public: input.isPublic ? 1 : 0,
    status_mode: input.statusMode,
    manual_status: input.manualStatus,
    aggregation: input.aggregation,
  };
}

/** Replaces location and check links of a service (inside a transaction). */
async function replaceLinks(trx: DB, serviceId: string, input: ServiceInput): Promise<void> {
  await trx.deleteFrom('service_locations').where('service_id', '=', serviceId).execute();
  await trx.deleteFrom('service_checks').where('service_id', '=', serviceId).execute();
  const locationIds = unique(input.locationIds);
  if (locationIds.length > 0) {
    await trx
      .insertInto('service_locations')
      .values(locationIds.map((location_id) => ({ service_id: serviceId, location_id })))
      .execute();
  }
  if (input.checks.length > 0) {
    await trx
      .insertInto('service_checks')
      .values(
        input.checks.map((c) => ({
          service_id: serviceId,
          check_id: c.checkId,
          warning_status: c.warningStatus,
          critical_status: c.criticalStatus,
          unknown_status: c.unknownStatus,
        })),
      )
      .execute();
  }
}

/** Current states of checks of enabled sources (disabled sources do not influence the status). */
async function checkStates(db: DB, checkIds: string[]): Promise<Map<string, CheckLinkState['state']>> {
  if (checkIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('monitor_checks')
    .innerJoin('monitor_sources', 'monitor_sources.id', 'monitor_checks.source_id')
    .select(['monitor_checks.id', 'monitor_checks.state'])
    .where('monitor_checks.id', 'in', checkIds)
    .where('monitor_sources.enabled', '=', 1)
    .execute();
  return new Map(rows.map((r) => [r.id, r.state]));
}

async function previewMonitorStatus(db: DB, input: ServiceInput): Promise<ServiceStatus> {
  const states = await checkStates(
    db,
    input.checks.map((c) => c.checkId),
  );
  const links: CheckLinkState[] = input.checks.flatMap((c) => {
    const state = states.get(c.checkId);
    return state
      ? [{ state, warningStatus: c.warningStatus, criticalStatus: c.criticalStatus, unknownStatus: c.unknownStatus }]
      : [];
  });
  return aggregateMonitorStatus(input.aggregation, links);
}

const asObject = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

/** /api/admin/services (JSON:API) */
export async function registerServiceRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    useJsonApi(scope);
    await registerRoutes(scope);
  });
}

async function registerRoutes(app: FastifyInstance): Promise<void> {
  const { db, engine } = app.ctx;
  const serviceType = { config: { jsonapi: { type: CATALOG_TYPES.service } } };
  const serviceDocument = async (req: { url: string }, id: string) =>
    document(adminServiceResource(await getService(db, id)), { links: { self: req.url } });

  app.get('/api/admin/services', editor, async (req) => collection(req, (await loadAdminServices(db)).map(adminServiceResource)));

  app.post('/api/admin/services', { ...admin, ...serviceType }, async (req, reply) => {
    const input = parse(ServiceInput, req.body);
    await validateReferences(db, input);
    const id = newId();
    const now = nowIso();
    const slug = await resolveSlug(db, 'services', { slug: input.slug, name: input.name });
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('services')
        .values({
          id,
          slug,
          ...serviceValues(input),
          current_status: 'operational',
          monitor_status: 'operational',
          status_changed_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await replaceLinks(trx, id, input);
    });
    await engine.recompute([id]);
    await auditRequest(db, req, 'service.create', 'service', id, {
      name: input.name,
      checks: input.checks.length,
      locations: input.locationIds.length,
    });
    return created(reply, await serviceDocument(req, id), `/api/admin/services/${id}`);
  });

  app.post('/api/admin/services/reorder', admin, async (req, reply) => {
    const { ids } = parse(ReorderInput, req.body);
    const list = await assertExist(db, 'services', ids, 'service');
    const groups = await db.selectFrom('services').select('group_id').distinct().where('id', 'in', list).execute();
    if (groups.length > 1) throw badRequest('All services must belong to the same group');
    await applyOrder(db, 'services', list);
    await auditRequest(db, req, 'service.reorder', 'service', null, { ids: list });
    return noContent(reply);
  });

  app.post('/api/admin/services/preview', admin, async (req) => {
    const input = parse(ServiceInput, req.body);
    return metaDocument({ monitorStatus: await previewMonitorStatus(db, input) });
  });

  app.get('/api/admin/services/:id', editor, async (req) => serviceDocument(req, parse(IdParams, req.params).id));

  app.get('/api/admin/services/:id/preview', editor, async (req) => {
    const svc = await getService(db, parse(IdParams, req.params).id);
    const monitorStatus = await previewMonitorStatus(db, {
      ...ServiceInput.parse({ name: svc.name, aggregation: svc.aggregation }),
      checks: svc.checks.map((c) => ({
        checkId: c.checkId,
        warningStatus: c.warningStatus,
        criticalStatus: c.criticalStatus,
        unknownStatus: c.unknownStatus,
      })),
    });
    return metaDocument({ monitorStatus, status: svc.status }, { self: selfLink(req) });
  });

  // Partial update: missing attributes and relationships keep their current values.
  app.patch('/api/admin/services/:id', { ...admin, ...serviceType }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const current = await getService(db, id);
    const input = parse(ServiceInput, { ...current, ...asObject(req.body) });
    await validateReferences(db, input);
    const slug = await resolveSlug(db, 'services', {
      slug: input.slug,
      name: input.name,
      excludeId: id,
      currentSlug: current.slug,
    });
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('services')
        .set({ slug, ...serviceValues(input), updated_at: nowIso() })
        .where('id', '=', id)
        .execute();
      await replaceLinks(trx, id, input);
    });
    await engine.recompute([id]);
    await auditRequest(db, req, 'service.update', 'service', id, {
      name: input.name,
      statusMode: input.statusMode,
      ...(input.statusMode === 'manual' ? { manualStatus: input.manualStatus } : {}),
      checks: input.checks.length,
    });
    return serviceDocument(req, id);
  });

  app.delete('/api/admin/services/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const svc = await db.selectFrom('services').select(['name']).where('id', '=', id).executeTakeFirst();
    if (!svc) throw notFound('Service');
    // Links, history and incident/maintenance/correction associations cascade.
    const deletedCorrections = await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('services').where('id', '=', id).execute();
      // Corrections left without any service have no effect any more: remove them.
      const orphans = await trx
        .selectFrom('status_corrections')
        .select('id')
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('status_correction_services')
                .select('status_correction_services.correction_id')
                .whereRef('status_correction_services.correction_id', '=', 'status_corrections.id'),
            ),
          ),
        )
        .execute();
      const ids = orphans.map((o) => o.id);
      if (ids.length > 0) await trx.deleteFrom('status_corrections').where('id', 'in', ids).execute();
      return ids;
    });
    await auditRequest(db, req, 'service.delete', 'service', id, {
      name: svc.name,
      ...(deletedCorrections.length > 0 ? { deletedCorrections } : {}),
    });
    return noContent(reply);
  });
}
