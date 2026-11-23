/**
 * SSO providers managed in the admin UI: the admin API (write-only encrypted
 * client secret, read-only environment provider, audit log, discovery test),
 * the login buttons, the login and callback routes bound to their provider,
 * and account linking across several providers.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretBox } from '../src/lib/crypto.js';
import { OIDC_STATE_COOKIE, OidcClient, type Claims } from '../src/services/oidc.js';
import { createSession } from '../src/services/sessions.js';
import { sameIssuer, testOidcDiscovery } from '../src/services/oidc-providers.js';
import {
  adminClient,
  BASE_URL,
  client,
  createTestApp,
  createUser,
  data,
  doc,
  errors,
  login,
  page,
  type Client,
  type TestApp,
} from './helpers.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SECRET = 'super-secret-client-secret-value';

/** A minimal identity provider: discovery document (and odd answers on other paths). */
let idp: Server;
let issuer: string;
beforeAll(async () => {
  idp = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const discovery = (iss: string) => ({
      issuer: iss,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['RS256'],
      subject_types_supported: ['public'],
    });
    if (url.pathname === '/.well-known/openid-configuration') return json(200, discovery(issuer));
    if (url.pathname === '/other/.well-known/openid-configuration') return json(200, discovery(`${issuer}/elsewhere`));
    if (url.pathname === '/moved/.well-known/openid-configuration') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data?token=secret' });
      return res.end();
    }
    if (url.pathname === '/html/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html></html>');
    }
    return json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => idp.close(resolve));
});

let t: TestApp;
let admin: Client;

const ENV = {
  OIDC_ISSUER_URL: 'https://idp.example.com/realms/example',
  OIDC_CLIENT_ID: 'openstatuspage',
  OIDC_CLIENT_SECRET: 'env-secret-value-1234',
  OIDC_LABEL: 'Corporate SSO',
};

async function createProvider(body: Record<string, unknown> = {}): Promise<Any> {
  const res = await admin.post('/api/admin/oidc-providers', {
    name: 'Example IdP',
    issuerUrl: issuer,
    clientId: 'openstatuspage',
    clientSecret: SECRET,
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return data<Any>(res);
}

const auditOf = () =>
  t.db
    .selectFrom('audit_log')
    .select(['action', 'details'])
    .where('entity_type', '=', 'oidc_provider')
    .orderBy('created_at')
    .execute();

/** Runs the callback of `providerId` with a signed state cookie of `stateProvider`. */
async function callback(providerId: string, stateProvider = providerId, cookie = '') {
  const state = { p: stateProvider, v: 'verifier', s: 'state', n: 'nonce', e: Date.now() + 60_000 };
  const signed = t.app.signCookie(JSON.stringify(state));
  const path = providerId === 'env' ? '/api/auth/oidc/callback' : `/api/auth/oidc/${providerId}/callback`;
  return t.app.inject({
    method: 'GET',
    url: `${path}?code=x&state=state`,
    headers: { cookie: `${cookie ? `${cookie}; ` : ''}${OIDC_STATE_COOKIE}=${encodeURIComponent(signed)}` },
  });
}

/** Mocks the code exchange of the next callbacks with these claims. */
const claims = (value: Claims) => vi.spyOn(OidcClient.prototype, 'finishLogin').mockResolvedValue(value);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('admin API', () => {
  beforeEach(async () => {
    t = await createTestApp(ENV);
    admin = await adminClient(t);
  });
  afterEach(async () => {
    await t.close();
  });

  it('stores the client secret encrypted and never returns it', async () => {
    const provider = await createProvider({ allowedDomains: ['Example.com'], roleMappings: [{ value: 'admins', role: 'admin' }] });
    expect(provider).toMatchObject({
      name: 'Example IdP',
      source: 'database',
      readOnly: false,
      hasClientSecret: true,
      enabled: true,
      scopes: 'openid email profile',
      autoCreateUsers: false,
      linkByEmail: false,
      allowedDomains: ['example.com'],
      roleClaim: 'groups',
      roleMappings: [{ value: 'admins', role: 'admin' }],
      defaultRole: 'editor',
      roleSync: 'login',
      callbackUrl: `${BASE_URL}/api/auth/oidc/${provider.id}/callback`,
      loginPath: `/api/auth/oidc/${provider.id}/login`,
      linkedUsers: 0,
    });
    expect(provider).not.toHaveProperty('clientSecret');

    const row = await t.db.selectFrom('oidc_providers').selectAll().where('id', '=', provider.id).executeTakeFirstOrThrow();
    expect(row.client_secret).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(new SecretBox(t.config.SECRET_KEY).decrypt(row.client_secret!)).toBe(SECRET);

    for (const res of [await admin.get('/api/admin/oidc-providers'), await admin.get(`/api/admin/oidc-providers/${provider.id}`)]) {
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain(row.client_secret!);
      expect(res.body).not.toContain(ENV.OIDC_CLIENT_SECRET);
    }
    expect(JSON.stringify(await auditOf())).not.toContain(SECRET);
  });

  it('keeps, replaces and removes the secret on update', async () => {
    const provider = await createProvider();
    const stored = async () =>
      (await t.db.selectFrom('oidc_providers').select('client_secret').where('id', '=', provider.id).executeTakeFirstOrThrow())
        .client_secret;
    const before = await stored();

    const renamed = await admin.patch(`/api/admin/oidc-providers/${provider.id}`, { name: 'Renamed', sortOrder: 3 });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(data<Any>(renamed)).toMatchObject({ name: 'Renamed', sortOrder: 3, hasClientSecret: true, issuerUrl: issuer });
    expect(await stored()).toBe(before);

    await admin.patch(`/api/admin/oidc-providers/${provider.id}`, { clientSecret: 'another-secret' });
    expect(new SecretBox(t.config.SECRET_KEY).decrypt((await stored())!)).toBe('another-secret');

    const removed = await admin.patch(`/api/admin/oidc-providers/${provider.id}`, { clientSecret: null });
    expect(data<Any>(removed).hasClientSecret).toBe(false);
    expect(await stored()).toBeNull();

    const audit = await auditOf();
    expect(audit.map((a) => a.action)).toEqual([
      'oidc_provider.create',
      'oidc_provider.update',
      'oidc_provider.update',
      'oidc_provider.update',
    ]);
    expect(JSON.parse(audit[1]!.details!)).toMatchObject({ fields: ['name', 'sortOrder'] });
    expect(JSON.parse(audit[2]!.details!)).toMatchObject({ fields: ['clientSecret'], clientSecret: 'set' });
    expect(JSON.parse(audit[3]!.details!)).toMatchObject({ clientSecret: 'removed' });
    expect(JSON.stringify(audit)).not.toContain('another-secret');
  });

  it('needs a new secret for a new issuer and unlinks the users of the old one', async () => {
    const provider = await createProvider();
    const userId = await createUser(t.db, { email: 'jane@example.com', role: 'admin' });
    await t.db
      .insertInto('user_oidc_identities')
      .values({ provider_id: provider.id, subject: 'jane', user_id: userId, created_at: new Date().toISOString(), last_login_at: null })
      .execute();
    const url = `/api/admin/oidc-providers/${provider.id}`;
    const stored = async () =>
      (await t.db.selectFrom('oidc_providers').select(['issuer_url', 'client_secret']).where('id', '=', provider.id).executeTakeFirstOrThrow());
    const before = await stored();

    // The stored secret never travels to another issuer.
    const moved = await admin.patch(url, { issuerUrl: 'https://attacker.example.com' });
    expect(moved.statusCode).toBe(400);
    expect(errors(moved)[0]).toMatchObject({ code: 'secret_required', source: { pointer: '/data/attributes/clientSecret' } });
    expect(await stored()).toEqual(before);
    expect(data<Any>(await admin.get(url)).linkedUsers).toBe(1);

    // Other changes keep secret and links.
    expect((await admin.patch(url, { clientId: 'other-client' })).statusCode).toBe(200);
    expect(data<Any>(await admin.get(url)).linkedUsers).toBe(1);

    const ok = await admin.patch(url, { issuerUrl: 'https://idp2.example.com', clientSecret: 'a-new-secret' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(data<Any>(ok)).toMatchObject({ issuerUrl: 'https://idp2.example.com', hasClientSecret: true, linkedUsers: 0 });
    expect(new SecretBox(t.config.SECRET_KEY).decrypt((await stored()).client_secret!)).toBe('a-new-secret');
    expect(await t.db.selectFrom('user_oidc_identities').select('subject').execute()).toEqual([]);
    expect(await t.db.selectFrom('users').select('id').where('id', '=', userId).execute()).toHaveLength(1);

    // Without a stored secret (public client) no secret is needed.
    await admin.patch(url, { clientSecret: null });
    expect((await admin.patch(url, { issuerUrl: 'https://idp3.example.com' })).statusCode).toBe(200);

    const audit = (await auditOf()).filter((a) => JSON.parse(a.details!).previousIssuerUrl);
    expect(audit.map((a) => JSON.parse(a.details!))).toMatchObject([
      { previousIssuerUrl: issuer, issuerUrl: 'https://idp2.example.com', unlinkedUsers: 1, clientSecret: 'set' },
      { previousIssuerUrl: 'https://idp2.example.com', issuerUrl: 'https://idp3.example.com', unlinkedUsers: 0 },
    ]);
    expect(JSON.stringify(await auditOf())).not.toContain('a-new-secret');
  });

  it('lists the environment provider first and read-only', async () => {
    await createProvider({ name: 'B', sortOrder: 2 });
    await createProvider({ name: 'A', sortOrder: 1 });
    const list = page<Any>(await admin.get('/api/admin/oidc-providers')).items;
    expect(list.map((p: Any) => [p.name, p.source])).toEqual([
      ['Corporate SSO', 'environment'],
      ['A', 'database'],
      ['B', 'database'],
    ]);
    expect(list[0]).toMatchObject({
      id: 'env',
      readOnly: true,
      hasClientSecret: true,
      callbackUrl: `${BASE_URL}/api/auth/oidc/callback`,
      loginPath: '/api/auth/oidc/login',
    });

    expect((await admin.patch('/api/admin/oidc-providers/env', { name: 'X' })).statusCode).toBe(409);
    expect((await admin.delete('/api/admin/oidc-providers/env')).statusCode).toBe(409);
    expect((await admin.get('/api/admin/oidc-providers/env')).statusCode).toBe(200);
  });

  it('deletes a provider with the identities linked through it', async () => {
    const provider = await createProvider();
    const userId = await createUser(t.db, { email: 'jane@example.com', role: 'editor' });
    for (const provider_id of [provider.id, 'env']) {
      await t.db
        .insertInto('user_oidc_identities')
        .values({ provider_id, subject: 'jane', user_id: userId, created_at: new Date().toISOString(), last_login_at: null })
        .execute();
    }
    expect(data<Any>(await admin.get(`/api/admin/oidc-providers/${provider.id}`)).linkedUsers).toBe(1);

    expect((await admin.delete(`/api/admin/oidc-providers/${provider.id}`)).statusCode).toBe(204);
    expect((await admin.get(`/api/admin/oidc-providers/${provider.id}`)).statusCode).toBe(404);
    const left = await t.db.selectFrom('user_oidc_identities').select('provider_id').execute();
    expect(left).toEqual([{ provider_id: 'env' }]);
    const audit = await auditOf();
    expect(audit.at(-1)).toMatchObject({ action: 'oidc_provider.delete' });
    expect(JSON.parse(audit.at(-1)!.details!)).toMatchObject({ name: 'Example IdP', unlinkedUsers: 1 });
  });

  it('validates the input', async () => {
    const bad = [
      { issuerUrl: 'https://user:pw@idp.example.com' },
      { issuerUrl: 'ftp://idp.example.com' },
      { scopes: 'email profile' },
      { defaultRole: 'admin' },
      { roleMappings: [{ value: 'x', role: 'owner' }] },
      { allowedDomains: ['not a domain'] },
      { name: '' },
    ];
    for (const body of bad) {
      const res = await admin.post('/api/admin/oidc-providers', { name: 'X', issuerUrl: issuer, clientId: 'c', ...body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await t.db.selectFrom('oidc_providers').select('id').execute()).toEqual([]);
  });

  it('is only available to admins', async () => {
    const provider = await createProvider();
    await createUser(t.db, { email: 'editor@example.com', role: 'editor' });
    const editor = client(t.app, { cookie: await login(t.app, 'editor@example.com') });
    expect((await editor.get('/api/admin/oidc-providers')).statusCode).toBe(403);
    expect((await editor.get(`/api/admin/oidc-providers/${provider.id}`)).statusCode).toBe(403);
    expect((await editor.post('/api/admin/oidc-providers', { name: 'X', issuerUrl: issuer, clientId: 'c' })).statusCode).toBe(403);
    expect((await editor.post(`/api/admin/oidc-providers/${provider.id}/test`)).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/oidc-providers' })).statusCode).toBe(401);
  });

  it('tests the discovery of a provider and of an unsaved issuer', async () => {
    const provider = await createProvider();
    const saved = await admin.post(`/api/admin/oidc-providers/${provider.id}/test`);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().meta).toMatchObject({
      ok: true,
      issuer,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      userinfoEndpoint: `${issuer}/userinfo`,
      jwksUri: `${issuer}/jwks`,
      warnings: [],
    });

    const unsaved = await admin.post('/api/admin/oidc-providers/test', doc('oidc-discovery-tests', { issuerUrl: issuer }));
    expect(unsaved.statusCode, unsaved.body).toBe(200);
    expect(unsaved.json().meta.ok).toBe(true);

    const invalid = await admin.post('/api/admin/oidc-providers/test', doc('oidc-discovery-tests', { issuerUrl: 'file:///etc/passwd' }));
    expect(invalid.statusCode).toBe(400);
  });
});

describe('testOidcDiscovery', () => {
  it('reports a different issuer, redirects, missing documents and non-JSON answers', async () => {
    const other = await testOidcDiscovery(`${issuer}/other`);
    expect(other).toMatchObject({ ok: false });
    expect(other.message).toContain('differs from the configured issuer URL');

    // Redirects are never followed and the target is shown without its query.
    const moved = await testOidcDiscovery(`${issuer}/moved`);
    expect(moved.ok).toBe(false);
    expect(moved.message).toContain('redirected');
    expect(moved.message).not.toContain('token=secret');

    expect(await testOidcDiscovery(`${issuer}/missing`)).toMatchObject({ ok: false });
    expect((await testOidcDiscovery(`${issuer}/html`)).message).toContain('did not return JSON');
  });

  it('compares the issuers like the login does', async () => {
    // Without a path the slash does not count (URL#href), neither does the host case.
    expect((await testOidcDiscovery(`${issuer}/`)).ok).toBe(true);
    expect((await testOidcDiscovery(issuer)).ok).toBe(true);
    expect((await testOidcDiscovery(issuer.replace('http://', 'HTTP://'))).ok).toBe(true);
  });

  it('treats a trailing slash after a path as a different issuer', () => {
    expect(sameIssuer('https://idp.example.com', 'https://IDP.example.com/')).toBe(true);
    expect(sameIssuer('https://idp.example.com/realms/a', 'https://idp.example.com/realms/a/')).toBe(false);
    expect(sameIssuer('not a url', 'not a url')).toBe(false);
  });
});

describe('production', () => {
  it('refuses plain http issuers', async () => {
    t = await createTestApp({ NODE_ENV: 'production', SECRET_KEY: 'a-production-like-secret-key-0123456789abcdef' });
    try {
      admin = await adminClient(t);
      const res = await admin.post('/api/admin/oidc-providers', { name: 'X', issuerUrl: issuer, clientId: 'c' });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('must use https');
      const test = await admin.post('/api/admin/oidc-providers/test', doc('oidc-discovery-tests', { issuerUrl: issuer }));
      expect(test.statusCode).toBe(400);
      expect(test.body).toContain('must use https');
    } finally {
      await t.close();
    }
  });
});

describe('without password login', () => {
  it('keeps the last enabled provider so somebody can still sign in', async () => {
    t = await createTestApp({ LOCAL_LOGIN_ENABLED: 'false' });
    try {
      const adminId = await createUser(t.db, { email: 'admin@example.com', role: 'admin', password: null });
      const { token } = await createSession(t.app.ctx, adminId);
      admin = client(t.app, { cookie: `osp_session=${token}` });
      const a = await createProvider({ name: 'A' });
      const b = await createProvider({ name: 'B' });
      const disabled = await createProvider({ name: 'Disabled', enabled: false });
      // A disabled provider does not count, and can always go.
      expect((await admin.delete(`/api/admin/oidc-providers/${disabled.id}`)).statusCode).toBe(204);

      expect((await admin.patch(`/api/admin/oidc-providers/${a.id}`, { enabled: false })).statusCode).toBe(200);
      const last = await admin.patch(`/api/admin/oidc-providers/${b.id}`, { enabled: false });
      expect(last.statusCode).toBe(409);
      expect(last.body).toContain('LOCAL_LOGIN_ENABLED');
      expect((await admin.delete(`/api/admin/oidc-providers/${b.id}`)).statusCode).toBe(409);
      // Other changes of the last provider still work.
      expect((await admin.patch(`/api/admin/oidc-providers/${b.id}`, { name: 'B2' })).statusCode).toBe(200);

      // With a second enabled provider the first may go again.
      expect((await admin.patch(`/api/admin/oidc-providers/${a.id}`, { enabled: true })).statusCode).toBe(200);
      expect((await admin.delete(`/api/admin/oidc-providers/${b.id}`)).statusCode).toBe(204);
      const providers = await t.db.selectFrom('oidc_providers').select(['name', 'enabled']).execute();
      expect(providers).toEqual([{ name: 'A', enabled: 1 }]);
    } finally {
      await t.close();
    }
  });

  it('does not guard the stored providers while the environment provider exists', async () => {
    t = await createTestApp({ ...ENV, LOCAL_LOGIN_ENABLED: 'false' });
    try {
      const adminId = await createUser(t.db, { email: 'admin@example.com', role: 'admin', password: null });
      const { token } = await createSession(t.app.ctx, adminId);
      admin = client(t.app, { cookie: `osp_session=${token}` });
      const a = await createProvider();
      expect((await admin.delete(`/api/admin/oidc-providers/${a.id}`)).statusCode).toBe(204);
    } finally {
      await t.close();
    }
  });
});

describe('session', () => {
  it('reports SSO as enabled while an enabled provider exists', async () => {
    t = await createTestApp();
    try {
      admin = await adminClient(t);
      const enabled = async () => data<Any>(await admin.get('/api/auth/session')).oidcEnabled;
      expect(await enabled()).toBe(false);
      const provider = await createProvider({ enabled: false });
      expect(await enabled()).toBe(false);
      await admin.patch(`/api/admin/oidc-providers/${provider.id}`, { enabled: true });
      expect(await enabled()).toBe(true);
    } finally {
      await t.close();
    }
  });
});

describe('login', () => {
  beforeEach(async () => {
    t = await createTestApp(ENV);
    admin = await adminClient(t);
  });
  afterEach(async () => {
    await t.close();
  });

  it('shows one button per enabled provider in button order', async () => {
    const second = await createProvider({ name: 'Second', sortOrder: 5 });
    const first = await createProvider({ name: 'First', sortOrder: 1 });
    await createProvider({ name: 'Disabled', enabled: false });
    const config = await t.app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(config.json().data.attributes).toMatchObject({
      oidcEnabled: true,
      localLoginEnabled: true,
      oidcProviders: [
        { id: 'env', label: 'Corporate SSO', loginPath: '/api/auth/oidc/login' },
        { id: first.id, label: 'First', loginPath: `/api/auth/oidc/${first.id}/login` },
        { id: second.id, label: 'Second', loginPath: `/api/auth/oidc/${second.id}/login` },
      ],
    });
  });

  it('starts the login with PKCE, the provider callback and a state bound to the provider', async () => {
    const provider = await createProvider({ scopes: 'openid email groups' });
    const res = await t.app.inject({ method: 'GET', url: `/api/auth/oidc/${provider.id}/login` });
    expect(res.statusCode, res.body).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(`${issuer}/authorize`);
    expect(location.searchParams.get('redirect_uri')).toBe(`${BASE_URL}/api/auth/oidc/${provider.id}/callback`);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(location.searchParams.get('scope')).toBe('openid email groups');
    expect(location.searchParams.get('client_id')).toBe('openstatuspage');
    expect(res.headers.location).not.toContain(SECRET);

    const cookie = res.cookies.find((c) => c.name === OIDC_STATE_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api/auth/oidc' });
    const unsigned = t.app.unsignCookie(cookie.value);
    expect(unsigned.valid).toBe(true);
    expect(JSON.parse(unsigned.value!)).toMatchObject({ p: provider.id, s: location.searchParams.get('state') });
  });

  it('redirects with an error for unknown, disabled or unreachable providers', async () => {
    const disabled = await createProvider({ enabled: false });
    const unreachable = await createProvider({ issuerUrl: 'http://127.0.0.1:9/' });
    for (const id of [disabled.id, '00000000-0000-4000-8000-000000000000', unreachable.id]) {
      const res = await t.app.inject({ method: 'GET', url: `/api/auth/oidc/${id}/login` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/admin/login?error=oidc_unavailable');
    }
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/oidc/not-a-uuid/login' })).statusCode).toBe(404);
  });

  it('accepts a callback only with the state of its own provider', async () => {
    const a = await createProvider({ name: 'A', autoCreateUsers: true });
    const b = await createProvider({ name: 'B', autoCreateUsers: true });
    const finish = claims({ sub: 'jane', email: 'jane@example.com', email_verified: true });

    for (const [route, state] of [
      [a.id, b.id],
      [b.id, a.id],
      ['env', a.id],
      [a.id, 'env'],
    ]) {
      const res = await callback(route!, state);
      expect(res.headers.location, `${route} with state of ${state}`).toBe('/admin/login?error=invalid_state');
    }
    expect(finish).not.toHaveBeenCalled();

    const ok = await callback(a.id);
    expect(ok.headers.location).toBe('/admin');
    expect(finish).toHaveBeenCalledOnce();
    const identities = await t.db.selectFrom('user_oidc_identities').select(['provider_id', 'subject']).execute();
    expect(identities).toEqual([{ provider_id: a.id, subject: 'jane' }]);
    const audit = await t.db.selectFrom('audit_log').select(['action', 'details']).where('action', '=', 'user.create').execute();
    expect(JSON.parse(audit[0]!.details!)).toMatchObject({ method: 'oidc', provider: a.id, providerName: 'A' });
  });

  it('rejects the callback of a provider disabled during the login', async () => {
    const provider = await createProvider({ autoCreateUsers: true });
    claims({ sub: 'jane', email: 'jane@example.com', email_verified: true });
    await admin.patch(`/api/admin/oidc-providers/${provider.id}`, { enabled: false });
    expect((await callback(provider.id)).headers.location).toBe('/admin/login?error=oidc_unavailable');
  });

  it('links one user to several providers by sub per provider', async () => {
    const a = await createProvider({ name: 'A', linkByEmail: true });
    const b = await createProvider({ name: 'B', linkByEmail: true });
    const janeId = await createUser(t.db, { email: 'jane@example.com', role: 'editor', password: null });

    claims({ sub: 'jane-at-a', email: 'jane@example.com', email_verified: true });
    expect((await callback(a.id)).headers.location).toBe('/admin');
    vi.restoreAllMocks();
    claims({ sub: 'jane-at-b', email: 'jane@example.com', email_verified: true });
    expect((await callback(b.id)).headers.location).toBe('/admin');
    // The same sub at another provider is another identity: no login without a verified e-mail.
    vi.restoreAllMocks();
    claims({ sub: 'jane-at-a', email: 'jane@example.com', email_verified: false });
    expect((await callback('env')).headers.location).toBe('/admin/login?error=email_not_verified');
    // A second identity of the same provider is refused.
    vi.restoreAllMocks();
    claims({ sub: 'someone-else', email: 'jane@example.com', email_verified: true });
    expect((await callback(a.id)).headers.location).toBe('/admin/login?error=account_conflict');

    const identities = await t.db
      .selectFrom('user_oidc_identities')
      .select(['provider_id', 'subject', 'user_id'])
      .orderBy('subject')
      .execute();
    expect(identities).toEqual([
      { provider_id: a.id, subject: 'jane-at-a', user_id: janeId },
      { provider_id: b.id, subject: 'jane-at-b', user_id: janeId },
    ]);
    const users = data<Any[]>(await admin.get('/api/admin/users'));
    expect(users.find((u) => u.id === janeId)).toMatchObject({ oidcLinked: true });
  });

  it('never takes over an existing account by e-mail unless the provider links by e-mail', async () => {
    // An editor-level IdP (no mappings, default editor) asserting the admin's verified address.
    const provider = await createProvider({ autoCreateUsers: true });
    const as = () => {
      vi.restoreAllMocks();
      claims({ sub: 'mallory', email: 'admin@example.com', email_verified: true });
      return callback(provider.id);
    };
    expect((await as()).headers.location).toBe('/admin/login?error=account_not_linked');
    expect(await t.db.selectFrom('user_oidc_identities').select('subject').execute()).toEqual([]);
    expect(await t.db.selectFrom('users').select('email').execute()).toEqual([{ email: 'admin@example.com' }]);

    // Opted in: linked, and the account keeps its role (no mappings).
    expect((await admin.patch(`/api/admin/oidc-providers/${provider.id}`, { linkByEmail: true })).statusCode).toBe(200);
    const linked = await as();
    expect(linked.headers.location).toBe('/admin');
    const audit = await auditOf();
    expect(JSON.parse(audit.at(-1)!.details!)).toMatchObject({ fields: ['linkByEmail'], linkByEmail: true });
  });

  it('maps roles from nested claims and syncs them on every login', async () => {
    const provider = await createProvider({
      autoCreateUsers: true,
      roleClaim: 'realm_access.roles',
      roleMappings: [
        { value: 'statuspage-admins', role: 'admin' },
        { value: 'statuspage-editors', role: 'editor' },
        { value: 'contractors', role: 'deny' },
      ],
      defaultRole: 'deny',
    });
    const as = (roles: string[]) => {
      vi.restoreAllMocks();
      claims({ sub: 'jane', email: 'jane@example.com', email_verified: true, realm_access: { roles } });
      return callback(provider.id);
    };
    const role = async () =>
      (await t.db.selectFrom('users').select('role').where('email', '=', 'jane@example.com').executeTakeFirstOrThrow()).role;

    expect((await as(['other'])).headers.location).toBe('/admin/login?error=forbidden');
    expect((await as(['statuspage-editors'])).headers.location).toBe('/admin');
    expect(await role()).toBe('editor');
    expect((await as(['statuspage-admins'])).headers.location).toBe('/admin');
    expect(await role()).toBe('admin');
    expect((await as(['statuspage-editors'])).headers.location).toBe('/admin');
    expect(await role()).toBe('editor');

    // Deny wins and ends the sessions of the linked user.
    const janeId = (await t.db.selectFrom('users').select('id').where('email', '=', 'jane@example.com').executeTakeFirstOrThrow()).id;
    expect(await t.db.selectFrom('sessions').select('id').where('user_id', '=', janeId).execute()).not.toEqual([]);
    expect((await as(['statuspage-admins', 'contractors'])).headers.location).toBe('/admin/login?error=forbidden');
    expect(await t.db.selectFrom('sessions').select('id').where('user_id', '=', janeId).execute()).toEqual([]);
  });

  it('writes the role only at creation with sync on create', async () => {
    const provider = await createProvider({
      autoCreateUsers: true,
      roleSync: 'create',
      roleMappings: [{ value: 'statuspage-admins', role: 'admin' }],
      defaultRole: 'editor',
    });
    const as = (groups: string[]) => {
      vi.restoreAllMocks();
      claims({ sub: 'jane', email: 'jane@example.com', email_verified: true, groups });
      return callback(provider.id);
    };
    expect((await as(['statuspage-admins'])).headers.location).toBe('/admin');
    const row = () => t.db.selectFrom('users').select(['id', 'role']).where('email', '=', 'jane@example.com').executeTakeFirstOrThrow();
    expect((await row()).role).toBe('admin');
    expect((await as([])).headers.location).toBe('/admin');
    expect((await row()).role).toBe('admin');
    // Changed in the management UI: kept on the next login.
    await t.db.updateTable('users').set({ role: 'editor' }).where('id', '=', (await row()).id).execute();
    expect((await as(['statuspage-admins'])).headers.location).toBe('/admin');
    expect((await row()).role).toBe('editor');
  });

  it('creates users with the default role and only verified addresses of the allowed domains', async () => {
    const provider = await createProvider({ autoCreateUsers: true, allowedDomains: ['example.com'] });
    const as = (value: Claims) => {
      vi.restoreAllMocks();
      claims(value);
      return callback(provider.id);
    };
    expect((await as({ sub: 'a', email: 'a@example.org', email_verified: true })).headers.location).toBe(
      '/admin/login?error=domain_not_allowed',
    );
    expect((await as({ sub: 'b', email: 'b@sub.example.com', email_verified: true })).headers.location).toBe(
      '/admin/login?error=domain_not_allowed',
    );
    expect((await as({ sub: 'c', email: 'c@example.com' })).headers.location).toBe('/admin/login?error=email_not_verified');
    expect((await as({ sub: 'd' })).headers.location).toBe('/admin/login?error=missing_email');
    expect(await t.db.selectFrom('users').select('email').where('email', '!=', 'admin@example.com').execute()).toEqual([]);

    expect((await as({ sub: 'e', email: 'e@Example.com', email_verified: true })).headers.location).toBe('/admin');
    const created = await t.db.selectFrom('users').select(['email', 'role']).where('email', '=', 'e@example.com').executeTakeFirst();
    expect(created).toEqual({ email: 'e@example.com', role: 'editor' });
  });

  it('skips a provider whose secret cannot be decrypted', async () => {
    const provider = await createProvider();
    await t.db
      .updateTable('oidc_providers')
      .set({ client_secret: new SecretBox('another-secret-key-that-is-long-enough-0000').encrypt('x') })
      .where('id', '=', provider.id)
      .execute();
    const res = await t.app.inject({ method: 'GET', url: `/api/auth/oidc/${provider.id}/login` });
    expect(res.headers.location).toBe('/admin/login?error=oidc_unavailable');
  });
});
