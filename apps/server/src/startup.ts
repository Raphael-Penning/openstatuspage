/**
 * Start-up steps that depend on APP_ROLE (see role.ts). Used by src/index.ts;
 * separate so the tests can run them per role.
 */
import { syncPollers } from './adapters/poller.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { migrateToLatest, waitForSchema, type DB } from './db/index.js';
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

/**
 * Brings the database to the schema this build expects. Instances that may migrate
 * (all, admin, worker) run the migrations; Kysely's migration lock makes concurrent
 * starts safe on PostgreSQL. A public instance never migrates: it waits up to
 * SCHEMA_WAIT_SECONDS for another instance to do it and fails clearly otherwise.
 */
export async function prepareDatabase(
  db: DB,
  config: Pick<Config, 'APP_ROLE' | 'SCHEMA_WAIT_SECONDS'> & Partial<Pick<Config, 'SECRET_KEY'>>,
  log: { info(obj: object, msg: string): void },
  options: { intervalMs?: number } = {},
): Promise<void> {
  if (roleFeatures(config.APP_ROLE).runsMigrations) {
    await migrateToLatest(db);
    if (config.SECRET_KEY) {
      // Token hashes for the database-side checks of the public role (rows from before 0006, a changed key).
      const updated = await syncSubscriptionTokenHashes(db, config.SECRET_KEY);
      if (updated > 0) log.info({ subscribers: updated }, 'subscription token hashes updated');
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
