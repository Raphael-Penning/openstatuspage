/**
 * Authentication & authorization for the admin API.
 *
 * - Session cookie `osp_session` (see services/sessions.ts) or
 *   `Authorization: Bearer <api token>`.
 * - Roles: admin > editor.
 * - CSRF: cookie-authenticated mutating requests must send
 *   `X-Requested-With: openstatuspage`. Bearer requests are exempt.
 *
 * Authentication is only resolved for `/api/admin/*`, `/api/auth/*` and
 * `/api/openapi.json` (the latter only where this plugin is registered, i.e.
 * APP_ROLE admin or all), so other public endpoints never touch the session
 * tables.
 */
import type { UserRole } from '@openstatuspage/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Config } from '../config.js';
import type { AppContext } from '../context.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import {
  createSession,
  deleteSession,
  resolveApiToken,
  resolveSession,
  SESSION_COOKIE,
  sessionTtlMs,
} from '../services/sessions.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /** How the request was authenticated. */
  via: 'session' | 'token';
  /** For API tokens: the user who created the token (null when unknown). */
  tokenCreatedBy?: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth plugin; null for anonymous requests. */
    authUser: AuthUser | null;
  }
}

export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'openstatuspage';

const ROLE_RANK: Record<UserRole, number> = { editor: 1, admin: 2 };
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Routes that resolve the session or API token (route paths, see registerAuth).
 * /api/openapi.json describes the whole API to signed-in users (routes/openapi.ts).
 */
export function isAuthenticatedPath(route: string): boolean {
  return (
    route.startsWith('/api/admin/') ||
    route.startsWith('/api/auth/') ||
    route === '/api/admin' ||
    route === '/api/auth' ||
    route === '/api/openapi.json'
  );
}

export function hasRole(user: Pick<AuthUser, 'role'>, role: UserRole): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[role];
}

/** Options of the session cookie. `maxAgeSeconds = 0` clears it. */
export function sessionCookieOptions(config: Config, maxAgeSeconds: number) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.BASE_URL.startsWith('https://'),
    maxAge: maxAgeSeconds,
  };
}

/**
 * Starts a session for `userId` and sets the cookie. A session the browser
 * still holds (e.g. of another account) is deleted, not just replaced in the
 * cookie, so switching accounts or re-authenticating leaves no live session behind.
 */
export async function startSession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
  const previous = req.cookies[SESSION_COOKIE];
  if (previous) await deleteSession(ctx.db, previous);
  const session = await createSession(ctx, userId, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
  reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(ctx.config, Math.floor(sessionTtlMs(ctx) / 1000)));
}

/**
 * Decorates every request with `authUser`. With `enabled: false` (instances
 * without the admin API) every request stays anonymous and the session and
 * token tables are never read.
 */
export async function registerAuth(app: FastifyInstance, options: { enabled?: boolean } = {}): Promise<void> {
  app.decorateRequest('authUser', null);
  if (options.enabled === false) return;
  app.addHook('onRequest', async (req, reply) => {
    // The matched route, not the raw URL: the router decodes the path, so a spelling like
    // /api/%61dmin reaches an /api/admin handler and must be authenticated the same way.
    const route = req.routeOptions.url;
    if (!route || !isAuthenticatedPath(route)) return;
    req.authUser = await authenticate(app, req, reply);
  });
}

async function authenticate(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const { ctx } = app;
  const header = req.headers.authorization;
  if (header) {
    // An explicit Authorization header is never combined with the cookie.
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match) return null;
    const token = await resolveApiToken(ctx.db, match[1]!);
    if (!token) return null;
    return { id: token.id, email: '', name: token.name, role: token.role, via: 'token', tokenCreatedBy: token.createdBy };
  }

  const cookie = req.cookies[SESSION_COOKIE];
  if (!cookie) return null;
  const session = await resolveSession(ctx, cookie);
  if (!session) {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return null;
  }
  if (session.refreshed) {
    // The cookie lives as long as the session, which may be less than the TTL near the absolute lifetime.
    const maxAge = Math.max(0, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000));
    reply.setCookie(SESSION_COOKIE, cookie, sessionCookieOptions(ctx.config, maxAge));
  }
  const { user } = session;
  return { id: user.id, email: user.email, name: user.name, role: user.role, via: 'session' };
}

/** Throws 403 when a cookie-authenticated mutating request lacks the CSRF header. */
export function assertCsrf(req: FastifyRequest): void {
  if (SAFE_METHODS.has(req.method)) return;
  if (req.authUser?.via !== 'session') return;
  if (req.headers[CSRF_HEADER] !== CSRF_VALUE) {
    throw forbidden(`Missing ${CSRF_HEADER} header`);
  }
}

/** preHandler that requires an authenticated user with at least `role` (admin > editor). */
export function requireRole(role: UserRole): preHandlerAsyncHookHandler {
  return async (req) => {
    const user = req.authUser;
    if (!user) throw unauthorized();
    assertCsrf(req);
    if (!hasRole(user, role)) throw forbidden();
  };
}

/** preHandler for endpoints that only make sense for a logged-in person (not API tokens). */
export function requireSession(): preHandlerAsyncHookHandler {
  return async (req) => {
    if (!req.authUser || req.authUser.via !== 'session') throw unauthorized();
    assertCsrf(req);
  };
}

/** User ID for `created_by` / audit columns. API tokens have no user row, so they yield null. */
export function actorUserId(req: FastifyRequest): string | null {
  return req.authUser?.via === 'session' ? req.authUser.id : null;
}

/**
 * User accountable for credentials the request creates: the session user, or
 * the creator of the API token. Tokens minted by a token inherit its owner, so
 * revoking the owner's tokens (on deletion or demotion) covers them too.
 */
export function owningUserId(req: FastifyRequest): string | null {
  const user = req.authUser;
  if (!user) return null;
  return user.via === 'session' ? user.id : (user.tokenCreatedBy ?? null);
}
