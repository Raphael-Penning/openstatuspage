import type { FastifyInstance } from 'fastify';

/**
 * Registers all API route modules. Every module is a Fastify plugin and
 * receives the shared context via `app.ctx`.
 *
 *   /api/health          liveness / readiness
 *   /api/public/*        public read API (no auth, only public data)
 *   /api/auth/*          login, logout, session, OIDC
 *   /api/admin/*         management API (session cookie or API token)
 *   /api/ingest/*        push endpoints for monitoring systems (source token)
 *   /feed.rss, /feed.atom
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    await app.ctx.db.selectFrom('settings').select('key').limit(1).execute();
    return { status: 'ok' };
  });
}
