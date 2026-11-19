import { TestEmailInput, type AdminSubscriber } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { notFound } from '../../lib/errors.js';
import { IdParams, parse } from '../../lib/http.js';
import { collection, document, Included, metaDocument, noContent, selfLink } from '../../lib/jsonapi.js';
import { parseListQuery } from '../../lib/jsonapi-query.js';
import { useJsonApi } from '../../plugins/jsonapi.js';
import { notificationStatusResource, subscriberResource } from '../../serializers/auth-users.js';
import { deleteSubscriber, maskEmail } from '../../services/subscriptions.js';
import { admin, auditRequest } from './util.js';

/** Escapes LIKE wildcards; used with `ESCAPE '\'` (portable across SQLite and PostgreSQL). */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Filters of GET /api/admin/subscribers: `filter[q]` (substring of the address) and `filter[status]`. */
const SubscriberFilter = {
  q: z.string().max(254).optional(),
  status: z.enum(['all', 'confirmed', 'pending']).default('all'),
};

/** /api/admin/subscribers and /api/admin/notifications/* (admin, JSON:API) */
export async function registerSubscriberRoutes(app: FastifyInstance): Promise<void> {
  await app.register(registerSubscriberScope);
}

async function registerSubscriberScope(app: FastifyInstance): Promise<void> {
  useJsonApi(app);
  const { db, notifications } = app.ctx;

  app.get('/api/admin/subscribers', admin, async (req) => {
    const { page, filter } = parseListQuery(req.query, { page: { defaultSize: 50, maxSize: 100 }, filter: SubscriberFilter });
    let base = db.selectFrom('subscribers');
    if (filter.q?.trim()) {
      const pattern = likePattern(filter.q.trim().toLowerCase());
      base = base.where(sql<boolean>`email like ${pattern} escape '\\'`);
    }
    if (filter.status === 'confirmed') base = base.where('confirmed_at', 'is not', null);
    if (filter.status === 'pending') base = base.where('confirmed_at', 'is', null);

    const [total, rows] = await Promise.all([
      base
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .executeTakeFirstOrThrow()
        .then((r) => Number(r.n)),
      base
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(page.size)
        .offset(page.offset)
        .execute(),
    ]);

    const ids = rows.filter((r) => r.all_services !== 1).map((r) => r.id);
    const services = ids.length
      ? await db
          .selectFrom('subscriber_services')
          .innerJoin('services', 'services.id', 'subscriber_services.service_id')
          .select(['subscriber_services.subscriber_id', 'services.id', 'services.name'])
          .where('subscriber_services.subscriber_id', 'in', ids)
          .orderBy('services.sort_order')
          .orderBy('services.name')
          .execute()
      : [];

    const items: AdminSubscriber[] = rows.map((r) => ({
      id: r.id,
      email: r.email,
      locale: r.locale,
      allServices: r.all_services === 1,
      services: services.filter((s) => s.subscriber_id === r.id).map((s) => ({ id: s.id, name: s.name })),
      confirmed: r.confirmed_at !== null,
      createdAt: r.created_at,
      confirmedAt: r.confirmed_at,
    }));
    const included = new Included();
    return collection(req, items.map((item) => subscriberResource(item, included)), { page, total, included });
  });

  app.delete('/api/admin/subscribers/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const row = await db.selectFrom('subscribers').select(['email']).where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound('Subscriber');
    await deleteSubscriber(db, id);
    await auditRequest(db, req, 'subscriber.delete', 'subscriber', id, { email: maskEmail(row.email) });
    return noContent(reply);
  });

  app.get('/api/admin/notifications/status', admin, async (req) =>
    document(notificationStatusResource(await notifications.status()), { links: { self: selfLink(req) } }),
  );

  // Actions: the results are meta-only documents.

  app.post('/api/admin/notifications/test', admin, async (req) => {
    const { to } = parse(TestEmailInput, req.body);
    const result = await notifications.sendTest(to.trim());
    await auditRequest(db, req, 'notifications.test', 'notifications', null, { to: maskEmail(to), ok: result.ok });
    return metaDocument(result);
  });

  app.post('/api/admin/notifications/retry-failed', admin, async (req) => {
    const requeued = await notifications.retryFailed();
    await auditRequest(db, req, 'notifications.retry_failed', 'notifications', null, { requeued });
    return metaDocument({ requeued });
  });
}
