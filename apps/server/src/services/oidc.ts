/**
 * OpenID Connect single sign-on (authorization code flow with PKCE).
 *
 * The IdP is discovered lazily on first use and cached. Pure helpers
 * (`extractGroups`, `mapOidcRole`) and the account resolution
 * (`resolveOidcUser`) are exported separately so they can be unit tested
 * without an IdP.
 */
import type { UserRole } from '@openstatuspage/shared';
import type * as OidcLib from 'openid-client';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import type { User } from '../db/types.js';
import { newId } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { deleteUserSessions } from './sessions.js';
import { changeUserRole } from './users.js';

export const OIDC_STATE_COOKIE = 'osp_oidc';
/** Lifetime of the login state (time the user has to finish the IdP login). */
export const OIDC_STATE_TTL_SECONDS = 600;

export interface OidcLoginState {
  /** PKCE code verifier. */
  v: string;
  /** state */
  s: string;
  /** nonce */
  n: string;
  /** expiry, epoch ms */
  e: number;
}

export interface OidcRoleConfig {
  /** Claim holding the groups; dots address nested claims (e.g. `realm_access.roles`). */
  groupsClaim: string;
  adminGroup?: string | null;
  editorGroup?: string | null;
}

export type Claims = Record<string, unknown>;

/** Reads the group list from `claims`. Accepts arrays and space/comma separated strings. */
export function extractGroups(claims: Claims, claimPath: string): string[] {
  let value: unknown = claims;
  if (claimPath in claims) {
    value = claims[claimPath];
  } else {
    for (const part of claimPath.split('.')) {
      if (value && typeof value === 'object' && part in value) value = (value as Record<string, unknown>)[part];
      else return [];
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

function inGroup(groups: string[], wanted: string | null | undefined): boolean {
  if (!wanted) return false;
  const target = normalizeGroup(wanted);
  return groups.some((g) => normalizeGroup(g) === target);
}

/** True when the role is derived from IdP groups (and synced on every login). */
export function roleMappingEnabled(cfg: OidcRoleConfig): boolean {
  return Boolean(cfg.adminGroup || cfg.editorGroup);
}

/**
 * Role granted by the IdP groups, or null when the user may not log in.
 *
 * - member of the admin group            → admin
 * - member of the editor group           → editor
 * - no editor group configured           → editor (every authenticated user)
 * - editor group configured, not member  → null (access denied)
 */
export function mapOidcRole(claims: Claims, cfg: OidcRoleConfig): UserRole | null {
  const groups = extractGroups(claims, cfg.groupsClaim);
  if (inGroup(groups, cfg.adminGroup)) return 'admin';
  if (!cfg.editorGroup) return 'editor';
  return inGroup(groups, cfg.editorGroup) ? 'editor' : null;
}

export type OidcErrorCode =
  | 'forbidden'
  | 'no_account'
  | 'missing_email'
  | 'email_not_verified'
  | 'account_conflict'
  | 'missing_subject';

export type OidcUserResult = { ok: true; user: User; created: boolean } | { ok: false; error: OidcErrorCode };

function isVerified(value: unknown): boolean {
  return value === true || value === 'true';
}

/** Minimal logger interface, so the account resolution can be tested without Fastify. */
export interface OidcLogger {
  warn(obj: object, msg: string): void;
}

/**
 * Finds (or creates) the local user for a verified ID token.
 * Linking order: `oidc_subject`, then verified e-mail. New users are only
 * created for a verified e-mail. With group mapping configured, the role is
 * synchronised on every login.
 */
export async function resolveOidcUser(
  db: DB,
  config: Pick<Config, 'OIDC_GROUPS_CLAIM' | 'OIDC_ADMIN_GROUP' | 'OIDC_EDITOR_GROUP' | 'OIDC_AUTO_CREATE_USERS'>,
  claims: Claims,
  log?: OidcLogger,
): Promise<OidcUserResult> {
  const sub = typeof claims.sub === 'string' ? claims.sub : null;
  if (!sub) return { ok: false, error: 'missing_subject' };

  const roleCfg: OidcRoleConfig = {
    groupsClaim: config.OIDC_GROUPS_CLAIM,
    adminGroup: config.OIDC_ADMIN_GROUP,
    editorGroup: config.OIDC_EDITOR_GROUP,
  };
  const mappedRole = mapOidcRole(claims, roleCfg);
  if (!mappedRole) {
    // Removed from the allowed groups: also end the sessions of the linked user
    // and revoke the API tokens they created, which would otherwise keep their
    // last role (sessions until they expire, tokens forever).
    const known = await db.selectFrom('users').select('id').where('oidc_subject', '=', sub).executeTakeFirst();
    if (known) {
      await deleteUserSessions(db, known.id);
      await db.deleteFrom('api_tokens').where('created_by', '=', known.id).execute();
    }
    return { ok: false, error: 'forbidden' };
  }
  const syncRole = roleMappingEnabled(roleCfg);

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
  const now = nowIso();

  let user = await db.selectFrom('users').selectAll().where('oidc_subject', '=', sub).executeTakeFirst();
  if (!user && email) {
    const byEmail = await db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
    if (byEmail) {
      // Already linked to another IdP identity: never re-link silently.
      if (byEmail.oidc_subject) return { ok: false, error: 'account_conflict' };
      if (!isVerified(claims.email_verified)) return { ok: false, error: 'email_not_verified' };
      await db.updateTable('users').set({ oidc_subject: sub, updated_at: now }).where('id', '=', byEmail.id).execute();
      user = { ...byEmail, oidc_subject: sub };
    }
  }

  if (user) {
    if (syncRole && user.role !== mappedRole) {
      // Same safeguards as a change in the admin UI (token revocation, last admin).
      if ((await changeUserRole(db, user.id, mappedRole)) === 'last_admin') {
        // Logging in still works: locking out the only admin would be worse than a stale role.
        log?.warn(
          { userId: user.id, mappedRole },
          'OIDC role sync skipped: the user is the last admin and cannot be demoted',
        );
      } else {
        user = { ...user, role: mappedRole };
      }
    }
    return { ok: true, user, created: false };
  }

  if (!config.OIDC_AUTO_CREATE_USERS) return { ok: false, error: 'no_account' };
  if (!email) return { ok: false, error: 'missing_email' };
  // The e-mail becomes the account's unique identity (linking, create-user CLI), so it
  // must be verified just like for linking: an unverified claim could squat an address.
  if (!isVerified(claims.email_verified)) return { ok: false, error: 'email_not_verified' };

  const name =
    [claims.name, claims.preferred_username, email].find((v): v is string => typeof v === 'string' && v.trim() !== '') ??
    email;
  const created: User = {
    id: newId(),
    email,
    name: name.trim().slice(0, 120),
    role: mappedRole,
    password_hash: null,
    oidc_subject: sub,
    created_at: now,
    updated_at: now,
    last_login_at: null,
  };
  await db.insertInto('users').values(created).execute();
  return { ok: true, user: created, created: true };
}

/** openid-client, loaded with the first login so instances without OIDC never keep it in memory. */
let library: Promise<typeof OidcLib> | null = null;
const loadLibrary = (): Promise<typeof OidcLib> => (library ??= import('openid-client'));

/** Lazily discovered OIDC client configuration. */
export class OidcClient {
  private configuration: Promise<OidcLib.Configuration> | null = null;

  constructor(private readonly config: Config) {}

  get redirectUri(): string {
    return `${this.config.BASE_URL}/api/auth/oidc/callback`;
  }

  private discover(): Promise<OidcLib.Configuration> {
    if (!this.configuration) {
      const { OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET } = this.config;
      if (!OIDC_ISSUER_URL || !OIDC_CLIENT_ID) throw new Error('OIDC is not configured');
      const issuer = new URL(OIDC_ISSUER_URL);
      this.configuration = loadLibrary()
        .then((client) =>
          client.discovery(
            issuer,
            OIDC_CLIENT_ID,
            OIDC_CLIENT_SECRET || undefined,
            OIDC_CLIENT_SECRET ? undefined : client.None(),
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
      v: verifier,
      s: client.randomState(),
      n: client.randomNonce(),
      e: Date.now() + OIDC_STATE_TTL_SECONDS * 1000,
    };
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri,
      scope: this.config.OIDC_SCOPES,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: state.s,
      nonce: state.n,
    });
    return { url: url.href, state };
  }

  /** Exchanges the authorization code and returns the merged ID token / userinfo claims. */
  async finishLogin(currentUrl: URL, state: OidcLoginState): Promise<Claims> {
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

export function parseLoginState(raw: string | null | undefined): OidcLoginState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<OidcLoginState>;
    if (
      typeof value.v !== 'string' ||
      typeof value.s !== 'string' ||
      typeof value.n !== 'string' ||
      typeof value.e !== 'number'
    ) {
      return null;
    }
    return value.e > Date.now() ? (value as OidcLoginState) : null;
  } catch {
    return null;
  }
}
