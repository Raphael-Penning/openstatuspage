import { ApiTokenCreateInput, UserCreateInput, UserUpdateInput, type AdminApiToken } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '../../lib/crypto.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { IdParams, parse } from '../../lib/http.js';
import { hashPassword } from '../../lib/password.js';
import { nowIso } from '../../lib/time.js';
import { actorUserId } from '../../plugins/auth.js';
import { deleteUserSessions, newApiToken, SESSION_COOKIE } from '../../services/sessions.js';
import { countAdmins, toAdminUser } from '../../services/users.js';
import { admin, auditRequest } from './util.js';

/** /api/admin/users and /api/admin/api-tokens (admin) */
export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

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

  app.get('/api/admin/users', admin, async () => {
    const rows = await db.selectFrom('users').selectAll().orderBy('name').orderBy('email').execute();
    return rows.map(toAdminUser);
  });

  app.post('/api/admin/users', admin, async (req, reply) => {
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
    return reply.status(201).send(toAdminUser(await getUser(id)));
  });

  app.get('/api/admin/users/:id', admin, async (req) => toAdminUser(await getUser(parse(IdParams, req.params).id)));

  app.put('/api/admin/users/:id', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    const input = parse(UserUpdateInput, req.body);
    const user = await getUser(id);
    const isSelf = actorUserId(req) === id;

    const email = input.email?.trim().toLowerCase();
    if (email && email !== user.email) await assertEmailFree(email, id);

    if (input.role && input.role !== user.role && user.role === 'admin') {
      if (isSelf) throw conflict('You cannot change your own role');
      if ((await countAdmins(db)) <= 1) throw conflict('The last admin cannot be demoted');
    }
    if (input.password === null && isSelf) throw badRequest('You cannot remove your own password');

    const passwordChanged = input.password !== undefined;
    await db
      .updateTable('users')
      .set({
        ...(email ? { email } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(passwordChanged ? { password_hash: input.password ? await hashPassword(input.password) : null } : {}),
        updated_at: nowIso(),
      })
      .where('id', '=', id)
      .execute();
    // A new or removed password signs the user out everywhere (except the admin's own current session).
    if (passwordChanged) await deleteUserSessions(db, id, isSelf ? req.cookies[SESSION_COOKIE] : null);

    await auditRequest(db, req, 'user.update', 'user', id, {
      fields: Object.keys(input).filter((k) => k !== 'password'),
      ...(passwordChanged ? { passwordChanged: true } : {}),
    });
    return toAdminUser(await getUser(id));
  });

  app.delete('/api/admin/users/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const user = await getUser(id);
    if (actorUserId(req) === id) throw conflict('You cannot delete yourself');
    if (user.role === 'admin' && (await countAdmins(db)) <= 1) throw conflict('The last admin cannot be deleted');
    // Sessions cascade; authored records keep their content with created_by = NULL.
    await db.deleteFrom('users').where('id', '=', id).execute();
    await auditRequest(db, req, 'user.delete', 'user', id, { email: user.email });
    return reply.status(204).send();
  });

  // --- API tokens -------------------------------------------------------------------

  app.get('/api/admin/api-tokens', admin, async (): Promise<AdminApiToken[]> => {
    const rows = await db
      .selectFrom('api_tokens')
      .select(['id', 'name', 'role', 'created_at', 'last_used_at'])
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((t) => ({ id: t.id, name: t.name, role: t.role, createdAt: t.created_at, lastUsedAt: t.last_used_at }));
  });

  app.post('/api/admin/api-tokens', admin, async (req, reply) => {
    const input = parse(ApiTokenCreateInput, req.body);
    const id = newId();
    const token = newApiToken();
    const now = nowIso();
    await db
      .insertInto('api_tokens')
      .values({
        id,
        name: input.name,
        role: input.role,
        token_hash: sha256(token),
        created_by: actorUserId(req),
        created_at: now,
        last_used_at: null,
      })
      .execute();
    await auditRequest(db, req, 'api_token.create', 'api_token', id, { name: input.name, role: input.role });
    const body: AdminApiToken = { id, name: input.name, role: input.role, createdAt: now, lastUsedAt: null, token };
    return reply.status(201).send(body);
  });

  app.delete('/api/admin/api-tokens/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const row = await db.selectFrom('api_tokens').select(['name']).where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound('API token');
    await db.deleteFrom('api_tokens').where('id', '=', id).execute();
    await auditRequest(db, req, 'api_token.delete', 'api_token', id, { name: row.name });
    return reply.status(204).send();
  });
}
