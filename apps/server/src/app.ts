import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type RouteOptions } from 'fastify';
import type { Config } from './config.js';
import { createContext, type AppContext } from './context.js';
import type { DB } from './db/index.js';
import { errorDocument, JSONAPI_MEDIA_TYPE } from './lib/jsonapi.js';
import type { Mailer } from './mail/mailer.js';
import { registerJsonApi, sendJsonApiError } from './plugins/jsonapi.js';
import { roleFeatures } from './role.js';
import { registerRoutes } from './routes/index.js';
import type { RenderModule, SsrPages } from './ssr/pages.js';
import { webAssetPolicy } from './web-assets.js';

export interface BuildAppOptions {
  config: Config;
  db: DB;
  /** Serve the built web client (disabled in tests). */
  serveWeb?: boolean;
  /** Replaces the mail transport configured by MAIL_TRANSPORT (tests). */
  mailer?: Mailer;
  /** Writes the log as JSON lines to this stream, also with NODE_ENV=test (tests). */
  logStream?: { write(line: string): void };
  /** Called for every registered route, after its plugin scope applied its hooks (tests). */
  onRoute?: (route: RouteOptions) => void;
  /** Replaces the server-side rendering bundle of the web build (tests render from the web sources). */
  ssrModule?: () => Promise<RenderModule>;
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

export async function buildApp({ config, db, serveWeb = true, mailer, logStream, onRoute, ssrModule }: BuildAppOptions): Promise<FastifyInstance> {
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

  if (onRoute) app.addHook('onRoute', onRoute);

  const ctx: AppContext = createContext(config, db, app.log, { mailer });
  app.decorate('ctx', ctx);
  app.addHook('onClose', async () => {
    // Let work that runs after a response (e.g. subscribing) finish before the database goes away.
    // Running history imports would keep the process busy for minutes.
    ctx.historyImports.abortAll();
    await ctx.worker.idle();
    ctx.mailer.close();
  });

  // Cookies only carry sessions and the OIDC state: the admin side alone needs them.
  if (roleFeatures(config.APP_ROLE).adminApi) {
    const { default: cookie } = await import('@fastify/cookie');
    await app.register(cookie, { secret: config.SECRET_KEY });
  }

  // Basic hardening headers. The public page may be embedded (iframe) by
  // customers; the management UI and the API may not.
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    const path = normalizePath(req.url);
    const admin = path === '/admin' || path.startsWith('/admin/');
    if (admin || isApiPath(path)) {
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    }
    // The management UI is never indexed by search engines.
    if (admin) reply.header('X-Robots-Tag', 'noindex, nofollow');
  });

  registerJsonApi(app);

  // Every error answer is a JSON:API error document, also on the few non-JSON:API
  // routes (health check, feeds, OIDC and browser redirects).
  app.setErrorHandler((err, req, reply) => sendJsonApiError(err, req, reply));

  await registerRoutes(app);

  const webDir = resolveWebDir(config);
  // Per role (web-assets.ts): public serves public.html and its files only, worker nothing.
  const web = serveWeb && webDir ? webAssetPolicy(config.APP_ROLE, webDir) : null;
  if (web && webDir) {
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, {
      root: webDir,
      wildcard: false,
      index: false,
      allowedPath: (pathname) => web.allows(pathname),
    });
    // Public pages are rendered on the server (ssr/pages.ts) where the web build has
    // the render bundle and the role serves the public web client.
    let ssr: SsrPages | null = null;
    if (roleFeatures(config.APP_ROLE).publicWeb) {
      const [{ SsrPages }, { PublicDocuments }] = await Promise.all([
        import('./ssr/pages.js'),
        import('./services/public-documents.js'),
      ]);
      if (ssrModule || SsrPages.available(webDir)) {
        ssr = new SsrPages({
          webDir,
          baseUrl: config.PUBLIC_BASE_URL,
          docs: new PublicDocuments(ctx.db, ctx.mailer),
          log: app.log,
          loadModule: ssrModule,
        });
      } else {
        app.log.warn(`The web build in ${webDir} has no server-side rendering bundle; public pages render in the browser only`);
      }
    }

    // Client routes (GET/HEAD, not /api, no file extension): public pages are rendered
    // on the server, the management UI (and a page that failed to render) gets the
    // entry page. Missing assets get a real 404 so stale chunk requests fail cleanly
    // after a deploy. A public instance answers /admin/... with 404.
    app.setNotFoundHandler(async (req, reply) => {
      const path = req.url.split('?')[0] ?? '';
      const isClientRoute = !isApiPath(path) && !/\.[a-z0-9]+$/i.test(path) && web.servesRoute(path);
      if ((req.method === 'GET' || req.method === 'HEAD') && isClientRoute) {
        if (ssr && !isAdminPath(path) && (await ssr.send(req, reply))) return reply;
        return reply.type('text/html').header('Cache-Control', 'no-cache').sendFile(web.index, { cacheControl: false });
      }
      return routeNotFound(reply);
    });
  } else {
    app.setNotFoundHandler((_req, reply) => routeNotFound(reply));
  }

  return app;
}

function routeNotFound(reply: FastifyReply) {
  return reply
    .status(404)
    .type(JSONAPI_MEDIA_TYPE)
    .send(errorDocument([{ status: '404', code: 'not_found', title: 'Not Found', detail: 'Route not found' }]));
}

/** Hop count → trust function (only the nearest n proxies), as proxy-addr does. */
function trustProxyOption(value: Config['TRUST_PROXY']): boolean | string[] | ((addr: string, hop: number) => boolean) {
  if (typeof value === 'number') return (_addr, hop) => hop < value;
  return value;
}

/**
 * Request path as the client router sees it: percent-decoded, lower-cased and
 * with repeated slashes collapsed. Used for the anti-framing check, so that
 * /ADMIN/... or /%61dmin/... (served by the SPA fallback) cannot skip it.
 * Malformed escapes keep the raw path, which the router does not decode either.
 */
function normalizePath(url: string): string {
  const raw = url.split('?')[0] ?? '';
  let path = raw;
  try {
    path = decodeURIComponent(raw);
  } catch {
    // keep the raw path
  }
  return path.toLowerCase().replace(/\/{2,}/g, '/');
}

function isAdminPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === '/admin' || normalized.startsWith('/admin/');
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
