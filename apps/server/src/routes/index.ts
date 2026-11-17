import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { registerAdapterRoutes } from '../adapters/routes.js';
import { registerAuth } from '../plugins/auth.js';
import { registerAdminRoutes } from './admin/index.js';
import { registerAuthRoutes } from './auth.js';
import { registerPublicRoutes } from './public.js';

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
  // Not global: routes opt in with `config: { rateLimit: { max, timeWindow } }`.
  // Registered once here so every route module (incl. adapters) can use it.
  await app.register(rateLimit, { global: false });
  await registerAuth(app);

  app.get('/api/health', async () => {
    await app.ctx.db.selectFrom('settings').select('key').limit(1).execute();
    return { status: 'ok' };
  });

  await registerPublicRoutes(app);
  await registerAuthRoutes(app);
  await registerAdminRoutes(app);

  // Owned by the monitoring adapters (src/adapters).
  await registerAdapterRoutes(app);
}
