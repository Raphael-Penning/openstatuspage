/**
 * The SSO providers of the management login.
 *
 * - The provider of the OIDC_* environment variables (id `env`) is read-only:
 *   it is listed and tested in the admin UI but configured only in the
 *   environment, so its secret never enters the database.
 * - Providers managed in the admin UI live in `oidc_providers`; the client
 *   secret is stored encrypted with SecretBox and never returned by the API.
 *
 * `OidcProviderRegistry` hands out the discovered clients for logins and
 * rediscovers a provider whenever its stored configuration changed (also when
 * another instance changed it).
 */
import {
  ENV_OIDC_PROVIDER_ID,
  OidcRoleMapping,
  type AdminOidcProvider,
  type OidcDiscoveryResult,
  type OidcLoginProvider,
} from '@openstatuspage/shared';
import { z } from 'zod';
import { AdapterError, createAdapterFetch, describeUrl, requestJson, type FetchFn } from '../adapters/http.js';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import type { OidcProviderRow } from '../db/types.js';
import { sha256, type SecretBox } from '../lib/crypto.js';
import { envProvider, OidcClient, oidcCallbackPath, oidcLoginPath, type OidcLogger, type OidcProvider } from './oidc.js';

/** Most providers kept (a guard against a runaway script, far above any real setup). */
export const MAX_OIDC_PROVIDERS = 50;
/** Discovery test: time limit and size limit of the discovery document. */
export const DISCOVERY_TIMEOUT_MS = 10_000;
export const DISCOVERY_MAX_BYTES = 256 * 1024;

const Mappings = z.array(OidcRoleMapping);
const Domains = z.array(z.string());

function parseJson<T>(schema: z.ZodType<T>, text: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Runtime provider of a row. `secrets` decrypts the client secret; without it
 * (listings) the secret stays null. A secret that cannot be decrypted (changed
 * SECRET_KEY) throws.
 */
export function providerFromRow(row: OidcProviderRow, secrets?: SecretBox): OidcProvider {
  const roleMappings = parseJson(Mappings, row.role_mappings);
  return {
    id: row.id,
    label: row.name,
    source: 'database',
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    issuerUrl: row.issuer_url,
    clientId: row.client_id,
    clientSecret: secrets && row.client_secret ? secrets.decrypt(row.client_secret) : null,
    scopes: row.scopes,
    autoCreateUsers: row.auto_create_users === 1,
    // Unreadable domains must not widen access: an impossible domain lets nobody in.
    allowedDomains: parseJson(Domains, row.allowed_domains) ?? ['invalid.invalid'],
    roleClaim: row.role_claim,
    // Unreadable mappings must not widen access: deny everybody instead.
    roleMappings: roleMappings ?? [],
    defaultRole: roleMappings === null || row.default_role !== 'editor' ? 'deny' : 'editor',
    roleSync: row.role_sync,
    version: sha256(JSON.stringify(row)),
  };
}

/** The admin API representation (never the secret). */
export function toAdminOidcProvider(
  provider: OidcProvider,
  extra: { baseUrl: string; hasClientSecret: boolean; linkedUsers: number; createdAt: string | null; updatedAt: string | null },
): AdminOidcProvider {
  const readOnly = provider.source === 'environment';
  return {
    id: provider.id,
    name: provider.label,
    sortOrder: provider.sortOrder,
    enabled: provider.enabled,
    source: provider.source,
    readOnly,
    issuerUrl: provider.issuerUrl,
    clientId: provider.clientId,
    hasClientSecret: extra.hasClientSecret,
    scopes: provider.scopes,
    autoCreateUsers: provider.autoCreateUsers,
    allowedDomains: provider.allowedDomains,
    roleClaim: provider.roleClaim,
    roleMappings: provider.roleMappings,
    defaultRole: provider.defaultRole,
    roleSync: provider.roleSync,
    callbackUrl: `${extra.baseUrl}${oidcCallbackPath(provider.id)}`,
    loginPath: oidcLoginPath(provider.id),
    linkedUsers: extra.linkedUsers,
    createdAt: extra.createdAt,
    updatedAt: extra.updatedAt,
  };
}

/** Linked users per provider id. */
async function linkedUserCounts(db: DB): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom('user_oidc_identities')
    .select(['provider_id', (eb) => eb.fn.countAll<number>().as('count')])
    .groupBy('provider_id')
    .execute();
  return new Map(rows.map((r) => [r.provider_id, Number(r.count)]));
}

/** Every provider for the admin API: the environment one first, then by button order and name. */
export async function loadAdminOidcProviders(
  db: DB,
  config: Config,
  ids?: string[],
): Promise<AdminOidcProvider[]> {
  const counts = await linkedUserCounts(db);
  const out: AdminOidcProvider[] = [];
  const env = envProvider(config);
  if (env && (!ids || ids.includes(env.id))) {
    out.push(
      toAdminOidcProvider(env, {
        baseUrl: config.BASE_URL,
        hasClientSecret: env.clientSecret !== null,
        linkedUsers: counts.get(env.id) ?? 0,
        createdAt: null,
        updatedAt: null,
      }),
    );
  }
  let query = db.selectFrom('oidc_providers').selectAll().orderBy('sort_order').orderBy('name').orderBy('id');
  if (ids) {
    const dbIds = ids.filter((id) => id !== ENV_OIDC_PROVIDER_ID);
    if (dbIds.length === 0) return out;
    query = query.where('id', 'in', dbIds);
  }
  for (const row of await query.execute()) {
    out.push(
      toAdminOidcProvider(providerFromRow(row), {
        baseUrl: config.BASE_URL,
        hasClientSecret: row.client_secret !== null,
        linkedUsers: counts.get(row.id) ?? 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    );
  }
  return out;
}

/** Discovered clients for the logins, cached per provider configuration. */
export class OidcProviderRegistry {
  private readonly clients = new Map<string, { version: string; client: OidcClient }>();

  constructor(
    private readonly deps: { config: Config; db: DB; secrets: SecretBox; log?: OidcLogger },
  ) {}

  /** The enabled providers of the login page, in button order (the environment one first). */
  async loginProviders(): Promise<OidcLoginProvider[]> {
    const out: OidcLoginProvider[] = [];
    const env = envProvider(this.deps.config);
    if (env) out.push({ id: env.id, label: env.label, loginPath: oidcLoginPath(env.id) });
    const rows = await this.deps.db
      .selectFrom('oidc_providers')
      .select(['id', 'name'])
      .where('enabled', '=', 1)
      .orderBy('sort_order')
      .orderBy('name')
      .orderBy('id')
      .execute();
    for (const row of rows) out.push({ id: row.id, label: row.name, loginPath: oidcLoginPath(row.id) });
    return out;
  }

  /** An enabled provider with its secret, or null (unknown, disabled or unreadable secret). */
  async get(id: string): Promise<OidcProvider | null> {
    if (id === ENV_OIDC_PROVIDER_ID) return envProvider(this.deps.config);
    const row = await this.deps.db.selectFrom('oidc_providers').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) {
      this.clients.delete(id);
      return null;
    }
    if (row.enabled !== 1) return null;
    try {
      return providerFromRow(row, this.deps.secrets);
    } catch {
      this.deps.log?.warn({ provider: id }, 'OIDC provider skipped: its client secret cannot be decrypted (was SECRET_KEY changed?)');
      return null;
    }
  }

  /** The client of `provider`, rediscovered after a configuration change. */
  client(provider: OidcProvider): OidcClient {
    const cached = this.clients.get(provider.id);
    if (cached && cached.version === provider.version) return cached.client;
    const client = new OidcClient(provider, this.deps.config.BASE_URL);
    this.clients.set(provider.id, { version: provider.version, client });
    return client;
  }
}

/** Fields of a discovery document the test reads. */
const DiscoveryDocument = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
  userinfo_endpoint: z.string().optional(),
  end_session_endpoint: z.string().optional(),
  response_types_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});

/** Where the discovery document of `issuerUrl` lives (OpenID Connect Discovery 1.0, section 4). */
export function discoveryUrl(issuerUrl: string): string {
  return `${issuerUrl.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

/**
 * "Test configuration": fetches and checks the discovery document of an issuer.
 *
 * The same rules as the other requests an admin can trigger (monitor source
 * tests): only http(s), a time limit, a size limit on the answer, no
 * redirects, and messages without credentials or query strings. Nothing is
 * sent but a plain GET (no client id or secret).
 */
export async function testOidcDiscovery(
  issuerUrl: string,
  fetchFn: FetchFn = createAdapterFetch({ verifyTls: true, timeoutMs: DISCOVERY_TIMEOUT_MS }),
): Promise<OidcDiscoveryResult> {
  const url = discoveryUrl(issuerUrl);
  let raw: unknown;
  try {
    raw = await requestJson(fetchFn, url, {
      system: 'Identity provider',
      headers: { accept: 'application/json' },
      limits: { maxBytes: DISCOVERY_MAX_BYTES, maxValues: 20_000 },
    });
  } catch (err) {
    return { ok: false, message: err instanceof AdapterError ? err.message : `Discovery of ${describeUrl(url)} failed` };
  }
  const parsed = DiscoveryDocument.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: `${describeUrl(url)} is not an OpenID Connect discovery document (issuer, authorization_endpoint, token_endpoint and jwks_uri are required)`,
    };
  }
  const doc = parsed.data;
  const result: OidcDiscoveryResult = {
    ok: true,
    message: 'Discovery succeeded',
    issuer: doc.issuer,
    authorizationEndpoint: describeUrl(doc.authorization_endpoint),
    tokenEndpoint: describeUrl(doc.token_endpoint),
    userinfoEndpoint: doc.userinfo_endpoint ? describeUrl(doc.userinfo_endpoint) : null,
    jwksUri: describeUrl(doc.jwks_uri),
    endSessionEndpoint: doc.end_session_endpoint ? describeUrl(doc.end_session_endpoint) : null,
    warnings: [],
  };
  // The login validates the issuer exactly like this (a trailing slash counts).
  if (doc.issuer !== issuerUrl) {
    return {
      ...result,
      ok: false,
      message: `The issuer of the discovery document (${doc.issuer}) differs from the configured issuer URL (${issuerUrl}). Use exactly the issuer of the document.`,
    };
  }
  const insecure = [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri].filter((u) => {
    try {
      const protocol = new URL(u).protocol;
      return protocol !== 'https:' && !(protocol === 'http:' && new URL(issuerUrl).protocol === 'http:');
    } catch {
      return true;
    }
  });
  if (insecure.length > 0) {
    return { ...result, ok: false, message: 'The identity provider announces endpoints that are not https URLs' };
  }
  if (doc.response_types_supported && !doc.response_types_supported.includes('code')) {
    return { ...result, ok: false, message: 'The identity provider does not support the authorization code flow' };
  }
  if (doc.code_challenge_methods_supported && !doc.code_challenge_methods_supported.includes('S256')) {
    result.warnings!.push('The identity provider does not announce PKCE with S256; logins send it anyway.');
  } else if (!doc.code_challenge_methods_supported) {
    result.warnings!.push('The identity provider does not announce its PKCE methods; logins use S256.');
  }
  if (!doc.userinfo_endpoint) {
    result.warnings!.push('No userinfo endpoint: the role claim must be part of the ID token.');
  }
  return result;
}
