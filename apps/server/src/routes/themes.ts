/**
 * GET /theme/<hash>.css: the stylesheets of the active theme (tokens and the
 * extra CSS, services/themes.ts), on every role that serves the public pages.
 *
 * The name is a hash of the content, so a URL never changes its content:
 * cached for a year as immutable. Same origin, a separate file, never inline:
 * the pages keep their Content-Security-Policy. A preview stylesheet (a theme
 * that is not active, ?theme=<id>) is only answered to a signed-in admin and
 * never stored by shared caches.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { notFound } from '../lib/errors.js';
import { hasRole } from '../plugins/auth.js';
import { resolveSession, SESSION_COOKIE } from '../services/sessions.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const PREVIEW = 'private, no-store';

/**
 * Whether the request comes from a signed-in admin (session cookie). Only on
 * instances with the admin API: a public instance has no sessions.
 */
export async function isAdminSession(app: FastifyInstance, req: FastifyRequest): Promise<boolean> {
  const token = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies?.[SESSION_COOKIE];
  if (!token) return false;
  const session = await resolveSession(app.ctx, token);
  return session !== null && hasRole(session.user, 'admin');
}

export async function registerThemeRoutes(app: FastifyInstance, options: { sessions: boolean }): Promise<void> {
  app.get<{ Params: { file: string } }>(
    '/theme/:file',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const sheet = await app.ctx.themes.stylesheet(req.params.file);
      if (!sheet) throw notFound('Stylesheet');
      if (sheet.preview && !(options.sessions && (await isAdminSession(app, req)))) throw notFound('Stylesheet');
      const etag = `"${req.params.file.slice(0, -'.css'.length)}"`;
      reply
        .header('Cache-Control', sheet.preview ? PREVIEW : IMMUTABLE)
        .header('ETag', etag)
        .header('X-Content-Type-Options', 'nosniff');
      if (!sheet.preview && req.headers['if-none-match'] === etag) return reply.status(304).send();
      return reply.type('text/css; charset=utf-8').send(sheet.css);
    },
  );
}
