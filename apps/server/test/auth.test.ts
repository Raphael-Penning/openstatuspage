import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { sha256 } from '../src/lib/crypto.js';
import { cleanupExpiredSessions } from '../src/services/sessions.js';
import { createOrResetLocalUser, insertApiToken } from '../src/services/users.js';
import { PASSWORD, client, createTestApp, createUser, data, doc, errors, login, loginRequest, page, type TestApp } from './helpers.js';

const HOUR_MS = 3600_000;

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('login / logout / session', () => {
  it('logs in, reports the session and logs out', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin', name: 'Ada Admin' });

    const res = await t.app.inject(loginRequest('Admin@Example.com', PASSWORD));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.api+json');
    expect(res.json()).toMatchObject({
      jsonapi: { version: '1.1' },
      data: { type: 'sessions', id: 'current', relationships: { user: { data: { type: 'users' } } } },
      included: [{ type: 'users', attributes: { email: 'admin@example.com' } }],
    });
    expect(data<{ user: object }>(res).user).toMatchObject({ email: 'admin@example.com', role: 'admin', hasPassword: true });
    const cookie = res.cookies.find((c) => c.name === 'osp_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.secure).toBe(true); // BASE_URL is https
    // Only the hash is stored.
    const stored = await t.db.selectFrom('sessions').select('id').execute();
    expect(stored).toEqual([{ id: sha256(cookie.value) }]);

    const headers = { cookie: `osp_session=${cookie.value}` };
    const session = await t.app.inject({ method: 'GET', url: '/api/auth/session', headers });
    expect(session.statusCode).toBe(200);
    expect(data(session)).toMatchObject({ id: 'current', user: { name: 'Ada Admin' }, oidcEnabled: false });

    const logout = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...headers, 'x-requested-with': 'openstatuspage' },
    });
    expect(logout.statusCode).toBe(204);
    expect(await t.db.selectFrom('sessions').select('id').execute()).toEqual([]);
    const after = await t.app.inject({ method: 'GET', url: '/api/auth/session', headers });
    expect(after.statusCode).toBe(401);
  });

  it('returns the same generic error for unknown users and wrong passwords', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const wrong = await t.app.inject(loginRequest('admin@example.com', 'nope-nope-nope'));
    const unknown = await t.app.inject(loginRequest('ghost@example.com', 'nope-nope-nope'));
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(errors(wrong)).toEqual([expect.objectContaining({ status: '401', code: 'invalid_credentials' })]);
  });

  it('only accepts a JSON:API "sessions" document for login', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const plain = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: PASSWORD },
    });
    expect(plain.statusCode).toBe(415);
    expect(errors(plain)[0]).toMatchObject({ code: 'unsupported_media_type' });

    const wrongType = await t.app.inject({
      ...loginRequest('admin@example.com', PASSWORD),
      payload: JSON.stringify(doc('users', { email: 'admin@example.com', password: PASSWORD })),
    });
    expect(wrongType.statusCode).toBe(409);
    expect(errors(wrongType)[0]).toMatchObject({ code: 'type_mismatch', source: { pointer: '/data/type' } });

    const invalid = await t.app.inject(loginRequest('not-an-email', PASSWORD));
    expect(invalid.statusCode).toBe(400);
    expect(errors(invalid)[0]).toMatchObject({ source: { pointer: '/data/attributes/email' } });
  });

  it('rejects users without a local password', async () => {
    await createUser(t.db, { email: 'sso@example.com', role: 'editor', password: null });
    const res = await t.app.inject(loginRequest('sso@example.com', PASSWORD));
    expect(res.statusCode).toBe(401);
  });

  it('rate limits login attempts per client', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      // A different account each time, so only the per-client limit applies.
      const res = await t.app.inject(loginRequest(`ghost${i}@example.com`, 'nope'));
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('throttles failed logins per account whatever the client address', async () => {
    const proxied = await createTestApp({ TRUST_PROXY: '1' });
    try {
      await createUser(proxied.db, { email: 'admin@example.com', role: 'admin' });
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) {
        // A client that may set X-Forwarded-For gets a new address for every attempt.
        const res = await proxied.app.inject(
          loginRequest('Admin@example.com', `wrong-password-${i}`, { 'x-forwarded-for': `198.51.100.${i + 1}` }),
        );
        codes.push(res.statusCode);
        if (res.statusCode === 429) {
          expect(errors(res)[0]).toMatchObject({ code: 'rate_limited' });
          expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        }
      }
      expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
      expect(codes).toContain(429);
      // Even the right password waits while the account is blocked.
      const blocked = await proxied.app.inject(loginRequest('admin@example.com', PASSWORD, { 'x-forwarded-for': '198.51.100.99' }));
      expect(blocked.statusCode).toBe(429);
      // Other accounts are not affected.
      await createUser(proxied.db, { email: 'editor@example.com', role: 'editor' });
      const other = await proxied.app.inject(loginRequest('editor@example.com', PASSWORD, { 'x-forwarded-for': '198.51.100.98' }));
      expect(other.statusCode).toBe(200);
    } finally {
      await proxied.close();
    }
  });

  it('counts concurrent failed logins for one account before any password is checked', async () => {
    const proxied = await createTestApp({ TRUST_PROXY: '1' });
    try {
      await createUser(proxied.db, { email: 'admin@example.com', role: 'admin' });
      // A burst sent at the same moment, each from a new forwarded address.
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          proxied.app.inject(loginRequest('admin@example.com', `wrong-password-${i}`, { 'x-forwarded-for': `198.51.100.${i + 1}` })),
        ),
      );
      const codes = responses.map((res) => res.statusCode);
      // Three free failures plus the one that starts the block are checked; the rest wait.
      expect(codes.filter((c) => c === 401)).toHaveLength(4);
      expect(codes.filter((c) => c === 429)).toHaveLength(6);
    } finally {
      await proxied.close();
    }
  });

  it('lets a valid password through after failures below the limit and clears them', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    for (let i = 0; i < 3; i++) {
      expect((await t.app.inject(loginRequest('admin@example.com', `wrong-password-${i}`))).statusCode).toBe(401);
    }
    expect((await t.app.inject(loginRequest('admin@example.com', PASSWORD))).statusCode).toBe(200);
    // The success reset the count: three more failures are free again.
    for (let i = 0; i < 3; i++) {
      expect((await t.app.inject(loginRequest('admin@example.com', `wrong-again-${i}`))).statusCode).toBe(401);
    }
    expect((await t.app.inject(loginRequest('admin@example.com', PASSWORD))).statusCode).toBe(200);
  });

  it('expires sessions and extends them (sliding expiry)', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const cookie = await login(t.app, 'admin@example.com');

    // Pretend half the lifetime has passed: the request extends the session and re-sends the cookie.
    const soon = new Date(Date.now() + 3600_000).toISOString();
    await t.db.updateTable('sessions').set({ expires_at: soon }).execute();
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.some((c) => c.name === 'osp_session')).toBe(true);
    const row = await t.db.selectFrom('sessions').select('expires_at').executeTakeFirstOrThrow();
    expect(row.expires_at > soon).toBe(true);

    // Expired sessions are rejected and removed.
    await t.db.updateTable('sessions').set({ expires_at: new Date(Date.now() - 1000).toISOString() }).execute();
    const expired = await t.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    expect(expired.statusCode).toBe(401);
    expect(await t.db.selectFrom('sessions').select('id').execute()).toEqual([]);
  });

  it('never extends a session past its absolute lifetime', async () => {
    expect(t.config.SESSION_MAX_AGE_HOURS).toBe(720);
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const cookie = await login(t.app, 'admin@example.com');
    const session = () => t.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });

    // 3 hours before the absolute end: the sliding expiry stops there instead of now + TTL.
    const createdAt = Date.now() - 717 * HOUR_MS;
    await t.db
      .updateTable('sessions')
      .set({ created_at: new Date(createdAt).toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() })
      .execute();
    const res = await session();
    expect(res.statusCode).toBe(200);
    const row = await t.db.selectFrom('sessions').select('expires_at').executeTakeFirstOrThrow();
    expect(new Date(row.expires_at).getTime()).toBe(createdAt + 720 * HOUR_MS);
    const resent = res.cookies.find((c) => c.name === 'osp_session')!;
    expect(resent.maxAge).toBeLessThanOrEqual(3 * 3600);

    // Past the absolute lifetime the session is gone, even with a later expires_at (older rows).
    await t.db
      .updateTable('sessions')
      .set({
        created_at: new Date(Date.now() - 721 * HOUR_MS).toISOString(),
        expires_at: new Date(Date.now() + 24 * HOUR_MS).toISOString(),
      })
      .execute();
    expect((await session()).statusCode).toBe(401);
    expect(await t.db.selectFrom('sessions').select('id').execute()).toEqual([]);
  });

  it('validates SESSION_MAX_AGE_HOURS', () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:' };
    expect(loadConfig(base).SESSION_MAX_AGE_HOURS).toBe(720);
    // The default follows a longer sliding lifetime, so existing setups keep working.
    expect(loadConfig({ ...base, SESSION_TTL_HOURS: '2160' }).SESSION_MAX_AGE_HOURS).toBe(2160);
    expect(loadConfig({ ...base, SESSION_MAX_AGE_HOURS: '24', SESSION_TTL_HOURS: '12' }).SESSION_MAX_AGE_HOURS).toBe(24);
    expect(() => loadConfig({ ...base, SESSION_MAX_AGE_HOURS: '24' })).toThrow(/SESSION_MAX_AGE_HOURS/);
    expect(() => loadConfig({ ...base, SESSION_MAX_AGE_HOURS: '8761' })).toThrow(/SESSION_MAX_AGE_HOURS/);
  });

  it('cleans up expired sessions', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    await login(t.app, 'admin@example.com');
    await login(t.app, 'admin@example.com');
    await t.db
      .updateTable('sessions')
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where('id', '=', (await t.db.selectFrom('sessions').select('id').executeTakeFirstOrThrow()).id)
      .execute();
    expect(await cleanupExpiredSessions(t.db)).toBe(1);
    expect(await t.db.selectFrom('sessions').select('id').execute()).toHaveLength(1);
  });

  it('changes the password, signs out other sessions and rotates the current one', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const first = await login(t.app, 'admin@example.com');
    const second = await login(t.app, 'admin@example.com');
    const c = client(t.app, { cookie: first });

    const bad = await c.post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'a-new-long-password' });
    expect(bad.statusCode).toBe(400);
    const ok = await c.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'a-new-long-password' });
    expect(ok.statusCode).toBe(204);
    const rotated = ok.cookies.find((cookie) => cookie.name === 'osp_session')!;
    expect(`osp_session=${rotated.value}`).not.toBe(first);

    const session = (cookie: string) => t.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    expect((await session(`osp_session=${rotated.value}`)).statusCode).toBe(200);
    expect((await session(first)).statusCode).toBe(401);
    expect((await session(second)).statusCode).toBe(401);
    expect(await t.db.selectFrom('sessions').select('id').execute()).toEqual([{ id: sha256(rotated.value) }]);
    await login(t.app, 'admin@example.com', 'a-new-long-password');
  });

  it('rotates the session when admins change their own password in user management', async () => {
    const adminId = await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const first = await login(t.app, 'admin@example.com');
    const res = await client(t.app, { cookie: first }).patch(`/api/admin/users/${adminId}`, { password: 'a-new-long-password' });
    expect(res.statusCode).toBe(200);
    const rotated = res.cookies.find((cookie) => cookie.name === 'osp_session')!;
    const session = (cookie: string) => t.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    expect((await session(first)).statusCode).toBe(401);
    expect((await session(`osp_session=${rotated.value}`)).statusCode).toBe(200);
  });

  it('exposes the auth configuration', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(res.json().data).toMatchObject({ type: 'auth-configs', id: 'current' });
    expect(data(res)).toEqual({ id: 'current', oidcEnabled: false, oidcLabel: 'Single Sign-On', localLoginEnabled: true });
    const oidc = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    expect(oidc.statusCode).toBe(404);
  });
});

describe('authorization', () => {
  it('requires authentication for the admin API', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/admin/services' });
    expect(res.statusCode).toBe(401);
    expect(res.json().errors[0]).toMatchObject({ status: '401', code: 'unauthorized' });
  });

  it('enforces roles (editor < admin)', async () => {
    await createUser(t.db, { email: 'editor@example.com', role: 'editor' });
    const editor = client(t.app, { cookie: await login(t.app, 'editor@example.com') });

    expect((await editor.get('/api/admin/services')).statusCode).toBe(200);
    expect((await editor.get('/api/admin/overview')).statusCode).toBe(200);
    expect((await editor.post('/api/admin/services', { name: 'API' })).statusCode).toBe(403);
    expect((await editor.post('/api/admin/locations', { name: 'X', region: 'europe' })).statusCode).toBe(403);
    expect((await editor.get('/api/admin/users')).statusCode).toBe(403);
    expect((await editor.get('/api/admin/monitor-sources')).statusCode).toBe(403);
    expect((await editor.patch('/api/admin/settings', { siteName: 'X' })).statusCode).toBe(403);
    const incident = await editor.post('/api/admin/incidents', { title: 'Slow', message: 'Investigating' });
    expect(incident.statusCode).toBe(201);
  });

  it('requires the CSRF header for cookie-authenticated mutations', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const cookie = await login(t.app, 'admin@example.com');

    const without = await t.app.inject({
      method: 'POST',
      url: '/api/admin/service-groups',
      headers: { cookie, 'content-type': 'application/vnd.api+json' },
      payload: doc('service-groups', { name: 'Platform' }),
    });
    expect(without.statusCode).toBe(403);

    const read = await t.app.inject({ method: 'GET', url: '/api/admin/service-groups', headers: { cookie } });
    expect(read.statusCode).toBe(200);

    const withHeader = await t.app.inject({
      method: 'POST',
      url: '/api/admin/service-groups',
      headers: { cookie, 'x-requested-with': 'openstatuspage', 'content-type': 'application/vnd.api+json' },
      payload: doc('service-groups', { name: 'Platform' }),
    });
    expect(withHeader.statusCode).toBe(201);

    const logout = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(403);
  });

  it('authenticates and checks CSRF on encoded spellings of the routes like on the canonical ones', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const cookie = await login(t.app, 'admin@example.com');

    // The router decodes the path, so these reach the admin and auth handlers.
    const read = await t.app.inject({ method: 'GET', url: '/api/%61dmin/service-groups', headers: { cookie } });
    expect(read.statusCode).toBe(200);
    const session = await t.app.inject({ method: 'GET', url: '/api/%61uth/session', headers: { cookie } });
    expect(session.statusCode).toBe(200);

    const write = await t.app.inject({
      method: 'POST',
      url: '/api/%61dmin/service-groups',
      headers: { cookie, 'content-type': 'application/vnd.api+json' },
      payload: doc('service-groups', { name: 'Platform' }),
    });
    expect(write.statusCode).toBe(403);

    // Logout without the CSRF header is refused and keeps the session.
    for (const url of ['/api/%61uth/logout', '/%61pi/auth/logout', '/api/auth/%6cogout']) {
      const logout = await t.app.inject({ method: 'POST', url, headers: { cookie } });
      expect(logout.statusCode, url).toBe(403);
    }
    expect(await t.db.selectFrom('sessions').select('id').execute()).toHaveLength(1);
  });

  it('authenticates API tokens without CSRF header and honours their role', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const admin = client(t.app, { cookie: await login(t.app, 'admin@example.com') });
    const created = await admin.post('/api/admin/api-tokens', { name: 'CI', role: 'editor' });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({ type: 'api-tokens', attributes: { name: 'CI' } });
    const { token, id } = data<{ token: string; id: string }>(created);
    expect(created.headers.location).toBe(`/api/admin/api-tokens/${id}`);
    expect(token).toMatch(/^osp_/);

    const list = await admin.get('/api/admin/api-tokens');
    expect(data(list)).toEqual([expect.objectContaining({ id, name: 'CI', role: 'editor', lastUsedAt: null })]);
    expect(list.body).not.toContain(token);

    const bot = client(t.app, { token });
    expect((await bot.post('/api/admin/incidents', { title: 'From CI', message: 'Deploy failed' })).statusCode).toBe(201);
    expect((await bot.post('/api/admin/service-groups', { name: 'Nope' })).statusCode).toBe(403);
    expect((await client(t.app, { token: 'osp_invalid' }).get('/api/admin/services')).statusCode).toBe(401);

    const audit = await admin.get('/api/admin/audit-log?filter[entityType]=incident');
    expect(page(audit).items[0]).toMatchObject({ action: 'incident.create', userId: null, details: { apiToken: 'CI' } });
    const tokens = await admin.get('/api/admin/api-tokens');
    expect(data<{ lastUsedAt: string | null }[]>(tokens)[0]!.lastUsedAt).not.toBeNull();

    expect((await admin.delete(`/api/admin/api-tokens/${id}`)).statusCode).toBe(204);
    expect((await bot.get('/api/admin/services')).statusCode).toBe(401);
  });
});

describe('user management guards', () => {
  it('cannot delete or demote yourself or the last admin', async () => {
    const adminId = await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const admin = client(t.app, { cookie: await login(t.app, 'admin@example.com') });

    expect((await admin.delete(`/api/admin/users/${adminId}`)).statusCode).toBe(409);
    expect((await admin.patch(`/api/admin/users/${adminId}`, { role: 'editor' })).statusCode).toBe(409);

    const created = await admin.post('/api/admin/users', {
      email: 'second@example.com',
      name: 'Second',
      role: 'admin',
      password: 'another-long-password',
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toMatch(/^\/api\/admin\/users\//);
    const second = data<{ id: string }>(created);
    expect(second).toMatchObject({ email: 'second@example.com', hasPassword: true, oidcLinked: false });
    expect(created.body).not.toContain('password_hash');

    const duplicate = await admin.post('/api/admin/users', { email: 'second@example.com', name: 'X', role: 'editor' });
    expect(duplicate.statusCode).toBe(409);

    // Demoting another admin works while another admin remains.
    const demoted = await admin.patch(`/api/admin/users/${second.id}`, { role: 'editor' });
    expect(demoted.statusCode).toBe(200);
    expect(data<{ role: string }>(demoted).role).toBe('editor');
    expect((await admin.delete(`/api/admin/users/${second.id}`)).statusCode).toBe(204);
  });

  it('lists users as a JSON:API collection and checks PATCH documents', async () => {
    const adminId = await createUser(t.db, { email: 'admin@example.com', role: 'admin', name: 'Ada' });
    const admin = client(t.app, { cookie: await login(t.app, 'admin@example.com') });

    const list = await admin.get('/api/admin/users');
    expect(list.headers['content-type']).toBe('application/vnd.api+json');
    expect(list.json()).toMatchObject({
      jsonapi: { version: '1.1' },
      data: [{ type: 'users', id: adminId, attributes: { email: 'admin@example.com', name: 'Ada' }, links: { self: `/api/admin/users/${adminId}` } }],
      meta: { total: 1 },
    });
    expect(list.body).not.toContain('password_hash');

    const mismatch = await admin.patch(`/api/admin/users/${adminId}`, { data: { type: 'users', id: 'other', attributes: { name: 'X' } } });
    expect(mismatch.statusCode).toBe(409);
    expect(errors(mismatch)[0]).toMatchObject({ code: 'id_mismatch' });
    const renamed = await admin.patch(`/api/admin/users/${adminId}`, doc('users', { name: 'Ada L.' }, { id: adminId }));
    expect(data<{ name: string }>(renamed).name).toBe('Ada L.');

    const invalid = await admin.post('/api/admin/users', { email: 'nope', name: 'X', role: 'editor' });
    expect(invalid.statusCode).toBe(400);
    expect(errors(invalid)[0]).toMatchObject({ source: { pointer: '/data/attributes/email' } });
  });

  it("revokes the user's sessions and API tokens when an admin resets their password", async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const userId = await createUser(t.db, { email: 'second@example.com', role: 'admin' });
    const admin = client(t.app, { cookie: await login(t.app, 'admin@example.com') });
    const ownCookie = await login(t.app, 'second@example.com');
    const own = client(t.app, { cookie: ownCookie });
    const { token } = data<{ token: string }>(await own.post('/api/admin/api-tokens', { name: 'ops', role: 'editor' }));
    const { token: otherToken } = data<{ token: string }>(await admin.post('/api/admin/api-tokens', { name: 'ci', role: 'editor' }));

    expect((await admin.patch(`/api/admin/users/${userId}`, { password: 'a-brand-new-password' })).statusCode).toBe(200);
    expect((await own.get('/api/admin/overview')).statusCode).toBe(401);
    expect((await client(t.app, { token }).get('/api/admin/overview')).statusCode).toBe(401);
    // Tokens of other users stay valid.
    expect((await client(t.app, { token: otherToken }).get('/api/admin/overview')).statusCode).toBe(200);
  });

  it('protects the last admin against other admins being removed via token', async () => {
    const adminId = await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const admin = client(t.app, { cookie: await login(t.app, 'admin@example.com') });
    const { token } = data<{ token: string }>(await admin.post('/api/admin/api-tokens', { name: 'ops', role: 'admin' }));
    const bot = client(t.app, { token });
    expect((await bot.delete(`/api/admin/users/${adminId}`)).statusCode).toBe(409);
    expect((await bot.patch(`/api/admin/users/${adminId}`, { role: 'editor' })).statusCode).toBe(409);
  });
});

describe('token ownership', () => {
  it('assigns tokens created with a token to the owner of that token', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const secondId = await createUser(t.db, { email: 'second@example.com', role: 'admin' });
    const admin = client(t.app, { cookie: await login(t.app, 'admin@example.com') });
    const second = client(t.app, { cookie: await login(t.app, 'second@example.com') });
    const { token } = data<{ token: string }>(await second.post('/api/admin/api-tokens', { name: 'parent', role: 'admin' }));

    const child = await client(t.app, { token }).post('/api/admin/api-tokens', { name: 'child', role: 'admin' });
    expect(child.statusCode).toBe(201);
    const childToken = data<{ id: string; token: string }>(child);
    const row = await t.db.selectFrom('api_tokens').select('created_by').where('id', '=', childToken.id).executeTakeFirstOrThrow();
    expect(row.created_by).toBe(secondId);

    // Demoting the owner revokes both tokens.
    expect((await admin.patch(`/api/admin/users/${secondId}`, { role: 'editor' })).statusCode).toBe(200);
    expect((await client(t.app, { token: childToken.token }).get('/api/admin/overview')).statusCode).toBe(401);
    expect((await client(t.app, { token }).get('/api/admin/overview')).statusCode).toBe(401);
  });
});

describe('api token owner check', () => {
  it('stores a token only while its owner is still an admin', async () => {
    const ownerId = await createUser(t.db, { email: 'owner@example.com', role: 'admin' });
    const token = (id: string, createdBy: string | null) => ({
      id,
      name: id,
      role: 'admin' as const,
      tokenHash: sha256(id),
      createdBy,
      createdAt: new Date().toISOString(),
    });
    expect(await insertApiToken(t.db, token('first', ownerId))).toBe(true);

    // Demoted after the request was authorized: the insert re-checks and stores nothing.
    await t.db.updateTable('users').set({ role: 'editor' }).where('id', '=', ownerId).execute();
    expect(await insertApiToken(t.db, token('second', ownerId))).toBe(false);
    expect(await insertApiToken(t.db, token('gone', 'no-such-user'))).toBe(false);
    // Tokens without a known owner are not tied to a user's role.
    expect(await insertApiToken(t.db, token('orphan', null))).toBe(true);
    const ids = await t.db.selectFrom('api_tokens').select('id').orderBy('id').execute();
    expect(ids.map((r) => r.id)).toEqual(['first', 'orphan']);
  });
});

describe('create-user reset', () => {
  it('sets the password, ends existing sessions and creates new users', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const cookie = await login(t.app, 'admin@example.com');
    const { token } = data<{ token: string }>(
      await client(t.app, { cookie }).post('/api/admin/api-tokens', { name: 'ops', role: 'editor' }),
    );

    const reset = await createOrResetLocalUser(t.db, {
      email: 'Admin@Example.com',
      password: 'a-new-long-password',
      role: 'admin',
      name: 'Ignored',
    });
    expect(reset).toEqual({ ok: true, created: false });
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } })).statusCode).toBe(401);
    // A reset recovers a compromised account: the tokens it created are revoked too.
    expect((await client(t.app, { token }).get('/api/admin/overview')).statusCode).toBe(401);
    await login(t.app, 'admin@example.com', 'a-new-long-password');

    const created = await createOrResetLocalUser(t.db, {
      email: 'new@example.com',
      password: 'another-long-password',
      role: 'editor',
      name: 'New',
    });
    expect(created).toEqual({ ok: true, created: true });
    await login(t.app, 'new@example.com', 'another-long-password');
  });

  it('refuses accounts linked to an SSO identity unless the link is removed', async () => {
    const id = await createUser(t.db, { email: 'newhire@example.com', role: 'editor', password: null });
    await t.db.updateTable('users').set({ oidc_subject: 'idp-subject' }).where('id', '=', id).execute();
    const input = { email: 'newhire@example.com', password: 'a-new-long-password', role: 'admin' as const, name: 'X' };

    expect(await createOrResetLocalUser(t.db, input)).toEqual({ ok: false, error: 'oidc_linked' });
    const unchanged = await t.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(unchanged).toMatchObject({ role: 'editor', password_hash: null, oidc_subject: 'idp-subject' });

    expect(await createOrResetLocalUser(t.db, input, { unlinkOidc: true })).toEqual({ ok: true, created: false });
    const reset = await t.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(reset).toMatchObject({ role: 'admin', oidc_subject: null });
    await login(t.app, 'newhire@example.com', 'a-new-long-password');
  });

  it('applies the demotion rules', async () => {
    const adminId = await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const input = { email: 'admin@example.com', password: 'a-new-long-password', role: 'editor' as const, name: 'X' };

    // The last admin is refused and stays unchanged.
    expect(await createOrResetLocalUser(t.db, input)).toEqual({ ok: false, error: 'last_admin' });
    await login(t.app, 'admin@example.com');

    await createUser(t.db, { email: 'second@example.com', role: 'admin' });
    const admin = client(t.app, { cookie: await login(t.app, 'admin@example.com') });
    const { token } = data<{ token: string }>(await admin.post('/api/admin/api-tokens', { name: 'ops', role: 'admin' }));
    expect(await createOrResetLocalUser(t.db, input)).toEqual({ ok: true, created: false });
    const user = await t.db.selectFrom('users').select('role').where('id', '=', adminId).executeTakeFirstOrThrow();
    expect(user.role).toBe('editor');
    // Admin tokens of the demoted user are revoked.
    expect((await client(t.app, { token }).get('/api/admin/overview')).statusCode).toBe(401);
  });
});

describe('dashboard activity', () => {
  it('shows editors only the audit entries of what they manage', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    await createUser(t.db, { email: 'editor@example.com', role: 'editor' });
    const admin = client(t.app, { cookie: await login(t.app, 'admin@example.com') });
    const editor = client(t.app, { cookie: await login(t.app, 'editor@example.com') });

    await admin.post('/api/admin/users', { email: 'x@example.com', name: 'X', role: 'admin', password: 'a-long-password' });
    await admin.post('/api/admin/api-tokens', { name: 'ops', role: 'admin' });
    await editor.post('/api/admin/incidents', { title: 'Slow', message: 'Investigating' });

    const types = async (c: typeof admin) =>
      data<{ recentAudit: { entityType: string }[] }>(await c.get('/api/admin/overview')).recentAudit.map((e) => e.entityType);
    expect(await types(editor)).toEqual(['incident']);
    expect(await types(admin)).toEqual(expect.arrayContaining(['incident', 'user', 'api_token']));
  });
});
