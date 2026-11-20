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
import { PRIVATE_PAGE_TOKEN_HEADER } from '@openstatuspage/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/http.js';
import { useJsonApi, withInclude } from '../plugins/jsonapi.js';
import { PrivatePageDocuments } from '../services/private-page-documents.js';
import { createPrivatePages } from '../services/private-pages.js';
import { PublicDocuments } from '../services/public-documents.js';
import { registerFeedRoutes } from './feeds.js';

const IdOrSlugParams = z.object({ idOrSlug: z.string().min(1).max(100) });
const IdParams = z.object({ id: z.string().min(1).max(64) });
/** The day is validated by the document builder (400 malformed, 404 outside the uptime range). */
const ServiceDayParams = IdOrSlugParams.extend({ date: z.string().min(1).max(32) });

/** Requests per minute and client to private pages (API and HTML), against guessing tokens. */
export const PRIVATE_PAGE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' };

/** The token of the X-Private-Page-Token header ('' when missing: answered like a wrong one). */
function privatePageToken(req: FastifyRequest): string {
  const value = req.headers[PRIVATE_PAGE_TOKEN_HEADER];
  return typeof value === 'string' && value.length <= 64 ? value : '';
}

const cacheHeaders =(scope: FastifyInstance) =>
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

  // Private pages (/p/<token>): the token comes in the X-Private-Page-Token header, never in
  // the URL. Every token problem is the same 404; rate limited against guessing.
  const privateDocs = new PrivatePageDocuments(createPrivatePages(app.ctx.db, app.ctx.config));
  await app.register(async (scope) => {
    useJsonApi(scope);
    scope.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      return payload;
    });
    const limited = { rateLimit: PRIVATE_PAGE_RATE_LIMIT };
    const withIncludeLimited = { config: { ...limited, jsonapi: { include: true } } };
    scope.get('/api/public/private-page', { config: limited }, (req) => privateDocs.page(req, privatePageToken(req)));
    scope.get('/api/public/private-page/services/:idOrSlug', withIncludeLimited, (req) =>
      privateDocs.service(req, privatePageToken(req), parse(IdOrSlugParams, req.params).idOrSlug),
    );
    scope.get('/api/public/private-page/services/:idOrSlug/days/:date', withIncludeLimited, (req) => {
      const params = parse(ServiceDayParams, req.params);
      return privateDocs.day(req, privatePageToken(req), params.idOrSlug, params.date);
    });
  });

  // Feeds (not JSON:API).
  await app.register(async (scope) => {
    cacheHeaders(scope);

    await registerFeedRoutes(scope);
  });
}
