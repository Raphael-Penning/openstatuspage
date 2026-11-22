import type { FastifyInstance } from 'fastify';
import { registerAuth } from '../plugins/auth.js';
import { roleFeatures } from '../role.js';

/**
 * Clients (keys) each rate-limited route remembers. @fastify/rate-limit keeps an
 * LRU per route with 5000 entries by default; this bounds the memory a flood from
 * many addresses can take on one instance.
 */
export const RATE_LIMIT_KEYS = 1000;

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
 *   /robots.txt, /sitemap*.xml, /llms.txt, /llms-full.txt  (discovery.ts)
 *   /pulse/p.js, /pulse/api/send  Umami analytics proxy, only with UMAMI_URL (analytics.ts)
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
    // Before the plugin's own onRoute hook, which creates the store of the route.
    app.addHook('onRoute', (route) => {
      const limit = (route.config as { rateLimit?: unknown } | undefined)?.rateLimit;
      if (limit && typeof limit === 'object' && !('cache' in limit)) Object.assign(limit, { cache: RATE_LIMIT_KEYS });
    });
    await app.register(rateLimit, { global: false });
  }
  // Sessions and API tokens are only resolved where the admin API exists.
  await registerAuth(app, { enabled: features.adminApi });

  // Anonymous: only the status, no deployment details (the role is logged on start).
  app.get('/api/health', async () => {
    await app.ctx.db.selectFrom('settings').select('key').limit(1).execute();
    return { status: 'ok' };
  });

  if (features.publicApi) {
    const [{ registerPublicRoutes }, { registerSubscriptionRoutes }] = await Promise.all([
      import('./public.js'),
      import('./subscriptions.js'),
    ]);
    await registerPublicRoutes(app);
    await registerSubscriptionRoutes(app);
  }

  // robots.txt, sitemaps and llms.txt where the public pages are served.
  if (features.publicWeb) {
    const { registerDiscoveryRoutes } = await import('./discovery.js');
    await registerDiscoveryRoutes(app);
    if (config.UMAMI_URL) {
      const { registerAnalyticsRoutes } = await import('./analytics.js');
      await registerAnalyticsRoutes(app, { upstream: config.UMAMI_URL, baseUrl: config.PUBLIC_BASE_URL });
    }
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
