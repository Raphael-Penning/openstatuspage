/**
 * OpenID Connect single sign-on (authorization code flow with PKCE).
 *
 * Any number of providers (services/oidc-providers.ts): the one configured
 * with the OIDC_* environment variables plus the ones managed in the admin
 * UI. Each IdP is discovered lazily on first use and cached per provider
 * configuration. Pure helpers (`extractGroups`, `mapProviderRole`) and the
 * account resolution (`resolveOidcUser`) are exported separately so they can
 * be unit tested without an IdP.
 */
import {
  ENV_OIDC_PROVIDER_ID,
  type OidcDefaultRole,
  type OidcProviderSource,
  type OidcRoleMapping,
  type OidcRoleSyncMode,
  type UserRole,
} from '@openstatuspage/shared';
import type * as OidcLib from 'openid-client';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import type { User } from '../db/types.js';
import { isUniqueViolation } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { deleteUserSessions } from './sessions.js';
import { changeUserRole } from './users.js';

export const OIDC_STATE_COOKIE = 'osp_oidc';
/** Lifetime of the login state (time the user has to finish the IdP login). */
export const OIDC_STATE_TTL_SECONDS = 600;
/** Path of the state cookie: every login and callback route lies below it. */
export const OIDC_COOKIE_PATH = '/api/auth/oidc';

export interface OidcLoginState {
  /** Provider id: the callback only accepts the state of its own provider. */
  p: string;
  /** PKCE code verifier. */
  v: string;
  /** state */
  s: string;
  /** nonce */
  n: string;
  /** expiry, epoch ms */
  e: number;
}

/** Runtime configuration of one provider (from the environment or the database). */
export interface OidcProvider {
  id: string;
  label: string;
  source: OidcProviderSource;
  enabled: boolean;
  sortOrder: number;
  issuerUrl: string;
  clientId: string;
  /** Plain client secret (only where a login needs it); null for a public client. */
  clientSecret: string | null;
  scopes: string;
  autoCreateUsers: boolean;
  /** Link existing local accounts by verified e-mail (otherwise only by `sub`). */
  linkByEmail: boolean;
  allowedDomains: string[];
  roleClaim: string;
  roleMappings: OidcRoleMapping[];
  defaultRole: OidcDefaultRole;
  roleSync: OidcRoleSyncMode;
  /** Changes whenever the configuration changes (cache key of the discovered client). */
  version: string;
}

/** Login route of a provider (the button of the login page). */
export function oidcLoginPath(providerId: string): string {
  return providerId === ENV_OIDC_PROVIDER_ID ? `${OIDC_COOKIE_PATH}/login` : `${OIDC_COOKIE_PATH}/${encodeURIComponent(providerId)}/login`;
}

/**
 * Callback route of a provider. Every provider gets its own redirect URI, so an
 * authorization response can only be redeemed at the provider that issued it
 * (mix-up defence); the environment provider keeps the URI of 0.3.x.
 */
export function oidcCallbackPath(providerId: string): string {
  return providerId === ENV_OIDC_PROVIDER_ID
    ? `${OIDC_COOKIE_PATH}/callback`
    : `${OIDC_COOKIE_PATH}/${encodeURIComponent(providerId)}/callback`;
}

/**
 * The provider of the OIDC_* environment variables, or null. It keeps the
 * behaviour of 0.3.x: OIDC_ADMIN_GROUP / OIDC_EDITOR_GROUP become role
 * mappings; with an editor group everybody else is denied, without one
 * everybody else is an editor; local accounts are linked by verified e-mail.
 */
export function envProvider(
  config: Pick<
    Config,
    | 'oidcEnabled'
    | 'OIDC_ISSUER_URL'
    | 'OIDC_CLIENT_ID'
    | 'OIDC_CLIENT_SECRET'
    | 'OIDC_SCOPES'
    | 'OIDC_LABEL'
    | 'OIDC_GROUPS_CLAIM'
    | 'OIDC_ADMIN_GROUP'
    | 'OIDC_EDITOR_GROUP'
    | 'OIDC_AUTO_CREATE_USERS'
  >,
): OidcProvider | null {
  if (!config.oidcEnabled || !config.OIDC_ISSUER_URL || !config.OIDC_CLIENT_ID) return null;
  const roleMappings: OidcRoleMapping[] = [];
  if (config.OIDC_ADMIN_GROUP) roleMappings.push({ value: config.OIDC_ADMIN_GROUP, role: 'admin' });
  if (config.OIDC_EDITOR_GROUP) roleMappings.push({ value: config.OIDC_EDITOR_GROUP, role: 'editor' });
  return {
    id: ENV_OIDC_PROVIDER_ID,
    label: config.OIDC_LABEL,
    source: 'environment',
    enabled: true,
    sortOrder: -1,
    issuerUrl: config.OIDC_ISSUER_URL,
    clientId: config.OIDC_CLIENT_ID,
    clientSecret: config.OIDC_CLIENT_SECRET || null,
    scopes: config.OIDC_SCOPES,
    autoCreateUsers: config.OIDC_AUTO_CREATE_USERS,
    // 0.3.x linked by verified e-mail; the environment provider keeps doing so.
    linkByEmail: true,
    allowedDomains: [],
    roleClaim: config.OIDC_GROUPS_CLAIM,
    roleMappings,
    defaultRole: config.OIDC_EDITOR_GROUP ? 'deny' : 'editor',
    roleSync: 'login',
    version: 'env',
  };
}

export type Claims = Record<string, unknown>;

/** Reads the value list from `claims`. Accepts arrays and space/comma separated strings. */
export function extractGroups(claims: Claims, claimPath: string): string[] {
  let value: unknown = claims;
  if (Object.hasOwn(claims, claimPath)) {
    value = claims[claimPath];
  } else {
    for (const part of claimPath.split('.')) {
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, part)) {
        value = (value as Record<string, unknown>)[part];
      } else {
        return [];
      }
    }
  }
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  return [];
}

function normalizeGroup(g: string): string {
  // Keycloak can send full group paths ("/statuspage-admins").
  return g.trim().replace(/^\/+/, '').toLowerCase();
}

/** True when the role is derived from the IdP and written to the user on every login. */
export function syncsRoleOnLogin(provider: Pick<OidcProvider, 'roleSync' | 'roleMappings'>): boolean {
  return provider.roleSync === 'login' && provider.roleMappings.length > 0;
}

/**
 * Role granted by the claim values, or null when the user may not log in.
 * A `deny` mapping wins over everything, then `admin`, then `editor`; a user
 * none of whose values is mapped gets the default role (editor or deny).
 * Values are compared case-insensitively, a leading `/` is ignored.
 */
export function mapProviderRole(
  claims: Claims,
  provider: Pick<OidcProvider, 'roleClaim' | 'roleMappings' | 'defaultRole'>,
): UserRole | null {
  const values = new Set(extractGroups(claims, provider.roleClaim).map(normalizeGroup));
  const has = (role: OidcRoleMapping['role']) =>
    provider.roleMappings.some((m) => m.role === role && values.has(normalizeGroup(m.value)));
  if (has('deny')) return null;
  if (has('admin')) return 'admin';
  if (has('editor')) return 'editor';
  return provider.defaultRole === 'deny' ? null : provider.defaultRole;
}

export type OidcErrorCode =
  | 'forbidden'
  | 'domain_not_allowed'
  | 'no_account'
  | 'missing_email'
  | 'email_not_verified'
  | 'account_conflict'
  | 'account_not_linked'
  | 'missing_subject';

export type OidcUserResult =
  | { ok: true; user: User; created: boolean; linked: boolean }
  | { ok: false; error: OidcErrorCode };

function isVerified(value: unknown): boolean {
  return value === true || value === 'true';
}

/** Minimal logger interface, so the account resolution can be tested without Fastify. */
export interface OidcLogger {
  warn(obj: object, msg: string): void;
}

/** Ends the sessions of a user and revokes the API tokens they created. */
async function revokeAccess(db: DB, userId: string): Promise<void> {
  await deleteUserSessions(db, userId);
  await db.deleteFrom('api_tokens').where('created_by', '=', userId).execute();
}

/**
 * Finds (or creates) the local user for a verified ID token of `provider`.
 *
 * - Linking order: the identity (`sub` of this provider), then, only with
 *   `linkByEmail`, a verified e-mail. A user is linked to at most one identity
 *   per provider, but may be linked to several providers. Without
 *   `linkByEmail` an existing account with the address is never taken over
 *   (`account_not_linked`): its role, admin included, would otherwise be
 *   granted to whoever this IdP asserts the address for.
 * - Users are only created for a verified e-mail and with auto creation on.
 * - With allowed domains, only verified addresses of those domains get in.
 * - A denied role ends the sessions and revokes the API tokens of the linked
 *   user (they would otherwise keep their last role).
 * - With role mappings and sync on login, the role is written on every login.
 * - Concurrent first logins (two tabs, a double click) that both try to link or
 *   create run into the unique keys; the loser resolves again and finds what
 *   the winner stored, or gets `account_conflict`.
 */
export async function resolveOidcUser(
  db: DB,
  provider: ResolveProvider,
  claims: Claims,
  log?: OidcLogger,
): Promise<OidcUserResult> {
  try {
    return await resolveOnce(db, provider, claims, log);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  try {
    return await resolveOnce(db, provider, claims, log);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return { ok: false, error: 'account_conflict' };
  }
}

type ResolveProvider = Pick<
  OidcProvider,
  'id' | 'autoCreateUsers' | 'linkByEmail' | 'allowedDomains' | 'roleClaim' | 'roleMappings' | 'defaultRole' | 'roleSync'
>;

async function resolveOnce(
  db: DB,
  provider: ResolveProvider,
  claims: Claims,
  log?: OidcLogger,
): Promise<OidcUserResult> {
  const sub = typeof claims.sub === 'string' && claims.sub !== '' ? claims.sub : null;
  if (!sub) return { ok: false, error: 'missing_subject' };

  const identity = await db
    .selectFrom('user_oidc_identities')
    .select('user_id')
    .where('provider_id', '=', provider.id)
    .where('subject', '=', sub)
    .executeTakeFirst();

  const mappedRole = mapProviderRole(claims, provider);
  if (!mappedRole) {
    if (identity) await revokeAccess(db, identity.user_id);
    return { ok: false, error: 'forbidden' };
  }

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
  const verified = isVerified(claims.email_verified);
  if (provider.allowedDomains.length > 0) {
    // Only a verified address proves the domain.
    if (!email) return { ok: false, error: 'missing_email' };
    if (!verified) return { ok: false, error: 'email_not_verified' };
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (!email.includes('@') || !provider.allowedDomains.includes(domain)) {
      if (identity) await revokeAccess(db, identity.user_id);
      return { ok: false, error: 'domain_not_allowed' };
    }
  }

  const now = nowIso();
  let user = identity
    ? await db.selectFrom('users').selectAll().where('id', '=', identity.user_id).executeTakeFirst()
    : undefined;
  let linked = false;
  if (!user && email) {
    const byEmail = await db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
    if (byEmail) {
      // Already linked to another identity of this provider: never re-link silently.
      const other = await db
        .selectFrom('user_oidc_identities')
        .select('subject')
        .where('user_id', '=', byEmail.id)
        .where('provider_id', '=', provider.id)
        .executeTakeFirst();
      if (other) return { ok: false, error: 'account_conflict' };
      if (!provider.linkByEmail) return { ok: false, error: 'account_not_linked' };
      if (!verified) return { ok: false, error: 'email_not_verified' };
      await db
        .insertInto('user_oidc_identities')
        .values({ provider_id: provider.id, subject: sub, user_id: byEmail.id, created_at: now, last_login_at: null })
        .execute();
      user = byEmail;
      linked = true;
    }
  }

  if (user) {
    if (syncsRoleOnLogin(provider) && user.role !== mappedRole) {
      // Same safeguards as a change in the admin UI (token revocation, last admin).
      if ((await changeUserRole(db, user.id, mappedRole)) === 'last_admin') {
        // Logging in still works: locking out the only admin would be worse than a stale role.
        log?.warn(
          { userId: user.id, mappedRole, provider: provider.id },
          'OIDC role sync skipped: the user is the last admin and cannot be demoted',
        );
      } else {
        user = { ...user, role: mappedRole };
      }
    }
    await db
      .updateTable('user_oidc_identities')
      .set({ last_login_at: now })
      .where('provider_id', '=', provider.id)
      .where('subject', '=', sub)
      .execute();
    return { ok: true, user, created: false, linked };
  }

  if (!provider.autoCreateUsers) return { ok: false, error: 'no_account' };
  if (!email) return { ok: false, error: 'missing_email' };
  // The e-mail becomes the account's unique identity (linking, create-user CLI), so it
  // must be verified just like for linking: an unverified claim could squat an address.
  if (!verified) return { ok: false, error: 'email_not_verified' };

  const name =
    [claims.name, claims.preferred_username, email].find((v): v is string => typeof v === 'string' && v.trim() !== '') ??
    email;
  const created: User = {
    id: newId(),
    email,
    name: name.trim().slice(0, 120),
    role: mappedRole,
    password_hash: null,
    oidc_subject: null,
    created_at: now,
    updated_at: now,
    last_login_at: null,
  };
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('users').values(created).execute();
    await trx
      .insertInto('user_oidc_identities')
      .values({ provider_id: provider.id, subject: sub, user_id: created.id, created_at: now, last_login_at: now })
      .execute();
  });
  return { ok: true, user: created, created: true, linked: true };
}

/** openid-client, loaded with the first login so instances without OIDC never keep it in memory. */
let library: Promise<typeof OidcLib> | null = null;
const loadLibrary = (): Promise<typeof OidcLib> => (library ??= import('openid-client'));

/** Lazily discovered OIDC client of one provider. */
export class OidcClient {
  private configuration: Promise<OidcLib.Configuration> | null = null;

  constructor(
    private readonly provider: Pick<OidcProvider, 'id' | 'issuerUrl' | 'clientId' | 'clientSecret' | 'scopes'>,
    private readonly baseUrl: string,
  ) {}

  get redirectUri(): string {
    return `${this.baseUrl}${oidcCallbackPath(this.provider.id)}`;
  }

  private discover(): Promise<OidcLib.Configuration> {
    if (!this.configuration) {
      const { issuerUrl, clientId, clientSecret } = this.provider;
      const issuer = new URL(issuerUrl);
      this.configuration = loadLibrary()
        .then((client) =>
          client.discovery(
            issuer,
            clientId,
            clientSecret || undefined,
            clientSecret ? undefined : client.None(),
            // Plain http issuers are only meant for local test setups.
            issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined,
          ),
        )
        .catch((err: unknown) => {
          // Retry discovery on the next login attempt.
          this.configuration = null;
          throw err;
        });
    }
    return this.configuration;
  }

  /** Builds the IdP redirect URL and the state to keep in the signed cookie. */
  async startLogin(): Promise<{ url: string; state: OidcLoginState }> {
    const configuration = await this.discover();
    const client = await loadLibrary();
    const verifier = client.randomPKCECodeVerifier();
    const state: OidcLoginState = {
      p: this.provider.id,
      v: verifier,
      s: client.randomState(),
      n: client.randomNonce(),
      e: Date.now() + OIDC_STATE_TTL_SECONDS * 1000,
    };
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri,
      scope: this.provider.scopes,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: state.s,
      nonce: state.n,
    });
    return { url: url.href, state };
  }

  /** Exchanges the authorization code and returns the merged ID token / userinfo claims. */
  async finishLogin(currentUrl: URL, state: OidcLoginState): Promise<Claims> {
    if (state.p !== this.provider.id) throw new Error('Login state of another provider');
    const configuration = await this.discover();
    const client = await loadLibrary();
    const tokens = await client.authorizationCodeGrant(configuration, currentUrl, {
      pkceCodeVerifier: state.v,
      expectedState: state.s,
      expectedNonce: state.n,
      idTokenExpected: true,
    });
    const idClaims = tokens.claims();
    if (!idClaims) throw new Error('No ID token returned');

    let userinfo: Claims = {};
    if (configuration.serverMetadata().userinfo_endpoint) {
      try {
        userinfo = { ...(await client.fetchUserInfo(configuration, tokens.access_token, idClaims.sub)) };
      } catch {
        // Userinfo is optional; the ID token is authoritative.
      }
    }
    // ID token claims win; userinfo fills in claims (e.g. groups) the ID token lacks.
    return { ...userinfo, ...idClaims };
  }
}

/**
 * The login state of the cookie, or null when it is missing, malformed,
 * expired or belongs to another provider than `providerId`.
 */
export function parseLoginState(raw: string | null | undefined, providerId: string): OidcLoginState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<OidcLoginState>;
    if (
      typeof value.p !== 'string' ||
      typeof value.v !== 'string' ||
      typeof value.s !== 'string' ||
      typeof value.n !== 'string' ||
      typeof value.e !== 'number'
    ) {
      return null;
    }
    if (value.p !== providerId) return null;
    return value.e > Date.now() ? (value as OidcLoginState) : null;
  } catch {
    return null;
  }
}
