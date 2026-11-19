import type { FastifyInstance } from 'fastify';
import { registerAuth } from '../plugins/auth.js';
import { roleFeatures } from '../role.js';

/**
 * Registers all API route modules. Every module is a Fastify plugin and
 * receives the shared context via `app.ctx`.
 *
 *   /api/health          liveness / readiness
 *   /api/public/*        public read API (no auth, only public data)
 *   /api/public/subscriptions/*  email subscriptions (double opt-in, token based)
 *   /api/auth/*          login, logout, session, OIDC
 *   /api/admin/*         management API (session cookie or API token)
 *   /api/ingest/*        push endpoints for monitoring systems (source token)
 *   /feed.rss, /feed.atom
 *
 * Which modules exist depends on APP_ROLE (see role.ts): `public` has no
 * auth/admin/ingest routes at all (404), `worker` only has /api/health.
 * The modules are imported per role, so an instance never loads (or keeps in
 * memory) the code of routes it does not serve.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const { config } = app.ctx;
  const features = roleFeatures(config.APP_ROLE);

  if (features.publicApi || features.adminApi) {
    // Not global: routes opt in with `config: { rateLimit: { max, timeWindow } }`.
    // Registered once here so every route module (incl. adapters) can use it.
    const { default: rateLimit } = await import('@fastify/rate-limit');
    await app.register(rateLimit, { global: false });
  }
  // Sessions and API tokens are only resolved where the admin API exists.
  await registerAuth(app, { enabled: features.adminApi });

  app.get('/api/health', async () => {
    await app.ctx.db.selectFrom('settings').select('key').limit(1).execute();
    return { status: 'ok', role: config.APP_ROLE, worker: config.WORKER_ENABLED };
  });

  if (features.publicApi) {
    const [{ registerPublicRoutes }, { registerSubscriptionRoutes }] = await Promise.all([
      import('./public.js'),
      import('./subscriptions.js'),
    ]);
    await registerPublicRoutes(app);
    await registerSubscriptionRoutes(app);
  }

  if (features.adminApi) {
    const [{ registerAuthRoutes }, { registerAdminRoutes }, { registerAdapterRoutes }] = await Promise.all([
      import('./auth.js'),
      import('./admin/index.js'),
      import('../adapters/routes.js'),
    ]);
    await registerAuthRoutes(app);
    await registerAdminRoutes(app);
    // Owned by the monitoring adapters (src/adapters): ingest and the admin test/poll actions.
    await registerAdapterRoutes(app);
  }
}
