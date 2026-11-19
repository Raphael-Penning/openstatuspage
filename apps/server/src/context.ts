import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { DB } from './db/index.js';
import { SecretBox } from './lib/crypto.js';
import { createMailer, type Mailer } from './mail/mailer.js';
import { BundleService } from './services/bundles.js';
import { HistoryImportService } from './services/history-import.js';
import { IngestService } from './services/ingest.js';
import { NotificationService } from './services/notifications.js';
import { StatusEngine } from './services/status-engine.js';
import { Worker } from './worker.js';

/** Long-lived dependencies shared by routes, services and background tasks. */
export interface AppContext {
  config: Config;
  db: DB;
  log: FastifyBaseLogger;
  secrets: SecretBox;
  engine: StatusEngine;
  ingest: IngestService;
  /** Check bundles (weighted voting over checks of several sources). */
  bundles: BundleService;
  /** History import jobs (fetch, preview, apply). */
  historyImports: HistoryImportService;
  worker: Worker;
  /** Mail transport (MAIL_TRANSPORT). */
  mailer: Mailer;
  /** Subscriber notifications and the mail outbox. */
  notifications: NotificationService;
}

export interface CreateContextOptions {
  /** Replaces the configured mail transport (tests). */
  mailer?: Mailer;
}

export function createContext(
  config: Config,
  db: DB,
  log: FastifyBaseLogger,
  options: CreateContextOptions = {},
): AppContext {
  const engine = new StatusEngine(db);
  const worker = new Worker(log);
  const mailer = options.mailer ?? createMailer(config, log);
  const secrets = new SecretBox(config.SECRET_KEY);
  const bundles = new BundleService(db, engine, secrets, config.BUNDLE_PUSH_STALE_SECONDS * 1000);
  return {
    config,
    db,
    log,
    secrets,
    engine,
    ingest: new IngestService(db, engine, bundles),
    bundles,
    historyImports: new HistoryImportService(db, secrets, worker, log, config.database.dialect),
    worker,
    mailer,
    notifications: new NotificationService(db, config, mailer, log, worker),
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
