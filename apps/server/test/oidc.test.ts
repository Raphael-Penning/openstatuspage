import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractGroups, mapOidcRole, parseLoginState, resolveOidcUser } from '../src/services/oidc.js';
import { createTestApp, createUser, type TestApp } from './helpers.js';

describe('extractGroups', () => {
  it('reads arrays, strings and nested claims', () => {
    expect(extractGroups({ groups: ['a', 'b', 3] }, 'groups')).toEqual(['a', 'b']);
    expect(extractGroups({ roles: 'a b,c' }, 'roles')).toEqual(['a', 'b', 'c']);
    expect(extractGroups({ realm_access: { roles: ['x'] } }, 'realm_access.roles')).toEqual(['x']);
    expect(extractGroups({ 'https://example.com/groups': ['y'] }, 'https://example.com/groups')).toEqual(['y']);
    expect(extractGroups({}, 'groups')).toEqual([]);
  });
});

describe('mapOidcRole', () => {
  const cfg = { groupsClaim: 'groups', adminGroup: 'statuspage-admins', editorGroup: 'statuspage-editors' };

  it('maps admin and editor groups', () => {
    expect(mapOidcRole({ groups: ['statuspage-admins'] }, cfg)).toBe('admin');
    expect(mapOidcRole({ groups: ['statuspage-editors'] }, cfg)).toBe('editor');
    expect(mapOidcRole({ groups: ['statuspage-editors', 'statuspage-admins'] }, cfg)).toBe('admin');
  });

  it('denies users outside the configured groups', () => {
    expect(mapOidcRole({ groups: ['other'] }, cfg)).toBeNull();
    expect(mapOidcRole({}, cfg)).toBeNull();
  });

  it('accepts Keycloak style group paths and is case-insensitive', () => {
    expect(mapOidcRole({ groups: ['/StatusPage-Admins'] }, cfg)).toBe('admin');
  });

  it('grants editor to everybody without an editor group', () => {
    expect(mapOidcRole({ groups: [] }, { groupsClaim: 'groups', adminGroup: 'statuspage-admins' })).toBe('editor');
    expect(mapOidcRole({}, { groupsClaim: 'groups' })).toBe('editor');
  });
});

describe('parseLoginState', () => {
  it('accepts valid, unexpired state only', () => {
    const valid = { v: 'verifier', s: 'state', n: 'nonce', e: Date.now() + 60_000 };
    expect(parseLoginState(JSON.stringify(valid))).toEqual(valid);
    expect(parseLoginState(JSON.stringify({ ...valid, e: Date.now() - 1 }))).toBeNull();
    expect(parseLoginState('{broken')).toBeNull();
    expect(parseLoginState(JSON.stringify({ v: 1 }))).toBeNull();
  });
});

describe('resolveOidcUser', () => {
  let t: TestApp;
  const config = {
    OIDC_GROUPS_CLAIM: 'groups',
    OIDC_ADMIN_GROUP: 'statuspage-admins',
    OIDC_EDITOR_GROUP: 'statuspage-editors',
    OIDC_AUTO_CREATE_USERS: true,
  };
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it('creates users on first login and links by subject afterwards', async () => {
    const claims = { sub: 'abc', email: 'Jane@Example.com', name: 'Jane', groups: ['statuspage-editors'] };
    const first = await resolveOidcUser(t.db, config, claims);
    expect(first).toMatchObject({ ok: true, created: true, user: { email: 'jane@example.com', role: 'editor' } });

    // Promoted in the IdP: role is synced, user found by subject even with a changed e-mail.
    const second = await resolveOidcUser(t.db, config, { ...claims, email: 'new@example.com', groups: ['statuspage-admins'] });
    expect(second).toMatchObject({ ok: true, created: false, user: { role: 'admin' } });
    expect(await t.db.selectFrom('users').select('id').execute()).toHaveLength(1);
  });

  it('links existing users by verified e-mail only', async () => {
    await createUser(t.db, { email: 'jane@example.com', role: 'editor' });
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
    expect(verified).toMatchObject({ ok: true, created: false, user: { oidc_subject: 'abc' } });

    const other = await resolveOidcUser(t.db, config, {
      sub: 'different',
      email: 'jane@example.com',
      email_verified: true,
      groups: ['statuspage-editors'],
    });
    expect(other).toEqual({ ok: false, error: 'account_conflict' });
  });

  it('rejects users without a matching group or account', async () => {
    expect(await resolveOidcUser(t.db, config, { sub: 'x', email: 'x@example.com', groups: [] })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await resolveOidcUser(t.db, { ...config, OIDC_AUTO_CREATE_USERS: false }, {
        sub: 'x',
        email: 'x@example.com',
        groups: ['statuspage-editors'],
      }),
    ).toEqual({ ok: false, error: 'no_account' });
  });

  it('keeps local roles when no group mapping is configured', async () => {
    await createUser(t.db, { email: 'boss@example.com', role: 'admin' });
    const noMapping = { ...config, OIDC_ADMIN_GROUP: undefined, OIDC_EDITOR_GROUP: undefined };
    const result = await resolveOidcUser(t.db, noMapping, { sub: 's', email: 'boss@example.com', email_verified: true });
    expect(result).toMatchObject({ ok: true, user: { role: 'admin' } });
  });
});

describe('OIDC routes', () => {
  it('are wired when OIDC is configured and reject callbacks without state', async () => {
    const t = await createTestApp({
      OIDC_ISSUER_URL: 'https://idp.example.com/realms/example',
      OIDC_CLIENT_ID: 'openstatuspage',
    });
    try {
      const config = await t.app.inject({ method: 'GET', url: '/api/auth/config' });
      expect(config.json().oidcEnabled).toBe(true);
      const callback = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/callback?code=x&state=y' });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe('/admin/login?error=invalid_state');
    } finally {
      await t.close();
    }
  });
});
