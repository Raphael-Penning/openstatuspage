import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { DB } from './db/index.js';
import { SecretBox } from './lib/crypto.js';
import { IngestService } from './services/ingest.js';
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
  worker: Worker;
}

export function createContext(config: Config, db: DB, log: FastifyBaseLogger): AppContext {
  const engine = new StatusEngine(db);
  return {
    config,
    db,
    log,
    secrets: new SecretBox(config.SECRET_KEY),
    engine,
    ingest: new IngestService(db, engine),
    worker: new Worker(log),
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
