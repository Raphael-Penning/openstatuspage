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
import type { Mailer } from './mail/mailer.js';
import { registerRoutes } from './routes/index.js';

export interface BuildAppOptions {
  config: Config;
  db: DB;
  /** Serve the built web client (disabled in tests). */
  serveWeb?: boolean;
  /** Replaces the mail transport configured by MAIL_TRANSPORT (tests). */
  mailer?: Mailer;
  /** Writes the log as JSON lines to this stream, also with NODE_ENV=test (tests). */
  logStream?: { write(line: string): void };
}

/** Replaces the value of every `token` query parameter: "/x?token=abc&a=1" → "/x?token=[REDACTED]&a=1". */
export function redactUrlTokens(url: string): string {
  const query = url.indexOf('?');
  if (query === -1) return url;
  return url.slice(0, query) + url.slice(query).replace(/([?&]token=)[^&#]*/gi, '$1[REDACTED]');
}

interface LoggedRequest {
  method: string;
  url: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

/**
 * Request serializer for the log (fields as Fastify's default). Tokens in query strings
 * (e.g. the RFC 8058 one-click URL) never end up in the log.
 */
export function serializeRequest(req: LoggedRequest) {
  return {
    method: req.method,
    url: redactUrlTokens(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

export async function buildApp({ config, db, serveWeb = true, mailer, logStream }: BuildAppOptions): Promise<FastifyInstance> {
  const loggerBase = {
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    serializers: { req: serializeRequest },
  };
  const app = Fastify({
    logger: logStream
      ? { ...loggerBase, stream: logStream }
      : config.NODE_ENV === 'test'
        ? false
        : {
            ...loggerBase,
            ...(config.NODE_ENV === 'development'
              ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
              : {}),
          },
    trustProxy: trustProxyOption(config.TRUST_PROXY),
    // 1 MiB; routes that need more (bulk ingest) raise it per route.
    bodyLimit: 1024 * 1024,
  });

  const ctx: AppContext = createContext(config, db, app.log, { mailer });
  app.decorate('ctx', ctx);
  app.addHook('onClose', async () => ctx.mailer.close());

  await app.register(cookie, { secret: config.SECRET_KEY });

  // Basic hardening headers. The public page may be embedded (iframe) by
  // customers; the management UI and the API may not.
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    const path = req.url.split('?')[0] ?? '';
    if (path === '/admin' || path.startsWith('/admin/') || isApiPath(path)) {
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    }
  });

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
    // SPA fallback: client routes (GET/HEAD, not /api, no file extension) return index.html.
    // Missing assets get a real 404 so stale chunk requests fail cleanly after a deploy.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? '';
      const isClientRoute = !isApiPath(path) && !/\.[a-z0-9]+$/i.test(path);
      if ((req.method === 'GET' || req.method === 'HEAD') && isClientRoute) {
        return reply.type('text/html').header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      return reply.status(404).send({ error: 'not_found', message: 'Route not found' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found', message: 'Route not found' }));
  }

  return app;
}

/** Hop count → trust function (only the nearest n proxies), as proxy-addr does. */
function trustProxyOption(value: Config['TRUST_PROXY']): boolean | string[] | ((addr: string, hop: number) => boolean) {
  if (typeof value === 'number') return (_addr, hop) => hop < value;
  return value;
}

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
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
