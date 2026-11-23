import { describe, expect, it } from 'vitest';
import { OidcDiscoveryTestInput, OidcProviderInput } from './oidc-providers.js';

const base = { name: 'Example IdP', issuerUrl: 'https://idp.example.com/realms/example', clientId: 'openstatuspage' };

describe('OidcProviderInput', () => {
  it('applies conservative defaults', () => {
    expect(OidcProviderInput.parse(base)).toEqual({
      ...base,
      sortOrder: 0,
      enabled: true,
      scopes: 'openid email profile',
      autoCreateUsers: false,
      linkByEmail: false,
      allowedDomains: [],
      roleClaim: 'groups',
      roleMappings: [],
      defaultRole: 'editor',
      roleSync: 'login',
    });
  });

  it('rejects issuer URLs with credentials, query, fragment or other schemes', () => {
    for (const issuerUrl of [
      'https://user:pw@idp.example.com',
      'https://idp.example.com/?x=1',
      'https://idp.example.com/#x',
      'ftp://idp.example.com',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(OidcProviderInput.safeParse({ ...base, issuerUrl }).success, issuerUrl).toBe(false);
      expect(OidcDiscoveryTestInput.safeParse({ issuerUrl }).success, issuerUrl).toBe(false);
    }
  });

  it('requires the openid scope', () => {
    expect(OidcProviderInput.safeParse({ ...base, scopes: 'email profile' }).success).toBe(false);
    expect(OidcProviderInput.safeParse({ ...base, scopes: 'openid groups' }).success).toBe(true);
  });

  it('normalises domains and refuses admin as default role', () => {
    expect(OidcProviderInput.parse({ ...base, allowedDomains: [' Example.COM '] }).allowedDomains).toEqual(['example.com']);
    expect(OidcProviderInput.safeParse({ ...base, allowedDomains: ['@example.com'] }).success).toBe(false);
    expect(OidcProviderInput.safeParse({ ...base, allowedDomains: ['localhost'] }).success).toBe(false);
    expect(OidcProviderInput.safeParse({ ...base, defaultRole: 'admin' }).success).toBe(false);
  });

  it('validates role mappings', () => {
    const ok = OidcProviderInput.parse({
      ...base,
      roleClaim: 'realm_access.roles',
      roleMappings: [
        { value: 'statuspage-admins', role: 'admin' },
        { value: 'contractors', role: 'deny' },
      ],
    });
    expect(ok.roleMappings).toHaveLength(2);
    expect(OidcProviderInput.safeParse({ ...base, roleMappings: [{ value: 'x', role: 'owner' }] }).success).toBe(false);
    expect(OidcProviderInput.safeParse({ ...base, roleMappings: [{ value: ' ', role: 'admin' }] }).success).toBe(false);
    expect(OidcProviderInput.safeParse({ ...base, roleClaim: 'my groups' }).success).toBe(false);
  });
});
