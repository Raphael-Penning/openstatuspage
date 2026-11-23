/**
 * /api/auth: local login, logout, session info, password change and OIDC.
 *
 * config, login, logout, session and password speak JSON:API 1.1 (the session
 * is the singleton resource `sessions/current` with the user included). The
 * OIDC routes are browser redirects and stay plain.
 */
import { ChangePasswordInput, ENV_OIDC_PROVIDER_ID, LoginInput, type AuthConfig, type SessionInfo } from '@openstatuspage/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertCsrf, requireSession, startSession } from '../plugins/auth.js';
import { badRequest, forbidden, HttpError, notFound, unauthorized } from '../lib/errors.js';
import { parse } from '../lib/http.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { nowIso } from '../lib/time.js';
import { audit } from '../services/audit.js';
import {
  OIDC_COOKIE_PATH,
  OIDC_STATE_COOKIE,
  OIDC_STATE_TTL_SECONDS,
  parseLoginState,
  resolveOidcUser,
} from '../services/oidc.js';
import { OidcProviderRegistry } from '../services/oidc-providers.js';
import { deleteSession, deleteUserSessions, SESSION_COOKIE } from '../services/sessions.js';
import { LoginThrottle } from '../services/login-throttle.js';
import { toAdminUserWithLinks } from '../services/users.js';
import { document, Included, noContent } from '../lib/jsonapi.js';
import { useJsonApi } from '../plugins/jsonapi.js';
import { AUTH_TYPES, authConfigResource, sessionResource } from '../serializers/auth-users.js';

/** Hash used to keep the login timing similar when the user does not exist. */
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('openstatuspage-dummy-password-for-timing');
  return dummyHash;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;
  const { config, db } = ctx;
  const oidc = new OidcProviderRegistry({ config, db, secrets: ctx.secrets, log: app.log });
  // Per account, on top of the per-client rate limit of the route (see login-throttle.ts).
  const throttle = new LoginThrottle();

  async function sessionInfo(userId: string): Promise<SessionInfo> {
    const user = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
    if (!user) throw unauthorized();
    return { user: await toAdminUserWithLinks(db, user), oidcEnabled: await oidc.hasLoginProviders() };
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
      const oidcProviders = await oidc.loginProviders();
      const authConfig: AuthConfig = {
        oidcEnabled: oidcProviders.length > 0,
        oidcLabel: config.OIDC_LABEL,
        localLoginEnabled: config.LOCAL_LOGIN_ENABLED,
        oidcProviders,
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
        const user = await db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
        // Check and reserve the attempt in one synchronous step, before the first await of the
        // password check: concurrent attempts are counted before any of them is verified.
        const retryAfterMs = throttle.attempt(email, user !== undefined);
        if (retryAfterMs > 0) {
          const seconds = Math.ceil(retryAfterMs / 1000);
          reply.header('retry-after', String(seconds));
          throw new HttpError(429, 'rate_limited', `Too many failed logins for this account, retry in ${seconds}s`);
        }
        // Always verify a hash so response times do not reveal whether the account exists.
        const valid = await verifyPassword(user?.password_hash ?? (await getDummyHash()), body.password);
        if (!user || !user.password_hash || !valid) {
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
      // Sign out every session of this user and continue in a new one: a session token that
      // leaked before the change does not survive it.
      await deleteUserSessions(db, userId);
      await startSession(ctx, req, reply, userId);
      await audit(db, { userId, action: 'user.password_change', entityType: 'user', entityId: userId });
      return noContent(reply);
    });
  });

  // --- OIDC -------------------------------------------------------------------
  // Every provider has its own login and callback route; the environment provider
  // keeps the routes of 0.3.x (/api/auth/oidc/login and /api/auth/oidc/callback).

  const loginFail = (reply: FastifyReply, code: string) =>
    reply.redirect(`/admin/login?error=${encodeURIComponent(code)}`, 302);

  async function startOidcLogin(req: FastifyRequest, reply: FastifyReply, providerId: string) {
    const provider = await oidc.get(providerId);
    if (!provider) return loginFail(reply, 'oidc_unavailable');
    try {
      const { url, state } = await oidc.client(provider).startLogin();
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
      req.log.error({ err, provider: providerId }, 'OIDC login could not be started');
      return loginFail(reply, 'oidc_unavailable');
    }
  }

  async function finishOidcLogin(req: FastifyRequest, reply: FastifyReply, providerId: string) {
    const raw = req.cookies[OIDC_STATE_COOKIE];
    reply.clearCookie(OIDC_STATE_COOKIE, { path: OIDC_COOKIE_PATH });
    const unsigned = raw ? req.unsignCookie(raw) : null;
    // The state names its provider: a login started at another provider is rejected here.
    const state = unsigned?.valid ? parseLoginState(unsigned.value, providerId) : null;
    if (!state) return loginFail(reply, 'invalid_state');

    const query = req.query as Record<string, unknown>;
    if (typeof query.error === 'string') return loginFail(reply, 'idp_error');

    const provider = await oidc.get(providerId);
    if (!provider) return loginFail(reply, 'oidc_unavailable');

    let claims;
    try {
      claims = await oidc.client(provider).finishLogin(new URL(req.url, config.BASE_URL), state);
    } catch (err) {
      req.log.warn({ err, provider: providerId }, 'OIDC callback failed');
      return loginFail(reply, 'oidc_failed');
    }

    const result = await resolveOidcUser(db, provider, claims, req.log);
    if (!result.ok) {
      req.log.info({ reason: result.error, provider: providerId }, 'OIDC login rejected');
      return loginFail(reply, result.error);
    }
    await startSession(ctx, req, reply, result.user.id);
    await audit(db, {
      userId: result.user.id,
      action: result.created ? 'user.create' : 'auth.login',
      entityType: 'user',
      entityId: result.user.id,
      details: { method: 'oidc', provider: provider.id, providerName: provider.label, ...(result.linked ? { linked: true } : {}) },
    });
    if (result.roleChange) {
      // Role sync: traceable like a change in the management UI, with the provider that made it.
      await audit(db, {
        userId: result.user.id,
        action: 'user.update',
        entityType: 'user',
        entityId: result.user.id,
        details: {
          fields: ['role'],
          role: result.roleChange.to,
          previousRole: result.roleChange.from,
          method: 'oidc',
          provider: provider.id,
          providerName: provider.label,
        },
      });
    }
    return reply.redirect('/admin', 302);
  }

  const oidcRateLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const ProviderParams = z.object({ provider: z.uuid() });
  /** Provider of a `/:provider/...` route; the environment provider has its own routes. */
  const providerParam = (req: FastifyRequest): string | null => {
    const parsed = ProviderParams.safeParse(req.params);
    return parsed.success ? parsed.data.provider : null;
  };

  app.get('/api/auth/oidc/login', oidcRateLimit, (req, reply) => {
    if (!config.oidcEnabled) throw notFound('OIDC login');
    return startOidcLogin(req, reply, ENV_OIDC_PROVIDER_ID);
  });

  app.get('/api/auth/oidc/callback', oidcRateLimit, (req, reply) => {
    if (!config.oidcEnabled) throw notFound('OIDC login');
    return finishOidcLogin(req, reply, ENV_OIDC_PROVIDER_ID);
  });

  app.get('/api/auth/oidc/:provider/login', oidcRateLimit, (req, reply) => {
    const id = providerParam(req);
    if (!id) throw notFound('OIDC provider');
    return startOidcLogin(req, reply, id);
  });

  app.get('/api/auth/oidc/:provider/callback', oidcRateLimit, (req, reply) => {
    const id = providerParam(req);
    if (!id) throw notFound('OIDC provider');
    return finishOidcLogin(req, reply, id);
  });
}
