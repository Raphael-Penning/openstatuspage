import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPath, hasDotSegments, isPersonalPath, normalizePath, PRIVATE_PAGE_REQUESTS_PER_MINUTE } from '@openstatuspage/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type RouteOptions } from 'fastify';
import type { Config } from './config.js';
import { createContext, type AppContext } from './context.js';
import type { DB } from './db/index.js';
import { errorDocument, JSONAPI_MEDIA_TYPE } from './lib/jsonapi.js';
import { FRAMELESS_PAGE_CSP, PERMISSIONS_POLICY, PUBLIC_PAGE_CSP } from './lib/security-headers.js';
import type { Mailer } from './mail/mailer.js';
import { registerJsonApi, sendJsonApiError } from './plugins/jsonapi.js';
import { roleFeatures } from './role.js';
import { TokenBucketLimiter } from './adapters/rate-limit.js';
import { RATE_LIMIT_KEYS, registerRoutes } from './routes/index.js';
import { sendTooManyRequests } from './ssr/busy.js';
import type { RenderModule, SsrPages } from './ssr/pages.js';
import { staticCacheControl, webAssetPolicy } from './web-assets.js';

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

/** `?`, `&` and `=` as they appear in a URL-encoded parameter value, also encoded twice or more (`%253D`). */
const ENC = (hex: string) => `%(?:25)*${hex}`;
/** The parameter name `token` in any spelling the query parser decodes to it (`tok%65n`, `%74oken`, `TOKEN`). */
const TOKEN_NAME = [...'token']
  .map((c) => {
    const hex = (ch: string) => ch.charCodeAt(0).toString(16);
    return `(?:${c}|${ENC(`(?:${hex(c)}|${hex(c.toUpperCase())})`)})`;
  })
  .join('');
const TOKEN_PARAM = new RegExp(
  // A parameter of its own, or one inside an encoded value such as return=%2Fsubscription%2Fmanage%3Fid%3D1%26token%3Dabc.
  `((?:[?&]|${ENC('3F')}|${ENC('26')})${TOKEN_NAME}(?:=|${ENC('3D')}))(?:(?!${ENC('26')})[^&#])*`,
  'gi',
);

/**
 * Replaces the value of every `token` query parameter, also one with a
 * percent-encoded name or nested in an encoded parameter value:
 * "/x?token=abc&a=1" → "/x?token=[REDACTED]&a=1".
 */
export function redactUrlTokens(url: string): string {
  const query = url.indexOf('?');
  if (query === -1) return url;
  return url.slice(0, query) + url.slice(query).replace(TOKEN_PARAM, '$1[REDACTED]');
}

/**
 * Replaces the token of a private page path in any spelling the router or the
 * renderer could read as one (`/p/<token>/...`, `/P//<token>`, `/%70/<token>`,
 * `/p%2F<token>`, `/p\<token>`, `/x/../p/<token>`). Such a path is logged as the
 * client router sees it: "/P/abc/services/Web" → "/p/[REDACTED]/services/web".
 */
export function redactPrivatePagePath(url: string): string {
  const end = url.search(/[?#]/);
  const path = end === -1 ? url : url.slice(0, end);
  // Escapes decoded one run at a time, so a malformed one elsewhere keeps no token in clear.
  const normalized = normalizePath(path.replace(/(?:%[0-9a-f]{2})+/gi, safeDecode));
  const parts = normalized.split('/');
  if (parts[1] !== 'p' || !parts[2]) return url;
  parts[2] = '[REDACTED]';
  return parts.join('/') + (end === -1 ? '' : url.slice(end));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
 * (e.g. the RFC 8058 one-click URL) and in private page paths never end up in the log.
 */
export function serializeRequest(req: LoggedRequest) {
  return {
    method: req.method,
    url: redactPrivatePagePath(redactUrlTokens(req.url)),
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

  const adminInstance = config.APP_ROLE === 'admin';
  // Basic hardening headers. The public page may be embedded (iframe) by
  // customers; the management UI and the API may not.
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    // Request path as the client router sees it, so that /ADMIN/... or /%61dmin/...
    // (served by the SPA fallback) cannot skip the checks below.
    const path = normalizePath(req.url);
    // Subscription pages have a token in their URL: it never leaves as a referrer.
    reply.header('Referrer-Policy', isPersonalPath(path) ? 'no-referrer' : 'strict-origin-when-cross-origin');
    const admin = path === '/admin' || path.startsWith('/admin/');
    // Private pages are not embeddable either: whoever holds a link could otherwise show it on any site.
    const framed = !(admin || isApiPath(path) || isPrivatePagePath(path));
    if (!framed) reply.header('X-Frame-Options', 'DENY');
    // Pages get the full policy (lib/security-headers.ts), every other response only the framing rule.
    const html = String(reply.getHeader('content-type') ?? '').startsWith('text/html');
    if (html) {
      reply.header('Content-Security-Policy', framed ? PUBLIC_PAGE_CSP : FRAMELESS_PAGE_CSP);
      reply.header('Cross-Origin-Opener-Policy', 'same-origin');
      reply.header('Permissions-Policy', PERMISSIONS_POLICY);
    } else if (!framed) {
      reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    }
    // The management UI is never indexed by search engines, nor is any page of an
    // admin instance (its public pages are a preview; the status page is elsewhere).
    // Private pages (/p/<token>) are never indexed nor followed, wherever they are served.
    if (admin || (adminInstance && html) || isPrivatePagePath(path)) reply.header('X-Robots-Tag', 'noindex, nofollow');
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
      // Brotli/gzip copies written by the web build: no compression at runtime.
      preCompressed: true,
      setHeaders: (reply, path) => {
        const cacheControl = staticCacheControl(path);
        if (cacheControl) reply.header('Cache-Control', cacheControl);
      },
    });
    // Page views of private pages per client, like the rate limit of their API (routes/public.ts).
    const privatePageLimiter = new TokenBucketLimiter({
      capacity: PRIVATE_PAGE_REQUESTS_PER_MINUTE,
      refillPerSecond: PRIVATE_PAGE_REQUESTS_PER_MINUTE / 60,
      maxKeys: RATE_LIMIT_KEYS,
    });
    // Public pages are rendered on the server (ssr/pages.ts) where the web build has
    // the render bundle and the role serves the public web client.
    let ssr: SsrPages | null = null;
    if (roleFeatures(config.APP_ROLE).publicWeb) {
      const [{ SsrPages }, { PublicDocuments }, forms, { PrivatePageDocuments }, { createPrivatePages }] = await Promise.all([
        import('./ssr/pages.js'),
        import('./services/public-documents.js'),
        import('./forms/index.js'),
        import('./services/private-page-documents.js'),
        import('./services/private-pages.js'),
      ]);
      if (ssrModule || SsrPages.available(webDir)) {
        ssr = new SsrPages({
          webDir,
          baseUrl: config.PUBLIC_BASE_URL,
          docs: new PublicDocuments(ctx.db, ctx.mailer, { analytics: Boolean(config.UMAMI_URL) }),
          subscription: (id, token) => forms.subscriptionDocument(app, id, token),
          privatePages: new PrivatePageDocuments(createPrivatePages(ctx.db, config)),
          log: app.log,
          loadModule: ssrModule,
        });
      } else {
        app.log.warn(`The web build in ${webDir} has no server-side rendering bundle; public pages render in the browser only`);
      }
      // HTML forms of the public pages (preferences, email subscription): they work without JavaScript.
      await forms.registerFormRoutes(app, ssr);
    }

    // Client routes (GET/HEAD, not /api, no file extension): public pages are rendered
    // on the server, the management UI (and a page that failed to render) gets the
    // entry page. Missing assets get a real 404 so stale chunk requests fail cleanly
    // after a deploy. A public instance answers /admin/... with 404.
    app.setNotFoundHandler(async (req, reply) => {
      const path = req.url.split('?')[0] ?? '';
      // Browsers resolve "." and ".." and turn "\" into "/" before sending a request; a path
      // that still has them (/./p/<token>, /a/../p/<token>, /p\<token>, /p%5c<token>) is
      // hand-made and gets nothing but a plain 404, before any redirect, rate limit or render.
      if (isHandMadePath(path)) return routeNotFound(reply.header('Cache-Control', 'no-store'));
      const isClientRoute = !isApiPath(path) && !/\.[a-z0-9]+$/i.test(path) && web.servesRoute(path);
      if ((req.method === 'GET' || req.method === 'HEAD') && isClientRoute) {
        // One URL per page for search engines: /SERVICES/ → 301 /services. Not personal
        // pages (their token would go into a cacheable redirect; they are never indexed).
        const preferred = canonicalPath(path);
        if (preferred !== path && !isAdminPath(path) && !isPersonalPath(path)) {
          return reply.header('Cache-Control', CANONICAL_REDIRECT_CACHE).redirect(preferred + req.url.slice(path.length), 301);
        }
        // Private pages: as many page views per client as their API allows (against guessing tokens).
        if (isPrivatePagePath(path)) {
          const retryAfter = privatePageLimiter.take(req.ip);
          if (retryAfter > 0) {
            await sendTooManyRequests(req, reply, retryAfter);
            return reply;
          }
        }
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

/** Redirects to the preferred spelling of a page path are kept for a day. */
const CANONICAL_REDIRECT_CACHE = 'public, max-age=86400';

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
 * A request path no browser sends: with dot segments or a backslash (also as %5c),
 * which the WHATWG URL parser turns into "/". The renderer would read such a path
 * differently from the raw-path checks before it, so it is never answered with a page.
 */
function isHandMadePath(path: string): boolean {
  return hasDotSegments(path) || /\\|%5c/i.test(path);
}

function isAdminPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === '/admin' || normalized.startsWith('/admin/');
}

/** A private page (/p/<token>...) in any spelling of the path. */
function isPrivatePagePath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === '/p' || normalized.startsWith('/p/');
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
