import { ApiTokenCreateInput, UserCreateInput, UserUpdateInput, type AdminApiToken } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { IdParams, parse } from '../../lib/http.js';
import { hashPassword } from '../../lib/password.js';
import { nowIso } from '../../lib/time.js';
import { actorUserId, owningUserId, startSession } from '../../plugins/auth.js';
import { newApiToken } from '../../services/sessions.js';
import { changeUserRole, deleteUser, insertApiToken, revokeUserCredentials, toAdminUser } from '../../services/users.js';
import { collection, created, document, noContent, selfLink } from '../../lib/jsonapi.js';
import { useJsonApi } from '../../plugins/jsonapi.js';
import { apiTokenResource, AUTH_TYPES, userResource } from '../../serializers/auth-users.js';
import { admin, auditRequest } from './util.js';

/** /api/admin/users and /api/admin/api-tokens (admin, JSON:API) */
export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  await app.register(registerUserScope);
}

async function registerUserScope(app: FastifyInstance): Promise<void> {
  useJsonApi(app);
  const { db } = app.ctx;
  const usersRoute = { ...admin, config: { jsonapi: { type: AUTH_TYPES.user } } };
  const tokensRoute = { ...admin, config: { jsonapi: { type: AUTH_TYPES.apiToken } } };

  const getUser = async (id: string) => {
    const user = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
    if (!user) throw notFound('User');
    return user;
  };

  const assertEmailFree = async (email: string, excludeId?: string) => {
    let q = db.selectFrom('users').select('id').where('email', '=', email);
    if (excludeId) q = q.where('id', '!=', excludeId);
    if (await q.executeTakeFirst()) throw conflict('A user with this e-mail already exists');
  };

  app.get('/api/admin/users', admin, async (req) => {
    const rows = await db.selectFrom('users').selectAll().orderBy('name').orderBy('email').execute();
    return collection(req, rows.map((r) => userResource(toAdminUser(r))));
  });

  app.post('/api/admin/users', usersRoute, async (req, reply) => {
    const input = parse(UserCreateInput, req.body);
    const email = input.email.trim().toLowerCase();
    await assertEmailFree(email);
    const id = newId();
    const now = nowIso();
    await db
      .insertInto('users')
      .values({
        id,
        email,
        name: input.name,
        role: input.role,
        password_hash: input.password ? await hashPassword(input.password) : null,
        oidc_subject: null,
        created_at: now,
        updated_at: now,
        last_login_at: null,
      })
      .execute();
    await auditRequest(db, req, 'user.create', 'user', id, { email, role: input.role });
    return created(reply, document(userResource(toAdminUser(await getUser(id)))), `/api/admin/users/${id}`);
  });

  app.get('/api/admin/users/:id', admin, async (req) =>
    document(userResource(toAdminUser(await getUser(parse(IdParams, req.params).id))), { links: { self: selfLink(req) } }),
  );

  app.patch('/api/admin/users/:id', usersRoute, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const input = parse(UserUpdateInput, req.body);
    const user = await getUser(id);
    const isSelf = actorUserId(req) === id;

    const email = input.email?.trim().toLowerCase();
    if (email && email !== user.email) await assertEmailFree(email, id);

    if (input.role && input.role !== user.role && user.role === 'admin' && isSelf) {
      throw conflict('You cannot change your own role');
    }
    if (input.password === null && isSelf) throw badRequest('You cannot remove your own password');

    // Role first: a refused demotion leaves the user unchanged. Demotion also revokes their admin tokens.
    if (input.role && (await changeUserRole(db, id, input.role)) === 'last_admin') {
      throw conflict('The last admin cannot be demoted');
    }
    const passwordChanged = input.password !== undefined;
    await db
      .updateTable('users')
      .set({
        ...(email ? { email } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(passwordChanged ? { password_hash: input.password ? await hashPassword(input.password) : null } : {}),
        updated_at: nowIso(),
      })
      .where('id', '=', id)
      .execute();
    // A new or removed password signs the user out everywhere; an admin changing their own
    // password continues in a new session. A reset is also how a compromised account is
    // recovered, so it revokes the API tokens they created as well.
    if (passwordChanged) {
      await revokeUserCredentials(db, id);
      if (isSelf) await startSession(app.ctx, req, reply, id);
    }

    await auditRequest(db, req, 'user.update', 'user', id, {
      fields: Object.keys(input).filter((k) => k !== 'password'),
      ...(passwordChanged ? { passwordChanged: true } : {}),
    });
    return document(userResource(toAdminUser(await getUser(id))));
  });

  app.delete('/api/admin/users/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const user = await getUser(id);
    if (actorUserId(req) === id) throw conflict('You cannot delete yourself');
    // Sessions cascade; authored records keep their content with created_by = NULL.
    // API tokens created by the user are revoked with the account.
    const result = await deleteUser(db, id);
    if (result === 'not_found') throw notFound('User');
    if (result === 'last_admin') throw conflict('The last admin cannot be deleted');
    await auditRequest(db, req, 'user.delete', 'user', id, { email: user.email });
    return noContent(reply);
  });

  // --- API tokens -------------------------------------------------------------------

  app.get('/api/admin/api-tokens', admin, async (req) => {
    const rows = await db
      .selectFrom('api_tokens')
      .select(['id', 'name', 'role', 'created_at', 'last_used_at'])
      .orderBy('created_at', 'desc')
      .execute();
    const tokens: AdminApiToken[] = rows.map((t) => ({
      id: t.id,
      name: t.name,
      role: t.role,
      createdAt: t.created_at,
      lastUsedAt: t.last_used_at,
    }));
    return collection(req, tokens.map(apiTokenResource));
  });

  // The plain token is only part of this response (attribute `token`).
  app.post('/api/admin/api-tokens', tokensRoute, async (req, reply) => {
    const input = parse(ApiTokenCreateInput, req.body);
    const id = newId();
    const token = newApiToken();
    const now = nowIso();
    const stored = await insertApiToken(db, {
      id,
      name: input.name,
      role: input.role,
      tokenHash: sha256(token),
      // Owned by the session user or, when created with a token, by that token's owner.
      createdBy: owningUserId(req),
      createdAt: now,
    });
    if (!stored) throw forbidden('The owner of this request is no longer an admin');
    await auditRequest(db, req, 'api_token.create', 'api_token', id, { name: input.name, role: input.role });
    const body: AdminApiToken = { id, name: input.name, role: input.role, createdAt: now, lastUsedAt: null, token };
    return created(reply, document(apiTokenResource(body)), `/api/admin/api-tokens/${id}`);
  });

  app.delete('/api/admin/api-tokens/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const row = await db.selectFrom('api_tokens').select(['name']).where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound('API token');
    await db.deleteFrom('api_tokens').where('id', '=', id).execute();
    await auditRequest(db, req, 'api_token.delete', 'api_token', id, { name: row.name });
    return noContent(reply);
  });
}
