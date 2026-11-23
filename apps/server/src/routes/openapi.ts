/**
 * GET /api/openapi.json: the OpenAPI 3.1 description of the HTTP API
 * (src/openapi), on every role with an API (not on worker instances).
 *
 * What it reveals follows the role (conservative):
 * - anonymous clients, and every client of an APP_ROLE=public instance, get the
 *   public part only (public read API, private pages, subscriptions, feeds and
 *   images): what such an instance serves anyway;
 * - a signed-in user or an API token (editor or admin) on an `admin` or `all`
 *   instance gets the whole API, as `private` (the answer differs by credentials).
 *
 * The document is built on the first request (the module is loaded lazily, so
 * instances that are never asked keep none of it in memory) and kept as a
 * string with a strong ETag; `If-None-Match` is answered with 304.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OpenApiScope } from '../openapi/document.js';
import { roleFeatures } from '../role.js';

export const OPENAPI_PATH = '/api/openapi.json';

interface Built {
  body: string;
  etag: string;
}

/** True when the `If-None-Match` header names `etag` (or `*`). */
function matches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((v) => v.trim().replace(/^W\//, ''))
    .some((v) => v === etag || v === '*');
}

export async function registerOpenApiRoute(app: FastifyInstance): Promise<void> {
  const fullAvailable = roleFeatures(app.ctx.config.APP_ROLE).adminApi;
  const cache = new Map<OpenApiScope, Promise<Built>>();

  const build = (scope: OpenApiScope): Promise<Built> => {
    let built = cache.get(scope);
    if (!built) {
      built = import('../openapi/document.js').then(({ buildOpenApiDocument }) => {
        const body = JSON.stringify(buildOpenApiDocument(scope));
        return { body, etag: `"${createHash('sha256').update(body).digest('base64url')}"` };
      });
      cache.set(scope, built);
      built.catch(() => cache.delete(scope));
    }
    return built;
  };

  app.get(OPENAPI_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
    // req.authUser is resolved for this path only where the admin API exists (plugins/auth.ts).
    const scope: OpenApiScope = fullAvailable && req.authUser ? 'full' : 'public';
    const { body, etag } = await build(scope);
    // Where the whole API can be described the answer depends on the credentials (and may
    // refresh or clear the session cookie): never stored by shared caches there.
    reply
      .header('ETag', etag)
      .header('Cache-Control', fullAvailable ? 'private, no-cache' : 'public, no-cache')
      .header('X-Robots-Tag', 'noindex');
    if (fullAvailable) reply.header('Vary', 'Cookie, Authorization');
    if (matches(req.headers['if-none-match'], etag)) return reply.status(304).send();
    return reply.type('application/json').send(body);
  });
}
