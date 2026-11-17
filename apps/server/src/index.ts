import { buildApp } from './app.js';
import { ensureInitialAdmin } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createDb, migrateToLatest } from './db/index.js';
import { syncPollers } from './adapters/poller.js';
import { runMaintenanceTransitions } from './services/maintenance-scheduler.js';
import { registerNotificationTasks } from './services/notifications.js';
import { registerSessionCleanup } from './services/sessions.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await createDb(config);
  await migrateToLatest(db);

  const app = await buildApp({ config, db });
  const { ctx } = app;

  if (config.insecureSecret) {
    app.log.warn('SECRET_KEY is not set: using the public development secret. Never use this in production.');
  }
  if (ctx.mailer.transport === 'log') {
    app.log.warn('MAIL_TRANSPORT=log: mails are written to the log instead of being sent (development only).');
  }
  if (config.oidcEnabled && !config.OIDC_ADMIN_GROUP && !config.OIDC_EDITOR_GROUP && config.OIDC_AUTO_CREATE_USERS) {
    app.log.warn(
      'OIDC_AUTO_CREATE_USERS is enabled without OIDC_ADMIN_GROUP/OIDC_EDITOR_GROUP: every account of the identity provider can log in as editor.',
    );
  }

  const admin = await ensureInitialAdmin(db, config);
  if (admin === 'created') app.log.info({ email: config.ADMIN_EMAIL }, 'initial admin created');
  if (admin === 'skipped') {
    app.log.warn('no users exist: set ADMIN_EMAIL and ADMIN_PASSWORD or run `pnpm --filter @openstatuspage/server create-user`');
  }

  if (config.WORKER_ENABLED) {
    ctx.worker.schedule('maintenance-transitions', 30_000, async () => {
      await runMaintenanceTransitions(db, ctx.engine, undefined, ctx.notifications);
    });
    registerSessionCleanup(ctx);
    registerNotificationTasks(ctx);
    await syncPollers(ctx);
    ctx.worker.start();
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    ctx.worker.stop();
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
