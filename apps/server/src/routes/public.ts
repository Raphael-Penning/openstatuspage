/**
 * /api/public: unauthenticated read API for the public status page (JSON:API 1.1).
 *
 * The documents are built by services/public-documents.ts, which server-side
 * rendering of the public pages (ssr/source.ts) calls in-process as well. Only
 * public entities are returned; nothing about monitoring sources or checks is
 * ever exposed here.
 *
 * The feeds are not JSON:API (stable formats for feed readers).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/http.js';
import { useJsonApi, withInclude } from '../plugins/jsonapi.js';
import { PublicDocuments } from '../services/public-documents.js';
import { registerFeedRoutes } from './feeds.js';

const IdOrSlugParams = z.object({ idOrSlug: z.string().min(1).max(100) });
const IdParams = z.object({ id: z.string().min(1).max(64) });
/** The day is validated by the document builder (400 malformed, 404 outside the uptime range). */
const ServiceDayParams = IdOrSlugParams.extend({ date: z.string().min(1).max(32) });

const cacheHeaders = (scope: FastifyInstance) =>
  scope.addHook('onSend', async (req, reply, payload) => {
    if (req.method === 'GET' && reply.statusCode === 200) {
      reply.header('cache-control', 'public, max-age=30');
    }
    return payload;
  });

export async function registerPublicRoutes(app: FastifyInstance): Promise<void> {
  const docs = new PublicDocuments(app.ctx.db, app.ctx.mailer, { analytics: Boolean(app.ctx.config.UMAMI_URL) });

  // JSON:API routes.
  await app.register(async (scope) => {
    useJsonApi(scope);
    cacheHeaders(scope);

    scope.get('/api/public/settings', (req) => docs.settings(req));
    scope.get('/api/public/summary', (req) => docs.summary(req));
    scope.get('/api/public/status', (req) => docs.status(req));
    scope.get('/api/public/services', (req) => docs.services(req));
    scope.get('/api/public/services/:idOrSlug', withInclude, (req) =>
      docs.service(req, parse(IdOrSlugParams, req.params).idOrSlug),
    );
    scope.get('/api/public/services/:idOrSlug/days/:date', withInclude, (req) => {
      const params = parse(ServiceDayParams, req.params);
      return docs.serviceDay(req, params.idOrSlug, params.date);
    });
    scope.get('/api/public/locations', (req) => docs.locations(req));
    scope.get('/api/public/incidents/:id', withInclude, (req) => docs.incident(req, parse(IdParams, req.params).id));
    scope.get('/api/public/maintenances/:id', withInclude, (req) => docs.maintenance(req, parse(IdParams, req.params).id));
    scope.get('/api/public/history', withInclude, (req) => docs.history(req));
  });

  // Feeds (not JSON:API).
  await app.register(async (scope) => {
    cacheHeaders(scope);

    await registerFeedRoutes(scope);
  });
}
