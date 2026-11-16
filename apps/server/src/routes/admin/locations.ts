import { LocationInput, ReorderInput, ServiceGroupInput, type AdminLocation } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { IdParams, parse } from '../../lib/http.js';
import { nowIso } from '../../lib/time.js';
import { loadAdminLocations, toAdminGroup } from '../../services/admin-catalog.js';
import { resolveSlug } from '../../services/slugs.js';
import { admin, applyOrder, assertExist, auditRequest, editor } from './util.js';

async function getLocation(app: FastifyInstance, id: string): Promise<AdminLocation> {
  const [loc] = await loadAdminLocations(app.ctx.db, [id]);
  if (!loc) throw notFound('Location');
  return loc;
}

function locationValues(input: LocationInput) {
  return {
    name: input.name,
    code: input.code ?? null,
    city: input.city ?? null,
    country: input.country ?? null,
    region: input.region,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    description: input.description ?? null,
    sort_order: input.sortOrder,
    is_public: input.isPublic ? 1 : 0,
    status_override: input.statusOverride ?? null,
  };
}

/** /api/admin/locations and /api/admin/service-groups */
export async function registerLocationAndGroupRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  // --- Locations ---------------------------------------------------------------

  app.get('/api/admin/locations', editor, async () => loadAdminLocations(db));

  app.post('/api/admin/locations', admin, async (req, reply) => {
    const input = parse(LocationInput, req.body);
    const id = newId();
    const now = nowIso();
    const slug = await resolveSlug(db, 'locations', { slug: input.slug, name: input.name });
    await db
      .insertInto('locations')
      .values({ id, slug, ...locationValues(input), created_at: now, updated_at: now })
      .execute();
    await auditRequest(db, req, 'location.create', 'location', id, { name: input.name });
    return reply.status(201).send(await getLocation(app, id));
  });

  // Registered before /:id so "reorder" is not taken as an id.
  app.post('/api/admin/locations/reorder', admin, async (req, reply) => {
    const { ids } = parse(ReorderInput, req.body);
    await assertExist(db, 'locations', ids, 'location');
    await applyOrder(db, 'locations', ids);
    await auditRequest(db, req, 'location.reorder', 'location', null, { ids });
    return reply.status(204).send();
  });

  app.get('/api/admin/locations/:id', editor, async (req) => getLocation(app, parse(IdParams, req.params).id));

  app.put('/api/admin/locations/:id', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    const input = parse(LocationInput, req.body);
    const current = await db.selectFrom('locations').select(['slug']).where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Location');
    const slug = await resolveSlug(db, 'locations', {
      slug: input.slug,
      name: input.name,
      excludeId: id,
      currentSlug: current.slug,
    });
    await db
      .updateTable('locations')
      .set({ slug, ...locationValues(input), updated_at: nowIso() })
      .where('id', '=', id)
      .execute();
    await auditRequest(db, req, 'location.update', 'location', id, { name: input.name });
    return getLocation(app, id);
  });

  app.delete('/api/admin/locations/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const loc = await db.selectFrom('locations').select(['name']).where('id', '=', id).executeTakeFirst();
    if (!loc) throw notFound('Location');
    // Links to services, incidents and maintenance are removed by ON DELETE CASCADE.
    await db.deleteFrom('locations').where('id', '=', id).execute();
    await auditRequest(db, req, 'location.delete', 'location', id, { name: loc.name });
    return reply.status(204).send();
  });

  // --- Service groups ----------------------------------------------------------

  const getGroup = async (id: string) => {
    const g = await db.selectFrom('service_groups').selectAll().where('id', '=', id).executeTakeFirst();
    if (!g) throw notFound('Service group');
    return toAdminGroup(g);
  };

  app.get('/api/admin/service-groups', editor, async () => {
    const rows = await db.selectFrom('service_groups').selectAll().orderBy('sort_order').orderBy('name').execute();
    return rows.map(toAdminGroup);
  });

  app.post('/api/admin/service-groups', admin, async (req, reply) => {
    const input = parse(ServiceGroupInput, req.body);
    const id = newId();
    const now = nowIso();
    const slug = await resolveSlug(db, 'service_groups', { slug: input.slug, name: input.name });
    await db
      .insertInto('service_groups')
      .values({
        id,
        slug,
        name: input.name,
        description: input.description ?? null,
        sort_order: input.sortOrder,
        is_public: input.isPublic ? 1 : 0,
        collapsed_by_default: input.collapsedByDefault ? 1 : 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await auditRequest(db, req, 'service_group.create', 'service_group', id, { name: input.name });
    return reply.status(201).send(await getGroup(id));
  });

  app.post('/api/admin/service-groups/reorder', admin, async (req, reply) => {
    const { ids } = parse(ReorderInput, req.body);
    await assertExist(db, 'service_groups', ids, 'service group');
    await applyOrder(db, 'service_groups', ids);
    await auditRequest(db, req, 'service_group.reorder', 'service_group', null, { ids });
    return reply.status(204).send();
  });

  app.get('/api/admin/service-groups/:id', editor, async (req) => getGroup(parse(IdParams, req.params).id));

  app.put('/api/admin/service-groups/:id', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    const input = parse(ServiceGroupInput, req.body);
    const current = await getGroup(id);
    const slug = await resolveSlug(db, 'service_groups', {
      slug: input.slug,
      name: input.name,
      excludeId: id,
      currentSlug: current.slug,
    });
    await db
      .updateTable('service_groups')
      .set({
        slug,
        name: input.name,
        description: input.description ?? null,
        sort_order: input.sortOrder,
        is_public: input.isPublic ? 1 : 0,
        collapsed_by_default: input.collapsedByDefault ? 1 : 0,
        updated_at: nowIso(),
      })
      .where('id', '=', id)
      .execute();
    await auditRequest(db, req, 'service_group.update', 'service_group', id, { name: input.name });
    return getGroup(id);
  });

  app.delete('/api/admin/service-groups/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const group = await getGroup(id);
    // services.group_id is set to NULL by the foreign key (ON DELETE SET NULL).
    await db.deleteFrom('service_groups').where('id', '=', id).execute();
    await auditRequest(db, req, 'service_group.delete', 'service_group', id, { name: group.name });
    return reply.status(204).send();
  });
}
