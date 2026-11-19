/**
 * Deployment roles (APP_ROLE). One code base, several kinds of instances:
 *
 *   all     everything in one process (default; the only role on SQLite)
 *   public  public status page, public JSON:API, feeds, email subscriptions, health.
 *           No management UI/API, no login/OIDC, no ingest, no background tasks,
 *           never runs migrations and never connects to monitoring systems.
 *   admin   management UI and API, login/OIDC, ingest/webhooks, plus the public
 *           API and page (preview). Background tasks only with WORKER_ENABLED=true.
 *   worker  background tasks only (pollers, scheduler, mail delivery, bundle
 *           evaluation, history imports, cleanup); HTTP serves /api/health only.
 */
export const APP_ROLES = ['all', 'public', 'admin', 'worker'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export interface RoleFeatures {
  /** /api/public/* (incl. subscriptions) and the feeds. */
  publicApi: boolean;
  /** /api/admin/*, /api/auth/* (incl. OIDC), /api/ingest/*. */
  adminApi: boolean;
  /** The web client: public pages. */
  publicWeb: boolean;
  /** The web client: /admin pages and the admin chunks. */
  adminWeb: boolean;
  /** Runs the database migrations on start (otherwise waits for the expected schema). */
  runsMigrations: boolean;
  /** Creates the initial admin (ADMIN_EMAIL/ADMIN_PASSWORD) on start. */
  bootstrapsAdmin: boolean;
}

const FEATURES: Record<AppRole, RoleFeatures> = {
  all: { publicApi: true, adminApi: true, publicWeb: true, adminWeb: true, runsMigrations: true, bootstrapsAdmin: true },
  admin: { publicApi: true, adminApi: true, publicWeb: true, adminWeb: true, runsMigrations: true, bootstrapsAdmin: true },
  public: { publicApi: true, adminApi: false, publicWeb: true, adminWeb: false, runsMigrations: false, bootstrapsAdmin: false },
  worker: { publicApi: false, adminApi: false, publicWeb: false, adminWeb: false, runsMigrations: true, bootstrapsAdmin: false },
};

export function roleFeatures(role: AppRole): RoleFeatures {
  return FEATURES[role];
}
