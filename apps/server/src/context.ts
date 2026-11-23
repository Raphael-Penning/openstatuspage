import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { DB } from './db/index.js';
import { SecretBox } from './lib/crypto.js';
import { TaskLeases } from './lib/task-leases.js';
import { createMailer, type Mailer } from './mail/mailer.js';
import { BundleService } from './services/bundles.js';
import { HistoryImportService } from './services/history-import.js';
import { IngestService } from './services/ingest.js';
import { NotificationService } from './services/notifications.js';
import { ChannelService } from './services/channels/service.js';
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
  /**
   * Task leases shared by all instances on PostgreSQL (lib/task-leases.ts); null on
   * SQLite (single instance) and for APP_ROLE=public, which runs no tasks.
   */
  leases: TaskLeases | null;
  /** Mail transport (MAIL_TRANSPORT). */
  mailer: Mailer;
  /** Webhook and SMS notifications (admin channels and subscribers) and their outbox. */
  channels: ChannelService;
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
  const leases =
    config.database.dialect === 'postgres' && config.APP_ROLE !== 'public' ? new TaskLeases(db) : null;
  const worker = new Worker(log, leases);
  const mailer = options.mailer ?? createMailer(config, log);
  const secrets = new SecretBox(config.SECRET_KEY);
  const bundles = new BundleService(db, engine, secrets, config.BUNDLE_PUSH_STALE_SECONDS * 1000);
  const notifications = new NotificationService(db, config, mailer, log, worker);
  const channels = new ChannelService(db, config, secrets, log, worker);
  notifications.channels = channels;
  channels.notifications = notifications;
  return {
    config,
    db,
    log,
    secrets,
    engine,
    ingest: new IngestService(db, engine, bundles, { maxChecksPerSource: config.MAX_CHECKS_PER_SOURCE }),
    bundles,
    historyImports: new HistoryImportService(db, secrets, worker, log, config.database.dialect),
    worker,
    leases,
    mailer,
    notifications,
    channels,
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
