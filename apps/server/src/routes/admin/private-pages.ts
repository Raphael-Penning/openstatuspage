/**
 * /api/admin/private-pages (admin, JSON:API): private status pages at /p/<token>.
 *
 *   GET    /api/admin/private-pages
 *   POST   /api/admin/private-pages                          → with `token` and `url` (once)
 *   GET    /api/admin/private-pages/:id
 *   PATCH  /api/admin/private-pages/:id                      partial update
 *   DELETE /api/admin/private-pages/:id
 *   POST   /api/admin/private-pages/:id/regenerate-token     → with the new `token` and `url`; the old link stops working
 *
 * The token is generated here, returned only in the two answers above and
 * stored as its SHA-256 hash. It is never written to the audit log.
 */
import { PrivatePageInput, type AdminPrivatePage } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../db/types.js';
import { notFound } from '../../lib/errors.js';
import { IdParams, parse, unique } from '../../lib/http.js';
import { newId } from '../../lib/ids.js';
import { created, document, noContent, collection, selfLink } from '../../lib/jsonapi.js';
import { nowIso } from '../../lib/time.js';
import { useJsonApi } from '../../plugins/jsonapi.js';
import { owningUserId } from '../../plugins/auth.js';
import { adminPrivatePageResource, CATALOG_TYPES } from '../../serializers/catalog.js';
import { privatePageTokenHash } from '../../services/private-page-store.js';
import { loadAdminPrivatePages, newPrivatePageToken, privatePageUrl } from '../../services/private-pages.js';
import { admin, assertExist, auditRequest } from './util.js';

const asObject = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

/** Expiry as stored: UTC ISO 8601, so the database compares it as text (null: never). */
const expiry = (value: string | null | undefined) => (value ? new Date(value).toISOString() : null);

async function setServices(db: Kysely<Database> | Transaction<Database>, pageId: string, serviceIds: string[]): Promise<void> {
  await db.deleteFrom('private_page_services').where('page_id', '=', pageId).execute();
  if (serviceIds.length === 0) return;
  await db
    .insertInto('private_page_services')
    .values(serviceIds.map((serviceId, index) => ({ page_id: pageId, service_id: serviceId, sort_order: index })))
    .execute();
}

export async function registerPrivatePageRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    useJsonApi(scope);
    // Answers can carry a token: never stored by a cache.
    scope.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });
    registerRoutes(scope);
  });
}

function registerRoutes(app: FastifyInstance): void {
  const { db, config } = app.ctx;
  const typed = { ...admin, config: { jsonapi: { type: CATALOG_TYPES.privatePage, relationships: { services: CATALOG_TYPES.service } } } };

  const get = async (id: string): Promise<AdminPrivatePage> => {
    const [page] = await loadAdminPrivatePages(db, [id]);
    if (!page) throw notFound('Private page');
    return page;
  };
  /** The page with its new link (only in the answer that made it). */
  const withLink = (page: AdminPrivatePage, token: string): AdminPrivatePage => ({
    ...page,
    token,
    url: privatePageUrl(config.PUBLIC_BASE_URL, token),
  });

  app.get('/api/admin/private-pages', admin, async (req) => collection(req, (await loadAdminPrivatePages(db)).map(adminPrivatePageResource)));

  app.post('/api/admin/private-pages', typed, async (req, reply) => {
    const input = parse(PrivatePageInput, req.body);
    const serviceIds = await assertExist(db, 'services', unique(input.serviceIds), 'service');
    const id = newId();
    const token = newPrivatePageToken();
    const now = nowIso();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('private_pages')
        .values({
          id,
          name: input.name,
          description: input.description || null,
          token_hash: privatePageTokenHash(token),
          token_created_at: now,
          expires_at: expiry(input.expiresAt),
          enabled: input.enabled ? 1 : 0,
          created_by: owningUserId(req),
          created_at: now,
          updated_at: now,
        })
        .execute();
      await setServices(trx, id, serviceIds);
    });
    await auditRequest(db, req, 'private_page.create', 'private_page', id, { name: input.name, services: serviceIds.length });
    const body = adminPrivatePageResource(withLink(await get(id), token));
    return created(reply, document(body, { links: { self: selfLink(req) } }), `/api/admin/private-pages/${id}`);
  });

  app.get('/api/admin/private-pages/:id', admin, async (req) =>
    document(adminPrivatePageResource(await get(parse(IdParams, req.params).id)), { links: { self: selfLink(req) } }),
  );

  // Partial update: missing attributes keep their current values. The link stays the same.
  app.patch('/api/admin/private-pages/:id', typed, async (req) => {
    const { id } = parse(IdParams, req.params);
    const current = await get(id);
    const input = parse(PrivatePageInput, {
      name: current.name,
      description: current.description,
      serviceIds: current.serviceIds,
      expiresAt: current.expiresAt,
      enabled: current.enabled,
      ...asObject(req.body),
    });
    const serviceIds = await assertExist(db, 'services', unique(input.serviceIds), 'service');
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('private_pages')
        .set({
          name: input.name,
          description: input.description || null,
          expires_at: expiry(input.expiresAt),
          enabled: input.enabled ? 1 : 0,
          updated_at: nowIso(),
        })
        .where('id', '=', id)
        .execute();
      await setServices(trx, id, serviceIds);
    });
    await auditRequest(db, req, 'private_page.update', 'private_page', id, { name: input.name, services: serviceIds.length });
    return document(adminPrivatePageResource(await get(id)), { links: { self: selfLink(req) } });
  });

  app.delete('/api/admin/private-pages/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const page = await get(id);
    // Its services are removed by ON DELETE CASCADE.
    await db.deleteFrom('private_pages').where('id', '=', id).execute();
    await auditRequest(db, req, 'private_page.delete', 'private_page', id, { name: page.name });
    return noContent(reply);
  });

  // A new link; the old one stops working at once.
  app.post('/api/admin/private-pages/:id/regenerate-token', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    const token = newPrivatePageToken();
    const now = nowIso();
    const result = await db
      .updateTable('private_pages')
      .set({ token_hash: privatePageTokenHash(token), token_created_at: now, updated_at: now })
      .where('id', '=', id)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw notFound('Private page');
    const page = await get(id);
    await auditRequest(db, req, 'private_page.regenerate_token', 'private_page', id, { name: page.name });
    return document(adminPrivatePageResource(withLink(page, token)), { links: { self: `/api/admin/private-pages/${id}` } });
  });
}
