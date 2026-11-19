import { buildApp } from './app.js';
import { ensureInitialAdmin } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { roleFeatures } from './role.js';
import { prepareDatabase, startBackgroundTasks } from './startup.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const features = roleFeatures(config.APP_ROLE);
  const db = await createDb(config);
  // Before buildApp, as before: nothing may read the database ahead of the expected schema.
  await prepareDatabase(db, config, {
    info: (obj, msg) => console.log(`${msg} ${JSON.stringify(obj)}`),
    warn: (obj, msg) => console.warn(`${msg} ${JSON.stringify(obj)}`),
  });

  const app = await buildApp({ config, db });
  const { ctx } = app;
  app.log.info({ role: config.APP_ROLE, worker: config.WORKER_ENABLED }, 'instance role');

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

  // The users table is only touched where the login exists (never by a public instance).
  if (features.bootstrapsAdmin) {
    const admin = await ensureInitialAdmin(db, config);
    if (admin === 'created') app.log.info({ email: config.ADMIN_EMAIL }, 'initial admin created');
    if (admin === 'skipped') {
      app.log.warn('no users exist: set ADMIN_EMAIL and ADMIN_PASSWORD or run `pnpm --filter @openstatuspage/server create-user`');
    }
  }

  await startBackgroundTasks(ctx);

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
