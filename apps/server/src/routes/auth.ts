/**
 * /api/auth: local login, logout, session info, password change and OIDC.
 *
 * config, login, logout, session and password speak JSON:API 1.1 (the session
 * is the singleton resource `sessions/current` with the user included). The
 * OIDC routes are browser redirects and stay plain.
 */
import { ChangePasswordInput, LoginInput, type AuthConfig, type SessionInfo } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { assertCsrf, requireSession, startSession } from '../plugins/auth.js';
import { badRequest, forbidden, HttpError, notFound, unauthorized } from '../lib/errors.js';
import { parse } from '../lib/http.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { nowIso } from '../lib/time.js';
import { audit } from '../services/audit.js';
import {
  OIDC_STATE_COOKIE,
  OIDC_STATE_TTL_SECONDS,
  OidcClient,
  parseLoginState,
  resolveOidcUser,
} from '../services/oidc.js';
import { deleteSession, deleteUserSessions, SESSION_COOKIE } from '../services/sessions.js';
import { LoginThrottle } from '../services/login-throttle.js';
import { toAdminUser } from '../services/users.js';
import { document, Included, noContent } from '../lib/jsonapi.js';
import { useJsonApi } from '../plugins/jsonapi.js';
import { AUTH_TYPES, authConfigResource, sessionResource } from '../serializers/auth-users.js';

const OIDC_COOKIE_PATH = '/api/auth/oidc';

/** Hash used to keep the login timing similar when the user does not exist. */
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('openstatuspage-dummy-password-for-timing');
  return dummyHash;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;
  const { config, db } = ctx;
  const oidc = config.oidcEnabled ? new OidcClient(config) : null;
  // Per account, on top of the per-client rate limit of the route (see login-throttle.ts).
  const throttle = new LoginThrottle();

  async function sessionInfo(userId: string): Promise<SessionInfo> {
    const user = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
    if (!user) throw unauthorized();
    return { user: toAdminUser(user), oidcEnabled: config.oidcEnabled };
  }

  /** Session document: `sessions/current` with the user in `included`. */
  const sessionDocument = (info: SessionInfo) => {
    const included = new Included();
    const data = sessionResource(info, included);
    return document(data, { included, links: { self: '/api/auth/session' } });
  };

  await app.register(async (scope) => {
    useJsonApi(scope);

    scope.get('/api/auth/config', async () => {
      const authConfig: AuthConfig = {
        oidcEnabled: config.oidcEnabled,
        oidcLabel: config.OIDC_LABEL,
        localLoginEnabled: config.LOCAL_LOGIN_ENABLED,
      };
      return document(authConfigResource(authConfig), { links: { self: '/api/auth/config' } });
    });

    // Login creates the session: the request document is `{ data: { type: "sessions", attributes: { email, password } } }`.
    scope.post(
      '/api/auth/login',
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' }, jsonapi: { type: AUTH_TYPES.session } } },
      async (req, reply) => {
        if (!config.LOCAL_LOGIN_ENABLED) throw forbidden('Local login is disabled');
        const body = parse(LoginInput, req.body);
        const email = LoginThrottle.key(body.email);
        const retryAfterMs = throttle.retryAfterMs(email);
        if (retryAfterMs > 0) {
          const seconds = Math.ceil(retryAfterMs / 1000);
          reply.header('retry-after', String(seconds));
          throw new HttpError(429, 'rate_limited', `Too many failed logins for this account, retry in ${seconds}s`);
        }
        const user = await db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
        // Always verify a hash so response times do not reveal whether the account exists.
        const valid = await verifyPassword(user?.password_hash ?? (await getDummyHash()), body.password);
        if (!user || !user.password_hash || !valid) {
          throttle.recordFailure(email);
          throw new HttpError(401, 'invalid_credentials', 'Invalid e-mail or password');
        }
        throttle.recordSuccess(email);
        await startSession(ctx, req, reply, user.id);
        await audit(db, { userId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, details: { method: 'password' } });
        return sessionDocument(await sessionInfo(user.id));
      },
    );

    scope.post('/api/auth/logout', async (req, reply) => {
      assertCsrf(req);
      const token = req.cookies[SESSION_COOKIE];
      if (token) await deleteSession(db, token);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return noContent(reply);
    });

    scope.get('/api/auth/session', async (req) => {
      if (!req.authUser || req.authUser.via !== 'session') throw unauthorized();
      return sessionDocument(await sessionInfo(req.authUser.id));
    });

    scope.post('/api/auth/password', { preHandler: requireSession() }, async (req, reply) => {
      const body = parse(ChangePasswordInput, req.body);
      const userId = req.authUser!.id;
      const user = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
      if (!user.password_hash) throw badRequest('This account has no local password');
      if (!(await verifyPassword(user.password_hash, body.currentPassword))) {
        throw new HttpError(400, 'invalid_password', 'Current password is incorrect');
      }
      await db
        .updateTable('users')
        .set({ password_hash: await hashPassword(body.newPassword), updated_at: nowIso() })
        .where('id', '=', userId)
        .execute();
      // Sign out every other session of this user.
      await deleteUserSessions(db, userId, req.cookies[SESSION_COOKIE]);
      await audit(db, { userId, action: 'user.password_change', entityType: 'user', entityId: userId });
      return noContent(reply);
    });
  });

  // --- OIDC -------------------------------------------------------------------

  app.get(
    '/api/auth/oidc/login',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!oidc) throw notFound('OIDC login');
      try {
        const { url, state } = await oidc.startLogin();
        reply.setCookie(OIDC_STATE_COOKIE, JSON.stringify(state), {
          path: OIDC_COOKIE_PATH,
          httpOnly: true,
          sameSite: 'lax',
          secure: config.BASE_URL.startsWith('https://'),
          signed: true,
          maxAge: OIDC_STATE_TTL_SECONDS,
        });
        return reply.redirect(url, 302);
      } catch (err) {
        req.log.error({ err }, 'OIDC login could not be started');
        return reply.redirect('/admin/login?error=oidc_unavailable', 302);
      }
    },
  );

  app.get(
    '/api/auth/oidc/callback',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!oidc) throw notFound('OIDC login');
      const fail = (code: string) => reply.redirect(`/admin/login?error=${encodeURIComponent(code)}`, 302);

      const raw = req.cookies[OIDC_STATE_COOKIE];
      reply.clearCookie(OIDC_STATE_COOKIE, { path: OIDC_COOKIE_PATH });
      const unsigned = raw ? req.unsignCookie(raw) : null;
      const state = unsigned?.valid ? parseLoginState(unsigned.value) : null;
      if (!state) return fail('invalid_state');

      const query = req.query as Record<string, unknown>;
      if (typeof query.error === 'string') return fail('idp_error');

      let claims;
      try {
        claims = await oidc.finishLogin(new URL(req.url, config.BASE_URL), state);
      } catch (err) {
        req.log.warn({ err }, 'OIDC callback failed');
        return fail('oidc_failed');
      }

      const result = await resolveOidcUser(db, config, claims, req.log);
      if (!result.ok) {
        req.log.info({ reason: result.error }, 'OIDC login rejected');
        return fail(result.error);
      }
      await startSession(ctx, req, reply, result.user.id);
      await audit(db, {
        userId: result.user.id,
        action: result.created ? 'user.create' : 'auth.login',
        entityType: 'user',
        entityId: result.user.id,
        details: { method: 'oidc' },
      });
      return reply.redirect('/admin', 302);
    },
  );
}
