import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { createContext, type AppContext } from './context.js';
import type { DB } from './db/index.js';
import { HttpError } from './lib/errors.js';
import { registerRoutes } from './routes/index.js';

export interface BuildAppOptions {
  config: Config;
  db: DB;
  /** Serve the built web client (disabled in tests). */
  serveWeb?: boolean;
}

export async function buildApp({ config, db, serveWeb = true }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
            ...(config.NODE_ENV === 'development'
              ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
              : {}),
          },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 5 * 1024 * 1024,
  });

  const ctx: AppContext = createContext(config, db, app.log);
  app.decorate('ctx', ctx);

  await app.register(cookie, { secret: config.SECRET_KEY });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, issues: err.issues });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation_error', message: 'Invalid request', issues: err.issues });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.status(status).send({
      error: status >= 500 ? 'internal_error' : 'request_error',
      message: status >= 500 ? 'Internal server error' : (err as Error).message,
    });
  });

  await registerRoutes(app);

  const webDir = resolveWebDir(config);
  if (serveWeb && webDir) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false, index: false });
    // SPA fallback: every non-API GET returns index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.status(404).send({ error: 'not_found', message: 'Route not found' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found', message: 'Route not found' }));
  }

  return app;
}

function resolveWebDir(config: Config): string | null {
  const candidates = config.WEB_DIST_DIR
    ? [resolve(config.WEB_DIST_DIR)]
    : [
        resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
        resolve(process.cwd(), 'apps/web/dist'),
        resolve(process.cwd(), '../web/dist'),
      ];
  return candidates.find((dir) => existsSync(resolve(dir, 'index.html'))) ?? null;
}
