/**
 * SSO account resolution and the provider of the OIDC_* environment variables
 * (0.3.x compatible). Providers managed in the admin UI: oidc-providers.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { sha256 } from '../src/lib/crypto.js';
import { newId } from '../src/lib/ids.js';
import {
  envProvider,
  extractGroups,
  mapProviderRole,
  OIDC_STATE_COOKIE,
  OidcClient,
  parseLoginState,
  resolveOidcUser,
  type OidcProvider,
} from '../src/services/oidc.js';
import { createSession } from '../src/services/sessions.js';
import { createTestApp, createUser, login, type TestApp } from './helpers.js';

/** The provider of the OIDC_* variables, as the server builds it from the environment. */
function fromEnv(env: Record<string, string> = {}): OidcProvider {
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      DATABASE_URL: 'sqlite::memory:',
      SECRET_KEY: 'test-secret-key-that-is-long-enough-1234567890',
      BASE_URL: 'https://status.example.com',
      OIDC_ISSUER_URL: 'https://idp.example.com/realms/example',
      OIDC_CLIENT_ID: 'openstatuspage',
      ...env,
    },
    { allowSqliteForAnyRole: true },
  );
  const provider = envProvider(config);
  if (!provider) throw new Error('no environment provider');
  return provider;
}

describe('extractGroups', () => {
  it('reads arrays, strings and nested claims', () => {
    expect(extractGroups({ groups: ['a', 'b', 3] }, 'groups')).toEqual(['a', 'b']);
    expect(extractGroups({ roles: 'a b,c' }, 'roles')).toEqual(['a', 'b', 'c']);
    expect(extractGroups({ realm_access: { roles: ['x'] } }, 'realm_access.roles')).toEqual(['x']);
    expect(extractGroups({ 'https://example.com/groups': ['y'] }, 'https://example.com/groups')).toEqual(['y']);
    expect(extractGroups({}, 'groups')).toEqual([]);
  });

  it('only follows own properties of objects', () => {
    expect(extractGroups({}, 'constructor.name')).toEqual([]);
    expect(extractGroups({}, 'constructor')).toEqual([]);
    expect(extractGroups({}, 'toString')).toEqual([]);
    expect(extractGroups({ a: ['x'] }, 'a.length')).toEqual([]);
  });
});

describe('environment provider role mapping (0.3.x compatible)', () => {
  const both = fromEnv({ OIDC_ADMIN_GROUP: 'statuspage-admins', OIDC_EDITOR_GROUP: 'statuspage-editors' });

  it('maps admin and editor groups', () => {
    expect(mapProviderRole({ groups: ['statuspage-admins'] }, both)).toBe('admin');
    expect(mapProviderRole({ groups: ['statuspage-editors'] }, both)).toBe('editor');
    expect(mapProviderRole({ groups: ['statuspage-editors', 'statuspage-admins'] }, both)).toBe('admin');
  });

  it('denies users outside the configured groups', () => {
    expect(mapProviderRole({ groups: ['other'] }, both)).toBeNull();
    expect(mapProviderRole({}, both)).toBeNull();
  });

  it('accepts Keycloak style group paths and is case-insensitive', () => {
    expect(mapProviderRole({ groups: ['/StatusPage-Admins'] }, both)).toBe('admin');
  });

  it('grants editor to everybody without an editor group', () => {
    expect(mapProviderRole({ groups: [] }, fromEnv({ OIDC_ADMIN_GROUP: 'statuspage-admins' }))).toBe('editor');
    expect(mapProviderRole({}, fromEnv())).toBe('editor');
  });

  it('keeps the callback, label and settings of the environment', () => {
    const provider = fromEnv({ OIDC_LABEL: 'Corporate SSO', OIDC_GROUPS_CLAIM: 'roles', OIDC_AUTO_CREATE_USERS: 'true' });
    expect(provider).toMatchObject({
      id: 'env',
      label: 'Corporate SSO',
      source: 'environment',
      roleClaim: 'roles',
      autoCreateUsers: true,
      allowedDomains: [],
      roleMappings: [],
      defaultRole: 'editor',
    });
    expect(new OidcClient(provider, 'https://status.example.com').redirectUri).toBe(
      'https://status.example.com/api/auth/oidc/callback',
    );
  });
});

describe('mapProviderRole', () => {
  const provider = {
    roleClaim: 'realm_access.roles',
    roleMappings: [
      { value: 'statuspage-admins', role: 'admin' as const },
      { value: 'statuspage-editors', role: 'editor' as const },
      { value: 'contractors', role: 'deny' as const },
    ],
    defaultRole: 'deny' as const,
  };

  it('reads nested claims, arrays and strings', () => {
    expect(mapProviderRole({ realm_access: { roles: ['offline_access', 'statuspage-editors'] } }, provider)).toBe('editor');
    expect(mapProviderRole({ realm_access: { roles: 'statuspage-admins other' } }, provider)).toBe('admin');
  });

  it('lets deny win over every other mapping', () => {
    expect(mapProviderRole({ realm_access: { roles: ['statuspage-admins', 'contractors'] } }, provider)).toBeNull();
  });

  it('falls back to the default role', () => {
    expect(mapProviderRole({ realm_access: { roles: ['other'] } }, provider)).toBeNull();
    expect(mapProviderRole({}, { ...provider, defaultRole: 'editor' })).toBe('editor');
  });

  it('maps Entra app roles and group object ids', () => {
    const entra = {
      roleClaim: 'roles',
      roleMappings: [{ value: '00000000-0000-0000-0000-000000000001', role: 'admin' as const }],
      defaultRole: 'editor' as const,
    };
    expect(mapProviderRole({ roles: ['00000000-0000-0000-0000-000000000001'] }, entra)).toBe('admin');
    expect(mapProviderRole({ groups: ['00000000-0000-0000-0000-000000000001'] }, entra)).toBe('editor');
  });
});

describe('parseLoginState', () => {
  it('accepts valid, unexpired state of the same provider only', () => {
    const valid = { p: 'env', v: 'verifier', s: 'state', n: 'nonce', e: Date.now() + 60_000 };
    expect(parseLoginState(JSON.stringify(valid), 'env')).toEqual(valid);
    expect(parseLoginState(JSON.stringify(valid), 'other')).toBeNull();
    expect(parseLoginState(JSON.stringify({ ...valid, p: undefined }), 'env')).toBeNull();
    expect(parseLoginState(JSON.stringify({ ...valid, e: Date.now() - 1 }), 'env')).toBeNull();
    expect(parseLoginState('{broken', 'env')).toBeNull();
    expect(parseLoginState(JSON.stringify({ v: 1 }), 'env')).toBeNull();
  });
});

describe('resolveOidcUser', () => {
  let t: TestApp;
  const config = fromEnv({
    OIDC_ADMIN_GROUP: 'statuspage-admins',
    OIDC_EDITOR_GROUP: 'statuspage-editors',
    OIDC_AUTO_CREATE_USERS: 'true',
  });
  const identities = () =>
    t.db.selectFrom('user_oidc_identities').select(['provider_id', 'subject', 'user_id']).orderBy('provider_id').execute();
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it('creates users on first login and links by subject afterwards', async () => {
    const claims = { sub: 'abc', email: 'Jane@Example.com', email_verified: true, name: 'Jane', groups: ['statuspage-editors'] };
    const first = await resolveOidcUser(t.db, config, claims);
    expect(first).toMatchObject({ ok: true, created: true, user: { email: 'jane@example.com', role: 'editor' } });

    // Promoted in the IdP: role is synced, user found by subject even with a changed e-mail.
    const second = await resolveOidcUser(t.db, config, { ...claims, email: 'new@example.com', groups: ['statuspage-admins'] });
    expect(second).toMatchObject({ ok: true, created: false, linked: false, user: { role: 'admin' } });
    expect(await t.db.selectFrom('users').select('id').execute()).toHaveLength(1);
    expect(await identities()).toEqual([{ provider_id: 'env', subject: 'abc', user_id: first.ok ? first.user.id : '' }]);
  });

  it('links existing users by verified e-mail only', async () => {
    const janeId = await createUser(t.db, { email: 'jane@example.com', role: 'editor' });
    const unverified = await resolveOidcUser(t.db, config, {
      sub: 'abc',
      email: 'jane@example.com',
      groups: ['statuspage-editors'],
    });
    expect(unverified).toEqual({ ok: false, error: 'email_not_verified' });

    const verified = await resolveOidcUser(t.db, config, {
      sub: 'abc',
      email: 'jane@example.com',
      email_verified: true,
      groups: ['statuspage-editors'],
    });
    expect(verified).toMatchObject({ ok: true, created: false, linked: true, user: { id: janeId } });
    expect(await identities()).toEqual([{ provider_id: 'env', subject: 'abc', user_id: janeId }]);

    const other = await resolveOidcUser(t.db, config, {
      sub: 'different',
      email: 'jane@example.com',
      email_verified: true,
      groups: ['statuspage-editors'],
    });
    expect(other).toEqual({ ok: false, error: 'account_conflict' });
  });

  it('links by e-mail only for providers that allow it', async () => {
    const adminId = await createUser(t.db, { email: 'boss@example.com', role: 'admin' });
    const provider: OidcProvider = { ...config, id: 'p-1', source: 'database', linkByEmail: false, roleMappings: [], defaultRole: 'editor' };
    const claims = { sub: 'abc', email: 'Boss@example.com', email_verified: true };
    expect(await resolveOidcUser(t.db, provider, claims)).toEqual({ ok: false, error: 'account_not_linked' });
    // Auto creation never reuses the address either.
    expect(await resolveOidcUser(t.db, { ...provider, autoCreateUsers: true }, claims)).toEqual({
      ok: false,
      error: 'account_not_linked',
    });
    expect(await identities()).toEqual([]);

    const linked = await resolveOidcUser(t.db, { ...provider, linkByEmail: true }, claims);
    expect(linked).toMatchObject({ ok: true, linked: true, user: { id: adminId, role: 'admin' } });
    // Once linked by sub, the option no longer matters.
    expect(await resolveOidcUser(t.db, provider, claims)).toMatchObject({ ok: true, linked: false, user: { id: adminId } });
  });

  it('resolves concurrent first logins of the same identity to one user', async () => {
    const claims = { sub: 'abc', email: 'jane@example.com', email_verified: true, groups: ['statuspage-editors'] };
    const results = await Promise.all([1, 2, 3].map(() => resolveOidcUser(t.db, config, claims)));
    expect(results.every((r) => r.ok)).toBe(true);
    const ids = new Set(results.map((r) => (r.ok ? r.user.id : '')));
    expect(ids.size).toBe(1);
    expect(await t.db.selectFrom('users').select('id').execute()).toHaveLength(1);
    expect(await identities()).toHaveLength(1);
  });

  it('refuses a concurrent second identity for the same address instead of failing', async () => {
    const results = await Promise.all(
      ['a', 'b'].map((sub) =>
        resolveOidcUser(t.db, config, { sub, email: 'jane@example.com', email_verified: true, groups: ['statuspage-editors'] }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'account_conflict' }]);
  });

  it('creates users for a verified e-mail only', async () => {
    const claims = { sub: 'squatter', email: 'newhire@example.com', groups: ['statuspage-editors'] };
    for (const email_verified of [undefined, false, 'false']) {
      expect(await resolveOidcUser(t.db, config, { ...claims, email_verified })).toEqual({
        ok: false,
        error: 'email_not_verified',
      });
    }
    expect(await t.db.selectFrom('users').select('id').execute()).toEqual([]);

    // The owner of the address can still sign up with a verified claim.
    const owner = await resolveOidcUser(t.db, config, { ...claims, sub: 'owner', email_verified: 'true' });
    expect(owner).toMatchObject({ ok: true, created: true, user: { email: 'newhire@example.com' } });
    expect((await identities()).map((i) => i.subject)).toEqual(['owner']);
  });

  it('rejects users without a matching group or account', async () => {
    expect(await resolveOidcUser(t.db, config, { sub: 'x', email: 'x@example.com', groups: [] })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await resolveOidcUser(t.db, { ...config, autoCreateUsers: false }, {
        sub: 'x',
        email: 'x@example.com',
        groups: ['statuspage-editors'],
      }),
    ).toEqual({ ok: false, error: 'no_account' });
    expect(await resolveOidcUser(t.db, config, { email: 'x@example.com', groups: ['statuspage-editors'] })).toEqual({
      ok: false,
      error: 'missing_subject',
    });
  });

  it('ends the sessions and API tokens of a linked user removed from the allowed groups', async () => {
    const claims = { sub: 'abc', email: 'jane@example.com', email_verified: true, groups: ['statuspage-editors'] };
    const first = await resolveOidcUser(t.db, config, claims);
    if (!first.ok) throw new Error('login failed');
    await createSession(t.app.ctx, first.user.id);
    const other = await createUser(t.db, { email: 'other@example.com', role: 'editor' });
    await createSession(t.app.ctx, other);
    for (const owner of [first.user.id, other]) {
      await t.db
        .insertInto('api_tokens')
        .values({
          id: newId(),
          name: 'automation',
          role: 'editor',
          token_hash: newId(),
          created_by: owner,
          created_at: new Date().toISOString(),
          last_used_at: null,
        })
        .execute();
    }

    expect(await resolveOidcUser(t.db, config, { ...claims, groups: [] })).toEqual({ ok: false, error: 'forbidden' });
    const sessions = await t.db.selectFrom('sessions').select('user_id').execute();
    expect(sessions).toEqual([{ user_id: other }]);
    const tokens = await t.db.selectFrom('api_tokens').select('created_by').execute();
    expect(tokens).toEqual([{ created_by: other }]);
  });

  it('applies the demotion rules when syncing roles', async () => {
    const admins = { sub: 'abc', email: 'jane@example.com', email_verified: true, groups: ['statuspage-admins'] };
    const editors = { ...admins, groups: ['statuspage-editors'] };
    const adminId = await createUser(t.db, { email: 'jane@example.com', role: 'admin' });
    const insertToken = (role: 'admin' | 'editor') =>
      t.db
        .insertInto('api_tokens')
        .values({
          id: newId(),
          name: role,
          role,
          token_hash: newId(),
          created_by: adminId,
          created_at: new Date().toISOString(),
          last_used_at: null,
        })
        .execute();
    await insertToken('admin');
    await insertToken('editor');

    // The only admin is linked but not demoted: login works, the role stays, a warning is logged.
    const warnings: string[] = [];
    const log = { warn: (_obj: object, msg: string) => warnings.push(msg) };
    const kept = await resolveOidcUser(t.db, config, editors, log);
    expect(kept).toMatchObject({ ok: true, user: { id: adminId, role: 'admin' } });
    expect(warnings).toHaveLength(1);
    expect(await t.db.selectFrom('api_tokens').select('role').execute()).toHaveLength(2);

    // With another admin the demotion goes through and revokes the admin token.
    await createUser(t.db, { email: 'second@example.com', role: 'admin' });
    const demoted = await resolveOidcUser(t.db, config, editors, log);
    expect(demoted).toMatchObject({ ok: true, user: { role: 'editor' } });
    expect(await t.db.selectFrom('api_tokens').select('role').execute()).toEqual([{ role: 'editor' }]);
    const row = await t.db.selectFrom('users').select('role').where('id', '=', adminId).executeTakeFirstOrThrow();
    expect(row.role).toBe('editor');
    expect(warnings).toHaveLength(1);
  });

  it('keeps local roles when no group mapping is configured', async () => {
    await createUser(t.db, { email: 'boss@example.com', role: 'admin' });
    const result = await resolveOidcUser(t.db, fromEnv(), { sub: 's', email: 'boss@example.com', email_verified: true });
    expect(result).toMatchObject({ ok: true, user: { role: 'admin' } });
  });
});

describe('OIDC routes of the environment provider', () => {
  const env = {
    OIDC_ISSUER_URL: 'https://idp.example.com/realms/example',
    OIDC_CLIENT_ID: 'openstatuspage',
  };

  it('are wired when OIDC is configured and reject callbacks without state', async () => {
    const t = await createTestApp(env);
    try {
      const config = await t.app.inject({ method: 'GET', url: '/api/auth/config' });
      expect(config.json().data.attributes).toMatchObject({
        oidcEnabled: true,
        oidcProviders: [{ id: 'env', label: 'Single Sign-On', loginPath: '/api/auth/oidc/login' }],
      });
      const callback = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/callback?code=x&state=y' });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe('/admin/login?error=invalid_state');
    } finally {
      await t.close();
    }
  });

  it('are not there without the environment provider', async () => {
    const t = await createTestApp();
    try {
      expect((await t.app.inject({ method: 'GET', url: '/api/auth/oidc/login' })).statusCode).toBe(404);
      expect((await t.app.inject({ method: 'GET', url: '/api/auth/oidc/callback' })).statusCode).toBe(404);
      // The environment provider has no /:provider routes.
      expect((await t.app.inject({ method: 'GET', url: '/api/auth/oidc/env/login' })).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it('deletes the session the browser held before an SSO login', async () => {
    const t = await createTestApp(env);
    const finish = vi
      .spyOn(OidcClient.prototype, 'finishLogin')
      .mockResolvedValue({ sub: 'jane-sub', email: 'jane@example.com', email_verified: true });
    try {
      await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
      const janeId = await createUser(t.db, { email: 'jane@example.com', role: 'editor', password: null });
      const previous = await login(t.app, 'admin@example.com');

      const state = { p: 'env', v: 'verifier', s: 'state', n: 'nonce', e: Date.now() + 60_000 };
      const signed = t.app.signCookie(JSON.stringify(state));
      const callback = await t.app.inject({
        method: 'GET',
        url: '/api/auth/oidc/callback?code=x&state=state',
        headers: { cookie: `${previous}; ${OIDC_STATE_COOKIE}=${encodeURIComponent(signed)}` },
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe('/admin');
      const issued = callback.cookies.find((c) => c.name === 'osp_session')!;

      const sessions = await t.db.selectFrom('sessions').select(['id', 'user_id']).execute();
      expect(sessions).toEqual([{ id: sha256(issued.value), user_id: janeId }]);
      expect(finish).toHaveBeenCalledOnce();
    } finally {
      finish.mockRestore();
      await t.close();
    }
  });
});
