import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/lib/crypto.js';
import { cleanupExpiredSessions } from '../src/services/sessions.js';
import { PASSWORD, client, createTestApp, createUser, login, type TestApp } from './helpers.js';

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

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'Admin@Example.com', password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email: 'admin@example.com', role: 'admin', hasPassword: true });
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
    expect(session.json()).toMatchObject({ user: { name: 'Ada Admin' }, oidcEnabled: false });

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
    const wrong = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'nope-nope-nope' },
    });
    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ghost@example.com', password: 'nope-nope-nope' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('rejects users without a local password', async () => {
    await createUser(t.db, { email: 'sso@example.com', role: 'editor', password: null });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'sso@example.com', password: PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rate limits login attempts', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'ghost@example.com', password: 'nope' },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
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

  it('changes the password and signs out other sessions', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const first = await login(t.app, 'admin@example.com');
    const second = await login(t.app, 'admin@example.com');
    const c = client(t.app, { cookie: first });

    const bad = await c.post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'a-new-long-password' });
    expect(bad.statusCode).toBe(400);
    const ok = await c.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'a-new-long-password' });
    expect(ok.statusCode).toBe(204);

    expect((await t.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: first } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: second } })).statusCode).toBe(401);
    await login(t.app, 'admin@example.com', 'a-new-long-password');
  });

  it('exposes the auth configuration', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(res.json()).toEqual({ oidcEnabled: false, oidcLabel: 'Single Sign-On', localLoginEnabled: true });
    const oidc = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    expect(oidc.statusCode).toBe(404);
  });
});

describe('authorization', () => {
  it('requires authentication for the admin API', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/admin/services' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
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
    expect((await editor.put('/api/admin/settings', { siteName: 'X' })).statusCode).toBe(403);
    const incident = await editor.post('/api/admin/incidents', { title: 'Slow', message: 'Investigating' });
    expect(incident.statusCode).toBe(201);
  });

  it('requires the CSRF header for cookie-authenticated mutations', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const cookie = await login(t.app, 'admin@example.com');

    const without = await t.app.inject({
      method: 'POST',
      url: '/api/admin/service-groups',
      headers: { cookie },
      payload: { name: 'Platform' },
    });
    expect(without.statusCode).toBe(403);

    const read = await t.app.inject({ method: 'GET', url: '/api/admin/service-groups', headers: { cookie } });
    expect(read.statusCode).toBe(200);

    const withHeader = await t.app.inject({
      method: 'POST',
      url: '/api/admin/service-groups',
      headers: { cookie, 'x-requested-with': 'openstatuspage' },
      payload: { name: 'Platform' },
    });
    expect(withHeader.statusCode).toBe(201);

    const logout = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(403);
  });

  it('authenticates API tokens without CSRF header and honours their role', async () => {
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const admin = client(t.app, { cookie: await login(t.app, 'admin@example.com') });
    const created = await admin.post('/api/admin/api-tokens', { name: 'CI', role: 'editor' });
    expect(created.statusCode).toBe(201);
    const { token, id } = created.json();
    expect(token).toMatch(/^osp_/);

    const list = await admin.get('/api/admin/api-tokens');
    expect(list.json()).toEqual([expect.objectContaining({ id, name: 'CI', role: 'editor', lastUsedAt: null })]);
    expect(list.body).not.toContain(token);

    const bot = client(t.app, { token });
    expect((await bot.post('/api/admin/incidents', { title: 'From CI', message: 'Deploy failed' })).statusCode).toBe(201);
    expect((await bot.post('/api/admin/service-groups', { name: 'Nope' })).statusCode).toBe(403);
    expect((await client(t.app, { token: 'osp_invalid' }).get('/api/admin/services')).statusCode).toBe(401);

    const audit = await admin.get('/api/admin/audit-log?entityType=incident');
    expect(audit.json().items[0]).toMatchObject({ action: 'incident.create', userId: null, details: { apiToken: 'CI' } });
    const tokens = await admin.get('/api/admin/api-tokens');
    expect(tokens.json()[0].lastUsedAt).not.toBeNull();

    expect((await admin.delete(`/api/admin/api-tokens/${id}`)).statusCode).toBe(204);
    expect((await bot.get('/api/admin/services')).statusCode).toBe(401);
  });
});

describe('user management guards', () => {
  it('cannot delete or demote yourself or the last admin', async () => {
    const adminId = await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const admin = client(t.app, { cookie: await login(t.app, 'admin@example.com') });

    expect((await admin.delete(`/api/admin/users/${adminId}`)).statusCode).toBe(409);
    expect((await admin.put(`/api/admin/users/${adminId}`, { role: 'editor' })).statusCode).toBe(409);

    const created = await admin.post('/api/admin/users', {
      email: 'second@example.com',
      name: 'Second',
      role: 'admin',
      password: 'another-long-password',
    });
    expect(created.statusCode).toBe(201);
    const second = created.json();
    expect(second).toMatchObject({ email: 'second@example.com', hasPassword: true, oidcLinked: false });
    expect(created.body).not.toContain('password_hash');

    const duplicate = await admin.post('/api/admin/users', { email: 'second@example.com', name: 'X', role: 'editor' });
    expect(duplicate.statusCode).toBe(409);

    // Demoting another admin works while another admin remains.
    const demoted = await admin.put(`/api/admin/users/${second.id}`, { role: 'editor' });
    expect(demoted.statusCode).toBe(200);
    expect(demoted.json().role).toBe('editor');
    expect((await admin.delete(`/api/admin/users/${second.id}`)).statusCode).toBe(204);
  });

  it('protects the last admin against other admins being removed via token', async () => {
    const adminId = await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    const admin = client(t.app, { cookie: await login(t.app, 'admin@example.com') });
    const { token } = (await admin.post('/api/admin/api-tokens', { name: 'ops', role: 'admin' })).json();
    const bot = client(t.app, { token });
    expect((await bot.delete(`/api/admin/users/${adminId}`)).statusCode).toBe(409);
    expect((await bot.put(`/api/admin/users/${adminId}`, { role: 'editor' })).statusCode).toBe(409);
  });
});
