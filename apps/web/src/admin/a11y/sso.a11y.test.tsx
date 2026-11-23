// @vitest-environment jsdom
/**
 * Accessibility checks (WCAG 2.2 AA, axe-core) of the login page with several
 * SSO providers and of the SSO provider management (list, forms, the read-only
 * environment provider and the discovery test result), in both languages.
 * Renders the real admin routes against a fake API.
 */
import type { AdminOidcProvider, AdminUser, AuthConfig, OidcDiscoveryResult } from '@openstatuspage/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import '../../lib/i18n-admin';
import i18n from '../../lib/i18n';
import { ThemeProvider } from '../../lib/theme';
import { settingsDocument } from '../../public/a11y/documents';
import { settings } from '../../public/a11y/fixtures';
import { axeViolations, installBrowserStubs, settle } from '../../public/a11y/harness';
import { adminRoutes } from '../routes';

const AXE_TIMEOUT_MS = 30_000;

const admin: AdminUser = {
  id: 'u-admin',
  email: 'admin@example.com',
  name: 'Ada Admin',
  role: 'admin',
  hasPassword: true,
  oidcLinked: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};

const authConfig: AuthConfig = {
  oidcEnabled: true,
  oidcLabel: 'Corporate SSO',
  localLoginEnabled: true,
  oidcProviders: [
    { id: 'env', label: 'Corporate SSO', loginPath: '/api/auth/oidc/login' },
    { id: 'p-1', label: 'Example IdP', loginPath: '/api/auth/oidc/p-1/login' },
  ],
};

const base = {
  sortOrder: 0,
  enabled: true,
  clientId: 'openstatuspage',
  hasClientSecret: true,
  scopes: 'openid email profile',
  autoCreateUsers: false,
  allowedDomains: [] as string[],
  roleClaim: 'groups',
  roleSync: 'login' as const,
  linkedUsers: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const providers: AdminOidcProvider[] = [
  {
    ...base,
    id: 'env',
    name: 'Corporate SSO',
    source: 'environment',
    readOnly: true,
    issuerUrl: 'https://idp.example.com/realms/example',
    roleMappings: [{ value: 'statuspage-admins', role: 'admin' }],
    defaultRole: 'editor',
    callbackUrl: 'https://status.example.com/api/auth/oidc/callback',
    loginPath: '/api/auth/oidc/login',
    createdAt: null,
    updatedAt: null,
  },
  {
    ...base,
    id: 'p-1',
    name: 'Example IdP',
    source: 'database',
    readOnly: false,
    issuerUrl: 'https://login.example.com',
    autoCreateUsers: true,
    allowedDomains: ['example.com'],
    roleClaim: 'realm_access.roles',
    roleMappings: [
      { value: 'statuspage-admins', role: 'admin' },
      { value: 'contractors', role: 'deny' },
    ],
    defaultRole: 'deny',
    callbackUrl: 'https://status.example.com/api/auth/oidc/p-1/callback',
    loginPath: '/api/auth/oidc/p-1/login',
  },
  {
    ...base,
    id: 'p-2',
    name: 'Partner IdP',
    enabled: false,
    source: 'database',
    readOnly: false,
    hasClientSecret: false,
    issuerUrl: 'https://partner.example.com',
    roleMappings: [],
    defaultRole: 'editor',
    callbackUrl: 'https://status.example.com/api/auth/oidc/p-2/callback',
    loginPath: '/api/auth/oidc/p-2/login',
    linkedUsers: 0,
  },
];

const discovery: OidcDiscoveryResult = {
  ok: true,
  message: 'Discovery succeeded',
  issuer: 'https://idp.example.com/realms/example',
  authorizationEndpoint: 'https://idp.example.com/realms/example/auth',
  tokenEndpoint: 'https://idp.example.com/realms/example/token',
  userinfoEndpoint: null,
  jwksUri: 'https://idp.example.com/realms/example/certs',
  endSessionEndpoint: null,
  warnings: ['No userinfo endpoint: the role claim must be part of the ID token.'],
};

const JSONAPI = { version: '1.1' };
const one = (type: string, id: string, attributes: object) => ({ jsonapi: JSONAPI, data: { type, id, attributes } });
const many = (type: string, items: { id: string }[]) => ({
  jsonapi: JSONAPI,
  data: items.map(({ id, ...attributes }) => ({ type, id, attributes })),
});

let signedIn = false;

function respond(method: string, path: string): { status: number; body: unknown } {
  if (method === 'GET' && path === '/api/auth/config') return { status: 200, body: one('auth-configs', 'current', authConfig) };
  if (method === 'GET' && path === '/api/auth/session') {
    if (!signedIn) return { status: 401, body: { jsonapi: JSONAPI, errors: [{ status: '401', code: 'unauthorized', detail: 'Authentication required' }] } };
    return {
      status: 200,
      body: {
        jsonapi: JSONAPI,
        data: { type: 'sessions', id: 'current', attributes: { oidcEnabled: true }, relationships: { user: { data: { type: 'users', id: admin.id } } } },
        included: [{ type: 'users', id: admin.id, attributes: { ...admin, id: undefined } }],
      },
    };
  }
  if (method === 'GET' && path === '/api/public/settings') return { status: 200, body: settingsDocument(settings) };
  if (method === 'GET' && path === '/api/admin/oidc-providers') return { status: 200, body: many('oidc-providers', providers) };
  if (method === 'POST' && /^\/api\/admin\/oidc-providers\/[^/]+\/test$/.test(path)) {
    return { status: 200, body: { jsonapi: JSONAPI, meta: discovery } };
  }
  if (method === 'POST' && path === '/api/admin/oidc-providers/test') {
    return { status: 200, body: { jsonapi: JSONAPI, meta: { ok: false, message: 'Identity provider returned HTTP 404 for https://login.example.com/.well-known/openid-configuration' } } };
  }
  return { status: 200, body: { jsonapi: JSONAPI, data: [] } };
}

let root: Root | null = null;
let queryClient: QueryClient | null = null;

async function render(path: string, lang: 'en' | 'de'): Promise<HTMLElement> {
  localStorage.clear();
  localStorage.setItem('osp-lang-chosen', '1');
  await i18n.changeLanguage(lang);
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
  const router = createMemoryRouter(adminRoutes, { initialEntries: [path] });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={queryClient!}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 300; i++) {
    await settle();
    const h1 = container.querySelector('main h1');
    if (h1 && !container.querySelector('[aria-busy="true"], .motion-safe\\:animate-pulse, .animate-spin')) {
      // The provider page is ready once its table (or empty state) is there.
      if (!path.endsWith('/sso') || container.querySelector('table')) return container;
    }
  }
  throw new Error(`Page did not finish loading:\n${container.innerHTML.slice(0, 2000)}`);
}

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle(20);
}

/** Types `value` into an input the way React notices it. */
async function type(el: Element | null, value: string) {
  expect(el).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const byText = (selector: string, text: string) =>
  [...document.querySelectorAll(selector)].find((el) => el.textContent?.trim() === text || el.getAttribute('aria-label') === text);

beforeAll(() => {
  installBrowserStubs();
  // installBrowserStubs answers with the public fixtures; the admin pages need their own API.
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const { status, body } = respond(init?.method ?? 'GET', url.pathname);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/vnd.api+json' } });
  };
  // jsdom implements <dialog> without the modal methods.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

afterEach(() => {
  act(() => root?.unmount());
  queryClient?.clear();
  root = null;
});

describe.each(['en', 'de'] as const)('SSO (%s)', (lang) => {
  it(
    'login page with several providers has no WCAG A/AA violations',
    async () => {
      signedIn = false;
      const container = await render('/admin/login?error=domain_not_allowed', lang);
      const buttons = [...container.querySelectorAll('a[href^="/api/auth/oidc/"]')].map((a) => a.getAttribute('href'));
      expect(buttons).toEqual(['/api/auth/oidc/login', '/api/auth/oidc/p-1/login']);
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('admin:login.errors.domain_not_allowed'));
      expect(await axeViolations()).toEqual([]);
    },
    AXE_TIMEOUT_MS,
  );

  it(
    'provider list, forms and test results have no WCAG A/AA violations',
    async () => {
      signedIn = true;
      const container = await render('/admin/sso', lang);
      expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
      expect(await axeViolations()).toEqual([]);

      // New provider: empty form, a mapping row added, and a failed discovery test.
      await click(byText('button', i18n.t('admin:sso.new')));
      await click(byText('button', i18n.t('admin:sso.addMapping')));
      await type(document.querySelector('dialog[open] input[type="url"]'), 'https://login.example.com');
      await click(byText('dialog[open] button', i18n.t('admin:sso.test')));
      expect(document.querySelector('dialog[open] [role="status"]')?.textContent).toContain(i18n.t('admin:sso.testFailed'));
      expect(await axeViolations()).toEqual([]);
      // Submitting the incomplete form shows the field errors.
      await click(document.querySelector('dialog[open] button[type="submit"]'));
      expect(document.querySelector('dialog[open] [role="alert"]')).not.toBeNull();
      expect(await axeViolations()).toEqual([]);
      await click(byText('dialog[open] button', i18n.t('common:actions.cancel')));

      // Existing provider: mappings, stored secret, redirect URI and the auto-create warning.
      await click(byText('button', i18n.t('admin:sso.editLabel', { name: 'Example IdP' })));
      expect(document.querySelectorAll('dialog[open] select')).toHaveLength(4);
      expect(await axeViolations()).toEqual([]);
      // A new issuer: the links are about to go, and the stored secret has to be replaced.
      await type(document.querySelector('dialog[open] input[type="url"]'), 'https://other.example.com');
      expect(document.querySelector('dialog[open]')?.textContent).toContain(i18n.t('admin:sso.issuerChangeWarning', { count: 2 }));
      await click(document.querySelector('dialog[open] button[type="submit"]'));
      const secret = document.querySelector<HTMLInputElement>('dialog[open] input[type="password"]')!;
      expect(secret.getAttribute('aria-invalid')).toBe('true');
      expect(document.querySelector('dialog[open]')?.textContent).toContain(i18n.t('admin:sso.issuerChangeSecret'));
      expect(await axeViolations()).toEqual([]);
      await click(byText('dialog[open] button', i18n.t('common:actions.cancel')));

      // The environment provider: read-only details and a successful test.
      await click(byText('button', i18n.t('admin:sso.viewLabel', { name: 'Corporate SSO' })));
      await click(byText('dialog[open] button', i18n.t('admin:sso.test')));
      expect(document.querySelector('dialog[open] [role="status"]')?.textContent).toContain(discovery.tokenEndpoint);
      expect(await axeViolations()).toEqual([]);
    },
    AXE_TIMEOUT_MS * 2,
  );
});
