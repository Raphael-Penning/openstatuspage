/**
 * OpenID Connect providers for the management login (docs/oidc.md).
 *
 * Any number of providers is managed in the admin API (`oidc-providers`); the
 * provider configured with the OIDC_* environment variables is listed as a
 * read-only provider with the id {@link ENV_OIDC_PROVIDER_ID}.
 *
 * The client secret is write-only: the API reports only whether one is set.
 */
import { z } from 'zod';

/** Id of the provider configured with the OIDC_* environment variables. */
export const ENV_OIDC_PROVIDER_ID = 'env';

/** What a role mapping grants: a role, or no access at all. */
export const OIDC_ROLE_TARGETS = ['admin', 'editor', 'deny'] as const;
export type OidcRoleTarget = (typeof OIDC_ROLE_TARGETS)[number];

/**
 * Role of a user none of whose claim values is mapped. Admin is only granted by
 * an explicit mapping.
 */
export const OIDC_DEFAULT_ROLES = ['editor', 'deny'] as const;
export type OidcDefaultRole = (typeof OIDC_DEFAULT_ROLES)[number];

/**
 * When the mapped role is written to the user: on every login (the identity
 * provider is the source of truth) or only when the user is created.
 */
export const OIDC_ROLE_SYNC_MODES = ['login', 'create'] as const;
export type OidcRoleSyncMode = (typeof OIDC_ROLE_SYNC_MODES)[number];

/** Where a provider is configured. */
export type OidcProviderSource = 'database' | 'environment';

/** Error codes of a failed SSO login (`/admin/login?error=<code>`). */
export const OIDC_LOGIN_ERRORS = [
  'oidc_unavailable',
  'invalid_state',
  'idp_error',
  'oidc_failed',
  'forbidden',
  'domain_not_allowed',
  'no_account',
  'missing_email',
  'missing_subject',
  'email_not_verified',
  'account_conflict',
] as const;

/** Lower-case DNS name with at least two labels, e.g. `example.com`. */
const DOMAIN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export const OidcRoleMapping = z.object({
  /** A value of the role claim (group name, group object id, app role, ...). */
  value: z.string().trim().min(1).max(256),
  role: z.enum(OIDC_ROLE_TARGETS),
});
export type OidcRoleMapping = z.infer<typeof OidcRoleMapping>;

/**
 * Issuer URL: http(s), no credentials, query or fragment (the discovery
 * document lives below it). The server additionally refuses plain http in
 * production.
 */
export const zIssuerUrl = z
  .url({ protocol: /^https?$/ })
  .max(500)
  // No userinfo (no "@" before the path), no query, no fragment.
  .regex(/^https?:\/\/[^/?#@\s]+(?:\/[^?#\s]*)?$/i, 'The issuer URL must not contain credentials, a query or a fragment');

/** Claim path: a claim name, dots address nested claims (`realm_access.roles`). */
const zClaimPath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\s]+$/, 'No spaces');

/** Input of the admin API (create, and the merged state of a partial update). */
export const OidcProviderInput = z.object({
  /** Shown on the login button: "Sign in with <name>". */
  name: z.string().trim().min(1).max(80),
  /** Position of the button on the login page (ascending). */
  sortOrder: z.number().int().min(0).max(9999).default(0),
  enabled: z.boolean().default(true),
  issuerUrl: zIssuerUrl,
  clientId: z.string().trim().min(1).max(500),
  /**
   * Write-only. A string sets a new secret, null removes it (public client),
   * leaving it out keeps the stored one.
   */
  clientSecret: z.string().min(1).max(4000).nullish(),
  /** Space separated; must contain `openid`. */
  scopes: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .default('openid email profile')
    .refine((value) => value.split(/\s+/).includes('openid'), 'The scopes must contain openid'),
  /** Create unknown users on their first login (only with a verified e-mail address). */
  autoCreateUsers: z.boolean().default(false),
  /** Only e-mail addresses (verified) of these domains may sign in; empty: any. */
  allowedDomains: z
    .array(z.string().trim().toLowerCase().regex(DOMAIN_PATTERN, 'Not a domain name'))
    .max(50)
    .default([]),
  roleClaim: zClaimPath.default('groups'),
  roleMappings: z.array(OidcRoleMapping).max(100).default([]),
  defaultRole: z.enum(OIDC_DEFAULT_ROLES).default('editor'),
  roleSync: z.enum(OIDC_ROLE_SYNC_MODES).default('login'),
});
export type OidcProviderInput = z.infer<typeof OidcProviderInput>;

/** POST /api/admin/oidc-providers/test: discovery of an issuer that is not saved yet. */
export const OidcDiscoveryTestInput = z.object({ issuerUrl: zIssuerUrl });
export type OidcDiscoveryTestInput = z.infer<typeof OidcDiscoveryTestInput>;

/** A provider in the admin API (`oidc-providers`). */
export interface AdminOidcProvider {
  id: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
  source: OidcProviderSource;
  /** Configured in the environment: shown, tested, but not changed here. */
  readOnly: boolean;
  issuerUrl: string;
  clientId: string;
  /** Whether a client secret is stored (the secret itself is never returned). */
  hasClientSecret: boolean;
  scopes: string;
  autoCreateUsers: boolean;
  allowedDomains: string[];
  roleClaim: string;
  roleMappings: OidcRoleMapping[];
  defaultRole: OidcDefaultRole;
  roleSync: OidcRoleSyncMode;
  /** Redirect URI to register at the identity provider. */
  callbackUrl: string;
  /** Path of the login button. */
  loginPath: string;
  /** Users linked to an identity of this provider. */
  linkedUsers: number;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Result of a discovery test (meta of the test answer). */
export interface OidcDiscoveryResult {
  ok: boolean;
  message: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string | null;
  jwksUri?: string;
  endSessionEndpoint?: string | null;
  /** Problems that do not prevent a login (e.g. no S256 advertised). */
  warnings?: string[];
}

/** A login button of the login page (`auth-configs` attribute `oidcProviders`). */
export interface OidcLoginProvider {
  id: string;
  label: string;
  loginPath: string;
}
