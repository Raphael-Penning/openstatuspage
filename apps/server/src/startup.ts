/**
 * Start-up steps that depend on APP_ROLE (see role.ts). Used by src/index.ts;
 * separate so the tests can run them per role.
 */
import { syncPollers } from './adapters/poller.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { migrateToLatest, waitForSchema, type DB } from './db/index.js';
import { connectionRestricted, grantPublicRole } from './db/public-role.js';
import { roleFeatures } from './role.js';
import { registerBundleTasks } from './services/bundles.js';
import { registerHistoryImportTasks } from './services/history-import.js';
import { runMaintenanceTransitions } from './services/maintenance-scheduler.js';
import { registerNotificationTasks } from './services/notifications.js';
import { registerSessionCleanup } from './services/sessions.js';
import { syncSubscriptionTokenHashes } from './services/subscriptions.js';

/** Re-reads the monitoring sources so a worker picks up changes made on an admin instance. */
export const POLLER_SYNC_TASK = 'poller-sync';
const POLLER_SYNC_INTERVAL_MS = 30_000;

export interface StartupLog {
  info(obj: object, msg: string): void;
  warn?(obj: object, msg: string): void;
}

/**
 * Brings the database to the schema this build expects. Instances that may migrate
 * (all, admin, worker) run the migrations; Kysely's migration lock makes concurrent
 * starts safe on PostgreSQL. On PostgreSQL they then grant DB_PUBLIC_ROLE its
 * restricted access (docs/security-model.md) once that role exists.
 * A public instance never migrates: it waits up to SCHEMA_WAIT_SECONDS for another
 * instance to do it and fails clearly otherwise. On PostgreSQL it warns when its
 * login is not a registered public role.
 */
export async function prepareDatabase(
  db: DB,
  config: Pick<Config, 'APP_ROLE' | 'SCHEMA_WAIT_SECONDS'> &
    Partial<Pick<Config, 'SECRET_KEY' | 'DB_PUBLIC_ROLE' | 'database'>>,
  log: StartupLog,
  options: { intervalMs?: number } = {},
): Promise<void> {
  const postgres = config.database?.dialect === 'postgres';
  if (roleFeatures(config.APP_ROLE).runsMigrations) {
    await migrateToLatest(db);
    if (config.SECRET_KEY) {
      // Token hashes for the database-side checks of the public role (rows from before 0006, a changed key).
      const updated = await syncSubscriptionTokenHashes(db, config.SECRET_KEY);
      if (updated > 0) log.info({ subscribers: updated }, 'subscription token hashes updated');
    }
    if (postgres && config.DB_PUBLIC_ROLE) {
      const role = config.DB_PUBLIC_ROLE;
      const granted = (await grantPublicRole(db, role)) === 'granted';
      log.info(
        { role, granted },
        granted
          ? 'public database role granted'
          : 'public database role does not exist (only needed for APP_ROLE=public, see deploy/postgres/roles.sql)',
      );
    }
    return;
  }
  let logged = false;
  await waitForSchema(db, {
    timeoutMs: config.SCHEMA_WAIT_SECONDS * 1000,
    intervalMs: options.intervalMs,
    onWait: (status) => {
      if (logged) return;
      logged = true;
      log.info(
        { applied: status?.applied ?? null, expected: status?.expected },
        'waiting for the database schema (migrations run on the admin or worker instance)',
      );
    },
  });
  if (postgres && !(await connectionRestricted(db))) {
    const warn = log.warn ?? log.info;
    warn.call(
      log,
      { role: config.DB_PUBLIC_ROLE },
      'the database login of this public instance is not a registered public role, so the database does not ' +
        'restrict it (see docs/security-model.md)',
    );
  }
}

/**
 * Registers and starts the background tasks when WORKER_ENABLED (default for the
 * roles all and worker). Returns whether the worker was started.
 */
export async function startBackgroundTasks(ctx: AppContext): Promise<boolean> {
  const { config, db } = ctx;
  if (!config.WORKER_ENABLED) return false;
  ctx.worker.schedule('maintenance-transitions', 30_000, async () => {
    await runMaintenanceTransitions(db, ctx.engine, undefined, ctx.notifications);
  });
  registerSessionCleanup(ctx);
  registerNotificationTasks(ctx);
  registerBundleTasks(ctx);
  registerHistoryImportTasks(ctx);
  await syncPollers(ctx);
  // Sources edited on another instance (APP_ROLE=admin) only reach this worker this way.
  ctx.worker.schedule(POLLER_SYNC_TASK, POLLER_SYNC_INTERVAL_MS, async () => {
    await syncPollers(ctx);
  });
  ctx.worker.start();
  return true;
}
