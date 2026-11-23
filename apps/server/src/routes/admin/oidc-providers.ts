/**
 * /api/admin/oidc-providers (admin, JSON:API): the SSO providers of the login.
 *
 *   GET    /api/admin/oidc-providers              the environment provider (read-only) and the stored ones
 *   POST   /api/admin/oidc-providers
 *   GET    /api/admin/oidc-providers/:id
 *   PATCH  /api/admin/oidc-providers/:id          partial update; `clientSecret` null removes the secret
 *   DELETE /api/admin/oidc-providers/:id          also removes the identities linked through it
 *   POST   /api/admin/oidc-providers/test         discovery test of an issuer URL (not stored)
 *   POST   /api/admin/oidc-providers/:id/test     discovery test of a provider
 *
 * The client secret is write-only: stored encrypted (SecretBox), answered as
 * `hasClientSecret`, never written to the audit log. The provider with the id
 * `env` comes from the OIDC_* environment variables and cannot be changed here.
 */
import {
  ENV_OIDC_PROVIDER_ID,
  OidcDiscoveryTestInput,
  OidcProviderInput,
  type AdminOidcProvider,
} from '@openstatuspage/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { newId } from '../../lib/ids.js';
import { collection, created, document, metaDocument, noContent, resource, selfLink } from '../../lib/jsonapi.js';
import { nowIso } from '../../lib/time.js';
import { useJsonApi } from '../../plugins/jsonapi.js';
import { loadAdminOidcProviders, MAX_OIDC_PROVIDERS, testOidcDiscovery } from '../../services/oidc-providers.js';
import { admin, auditRequest } from './util.js';

export const OIDC_PROVIDER_TYPE = 'oidc-providers';
const DISCOVERY_TEST_TYPE = 'oidc-discovery-tests';

const ProviderParams = z.object({ id: z.string().min(1).max(64) });

const asObject = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

export function oidcProviderResource(provider: AdminOidcProvider) {
  return resource(OIDC_PROVIDER_TYPE, provider.id, provider, { links: { self: `/api/admin/oidc-providers/${provider.id}` } });
}

/**
 * Plain http issuers only outside production (local test IdPs): the discovery
 * document and the keys that sign the ID tokens would otherwise travel unprotected.
 */
function assertIssuerAllowed(config: Config, issuerUrl: string): void {
  if (config.NODE_ENV === 'production' && new URL(issuerUrl).protocol !== 'https:') {
    throw badRequest('The issuer URL must use https', [
      { code: 'custom', path: ['issuerUrl'], message: 'The issuer URL must use https' },
    ]);
  }
}

/** Fields that changed (for the audit log; the secret only as set / removed). */
function changedFields(before: AdminOidcProvider, after: AdminOidcProvider, secret: string | null | undefined): string[] {
  const keys = [
    'name',
    'sortOrder',
    'enabled',
    'issuerUrl',
    'clientId',
    'scopes',
    'autoCreateUsers',
    'allowedDomains',
    'roleClaim',
    'roleMappings',
    'defaultRole',
    'roleSync',
  ] as const;
  const fields: string[] = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (secret !== undefined) fields.push('clientSecret');
  return fields;
}

/** Audit details: the configuration without the secret. */
const auditDetails = (p: AdminOidcProvider) => ({
  name: p.name,
  issuerUrl: p.issuerUrl,
  enabled: p.enabled,
  autoCreateUsers: p.autoCreateUsers,
  defaultRole: p.defaultRole,
  roleSync: p.roleSync,
  roleMappings: p.roleMappings.length,
  allowedDomains: p.allowedDomains,
});

export async function registerOidcProviderRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    useJsonApi(scope);
    scope.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });
    registerRoutes(scope);
  });
}

function registerRoutes(app: FastifyInstance): void {
  const { db, config, secrets } = app.ctx;
  const typed = { ...admin, config: { jsonapi: { type: OIDC_PROVIDER_TYPE } } };

  const get = async (id: string): Promise<AdminOidcProvider> => {
    const [provider] = await loadAdminOidcProviders(db, config, [id]);
    if (!provider) throw notFound('OIDC provider');
    return provider;
  };
  const idOf = (req: FastifyRequest) => parse(ProviderParams, req.params).id;
  const assertWritable = (id: string) => {
    if (id === ENV_OIDC_PROVIDER_ID) {
      throw conflict('This provider is configured with the OIDC_* environment variables and cannot be changed here');
    }
  };

  app.get('/api/admin/oidc-providers', admin, async (req) =>
    collection(req, (await loadAdminOidcProviders(db, config)).map(oidcProviderResource)),
  );

  app.post('/api/admin/oidc-providers', typed, async (req, reply) => {
    const input = parse(OidcProviderInput, req.body);
    assertIssuerAllowed(config, input.issuerUrl);
    const count = await db
      .selectFrom('oidc_providers')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    if (Number(count.n) >= MAX_OIDC_PROVIDERS) throw conflict(`At most ${MAX_OIDC_PROVIDERS} providers`);
    const id = newId();
    const now = nowIso();
    await db
      .insertInto('oidc_providers')
      .values({
        id,
        name: input.name,
        sort_order: input.sortOrder,
        enabled: input.enabled ? 1 : 0,
        issuer_url: input.issuerUrl,
        client_id: input.clientId,
        client_secret: input.clientSecret ? secrets.encrypt(input.clientSecret) : null,
        scopes: input.scopes,
        auto_create_users: input.autoCreateUsers ? 1 : 0,
        allowed_domains: JSON.stringify([...new Set(input.allowedDomains)]),
        role_claim: input.roleClaim,
        role_mappings: JSON.stringify(input.roleMappings),
        default_role: input.defaultRole,
        role_sync: input.roleSync,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const provider = await get(id);
    await auditRequest(db, req, 'oidc_provider.create', 'oidc_provider', id, {
      ...auditDetails(provider),
      clientSecret: provider.hasClientSecret ? 'set' : 'none',
    });
    return created(reply, document(oidcProviderResource(provider), { links: { self: selfLink(req) } }), `/api/admin/oidc-providers/${id}`);
  });

  app.get('/api/admin/oidc-providers/:id', admin, async (req) =>
    document(oidcProviderResource(await get(idOf(req))), { links: { self: selfLink(req) } }),
  );

  // Partial update: missing attributes keep their values; a missing clientSecret keeps the stored one.
  app.patch('/api/admin/oidc-providers/:id', typed, async (req) => {
    const id = idOf(req);
    assertWritable(id);
    const current = await get(id);
    const body = asObject(req.body);
    const input = parse(OidcProviderInput, {
      name: current.name,
      sortOrder: current.sortOrder,
      enabled: current.enabled,
      issuerUrl: current.issuerUrl,
      clientId: current.clientId,
      scopes: current.scopes,
      autoCreateUsers: current.autoCreateUsers,
      allowedDomains: current.allowedDomains,
      roleClaim: current.roleClaim,
      roleMappings: current.roleMappings,
      defaultRole: current.defaultRole,
      roleSync: current.roleSync,
      ...body,
    });
    if (input.issuerUrl !== current.issuerUrl) assertIssuerAllowed(config, input.issuerUrl);
    const secret = Object.hasOwn(body, 'clientSecret') ? (input.clientSecret ?? null) : undefined;
    await db
      .updateTable('oidc_providers')
      .set({
        name: input.name,
        sort_order: input.sortOrder,
        enabled: input.enabled ? 1 : 0,
        issuer_url: input.issuerUrl,
        client_id: input.clientId,
        ...(secret !== undefined ? { client_secret: secret ? secrets.encrypt(secret) : null } : {}),
        scopes: input.scopes,
        auto_create_users: input.autoCreateUsers ? 1 : 0,
        allowed_domains: JSON.stringify([...new Set(input.allowedDomains)]),
        role_claim: input.roleClaim,
        role_mappings: JSON.stringify(input.roleMappings),
        default_role: input.defaultRole,
        role_sync: input.roleSync,
        updated_at: nowIso(),
      })
      .where('id', '=', id)
      .execute();
    const provider = await get(id);
    await auditRequest(db, req, 'oidc_provider.update', 'oidc_provider', id, {
      ...auditDetails(provider),
      fields: changedFields(current, provider, secret),
      ...(secret !== undefined ? { clientSecret: secret ? 'set' : 'removed' } : {}),
    });
    return document(oidcProviderResource(provider), { links: { self: selfLink(req) } });
  });

  app.delete('/api/admin/oidc-providers/:id', admin, async (req, reply) => {
    const id = idOf(req);
    assertWritable(id);
    const provider = await get(id);
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('user_oidc_identities').where('provider_id', '=', id).execute();
      await trx.deleteFrom('oidc_providers').where('id', '=', id).execute();
    });
    await auditRequest(db, req, 'oidc_provider.delete', 'oidc_provider', id, {
      name: provider.name,
      issuerUrl: provider.issuerUrl,
      unlinkedUsers: provider.linkedUsers,
    });
    return noContent(reply);
  });

  // Discovery tests send a request chosen by the admin: few per minute.
  const testRoute = { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post(
    '/api/admin/oidc-providers/test',
    { ...testRoute, config: { ...testRoute.config, jsonapi: { type: DISCOVERY_TEST_TYPE } } },
    async (req) => {
      const { issuerUrl } = parse(OidcDiscoveryTestInput, req.body);
      assertIssuerAllowed(config, issuerUrl);
      return metaDocument({ ...(await testOidcDiscovery(issuerUrl)) });
    },
  );

  app.post('/api/admin/oidc-providers/:id/test', testRoute, async (req) => {
    const provider = await get(idOf(req));
    if (provider.source === 'database') assertIssuerAllowed(config, provider.issuerUrl);
    return metaDocument({ ...(await testOidcDiscovery(provider.issuerUrl)) });
  });
}
