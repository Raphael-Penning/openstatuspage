import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { extractGroups, mapOidcRole, parseLoginState, resolveOidcUser } from '../src/services/oidc.js';
import { createSession } from '../src/services/sessions.js';
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

  it('ends the sessions and API tokens of a linked user removed from the allowed groups', async () => {
    const claims = { sub: 'abc', email: 'jane@example.com', groups: ['statuspage-editors'] };
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
      expect(config.json().data.attributes.oidcEnabled).toBe(true);
      const callback = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/callback?code=x&state=y' });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe('/admin/login?error=invalid_state');
    } finally {
      await t.close();
    }
  });
});
