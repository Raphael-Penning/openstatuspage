// @vitest-environment jsdom
/**
 * The API documentation page (/admin/api) with the committed OpenAPI document
 * (docs/openapi.json): accessibility (WCAG 2.2 AA, axe-core) in both languages
 * with operations opened, filtering, and the "try it" form: a GET sent with the
 * session and the CSRF header, a mutating request only after the confirmation.
 */
import type { AdminUser, AuthConfig } from '@openstatuspage/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import openapi from '../../../../../docs/openapi.json';
import '../../lib/i18n-admin';
import i18n from '../../lib/i18n';
import { ThemeProvider } from '../../lib/theme';
import { settingsDocument } from '../../public/a11y/documents';
import { settings } from '../../public/a11y/fixtures';
import { axeViolations, installBrowserStubs, settle } from '../../public/a11y/harness';
import { adminRoutes } from '../routes';

const AXE_TIMEOUT_MS = 60_000;
const JSONAPI = { version: '1.1' };

const editor: AdminUser = {
  id: 'u-editor',
  email: 'editor@example.com',
  name: 'Eddie Editor',
  role: 'editor',
  hasPassword: true,
  oidcLinked: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};

const authConfig: AuthConfig = { oidcEnabled: false, oidcLabel: 'SSO', localLoginEnabled: true, oidcProviders: [] };

interface Sent {
  method: string;
  url: string;
  headers: Headers;
  body?: string;
}
let sent: Sent[] = [];

function respond(method: string, url: URL): { status: number; body: unknown; type?: string } {
  const path = url.pathname;
  if (path === '/api/openapi.json') return { status: 200, body: openapi, type: 'application/json' };
  if (path === '/api/auth/config') return { status: 200, body: { jsonapi: JSONAPI, data: { type: 'auth-configs', id: 'current', attributes: authConfig } } };
  if (path === '/api/auth/session') {
    return {
      status: 200,
      body: {
        jsonapi: JSONAPI,
        data: { type: 'sessions', id: 'current', attributes: {}, relationships: { user: { data: { type: 'users', id: editor.id } } } },
        included: [{ type: 'users', id: editor.id, attributes: { ...editor, id: undefined } }],
      },
    };
  }
  if (path === '/api/public/settings') return { status: 200, body: settingsDocument(settings) };
  if (method === 'GET' && path === '/api/public/status') {
    return { status: 200, body: { jsonapi: JSONAPI, data: { type: 'statuses', id: 'current', attributes: { overall: 'operational' } } } };
  }
  if (method === 'POST' && path === '/api/admin/incidents') {
    return { status: 201, body: { jsonapi: JSONAPI, data: { type: 'incidents', id: 'i-1', attributes: { title: 'Slow API' } } } };
  }
  return { status: 200, body: { jsonapi: JSONAPI, data: [] } };
}

let root: Root | null = null;
let queryClient: QueryClient | null = null;

async function render(lang: 'en' | 'de'): Promise<HTMLElement> {
  localStorage.clear();
  localStorage.setItem('osp-lang-chosen', '1');
  await i18n.changeLanguage(lang);
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
  const router = createMemoryRouter(adminRoutes, { initialEntries: ['/admin/api'] });
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
    if (container.querySelector('main details')) return container;
  }
  throw new Error(`Page did not finish loading:\n${container.innerHTML.slice(0, 2000)}`);
}

/** Opens the <details> of an operation the way a click on its summary does. */
async function open(operationId: string): Promise<HTMLDetailsElement> {
  const details = document.getElementById(operationId) as HTMLDetailsElement | null;
  expect(details, operationId).toBeTruthy();
  await act(async () => {
    details!.open = true;
    details!.dispatchEvent(new Event('toggle'));
  });
  await settle(20);
  return details!;
}

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle(20);
}

async function type(el: Element | null, value: string) {
  expect(el).toBeTruthy();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const submit = (details: Element) => click(details.querySelector('form button[type="submit"]'));

beforeAll(() => {
  installBrowserStubs();
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const method = init?.method ?? 'GET';
    sent.push({ method, url: `${url.pathname}${url.search}`, headers: new Headers(init?.headers), body: init?.body as string | undefined });
    const { status, body, type } = respond(method, url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': type ?? 'application/vnd.api+json' } });
  };
});

afterEach(() => {
  act(() => root?.unmount());
  queryClient?.clear();
  root = null;
  sent = [];
});

describe.each(['en', 'de'] as const)('API documentation (%s)', (lang) => {
  it(
    'lists the operations by tag and has no WCAG A/AA violations, also with operations open',
    async () => {
      const container = await render(lang);
      expect(container.querySelector('main h1')?.textContent).toBe(i18n.t('admin:apiDocs.title'));
      const operations = Object.values(openapi.paths).flatMap((item) => Object.keys(item));
      expect(container.querySelectorAll('main details')).toHaveLength(operations.length);
      expect(container.querySelectorAll('main section h2').length).toBe(openapi.tags.length);
      expect(container.querySelector('a[href="/api/openapi.json"]')).not.toBeNull();
      expect(await axeViolations()).toEqual([]);

      // A read, a JSON:API create with relationships and an upload (no "try it").
      const service = await open('getPublicServicesByIdOrSlug');
      expect(service.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
      const create = await open('postAdminServices');
      expect(create.textContent).toContain('ServiceInput');
      expect(create.textContent).toContain(i18n.t('admin:apiDocs.adminOnly'));
      const upload = await open('postAdminUploads');
      expect(upload.textContent).toContain(i18n.t('admin:apiDocs.tryItUnavailable'));
      await open('postIngestBySourceId');
      expect(await axeViolations()).toEqual([]);
    },
    AXE_TIMEOUT_MS,
  );

  it(
    'filters the operations',
    async () => {
      const container = await render(lang);
      await type(container.querySelector('main input[type="search"]'), 'post incidents');
      const shown = [...container.querySelectorAll('main details summary code')].map((c) => c.textContent);
      expect(shown).toContain('/api/admin/incidents');
      expect(shown.every((path) => path?.includes('incidents'))).toBe(true);
      expect(container.querySelector('main [role="status"]')?.textContent).toBe(i18n.t('admin:apiDocs.results', { count: shown.length }));
      await type(container.querySelector('main input[type="search"]'), 'no such endpoint');
      expect(container.querySelectorAll('main details')).toHaveLength(0);
      expect(container.textContent).toContain(i18n.t('admin:apiDocs.noResults'));
      expect(await axeViolations()).toEqual([]);
    },
    AXE_TIMEOUT_MS,
  );

  it(
    'tries a GET with the CSRF header and a mutating request only after the confirmation',
    async () => {
      await render(lang);
      const status = await open('getPublicStatus');
      await submit(status);
      const get = sent.find((r) => r.url === '/api/public/status');
      expect(get?.method).toBe('GET');
      expect(get?.headers.get('x-requested-with')).toBe('openstatuspage');
      expect(status.querySelector('[aria-live] pre')?.textContent).toContain('"overall": "operational"');

      const incidents = await open('postAdminIncidents');
      expect(incidents.textContent).toContain(i18n.t('admin:apiDocs.mutatingWarning', { method: 'POST' }));
      // The example of the documentation is the starting body.
      expect((incidents.querySelector('textarea') as HTMLTextAreaElement).value).toContain('"type": "incidents"');
      await submit(incidents);
      expect(sent.some((r) => r.method === 'POST')).toBe(false);
      expect(incidents.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('admin:apiDocs.confirmRequired'));
      expect(await axeViolations()).toEqual([]);

      await click(incidents.querySelector('input[type="checkbox"]'));
      await submit(incidents);
      const post = sent.find((r) => r.method === 'POST');
      expect(post?.url).toBe('/api/admin/incidents');
      expect(post?.headers.get('content-type')).toBe('application/vnd.api+json');
      expect(post?.headers.get('x-requested-with')).toBe('openstatuspage');
      expect(JSON.parse(post!.body!)).toMatchObject({ data: { type: 'incidents' } });
      expect(incidents.querySelector('[aria-live]')?.textContent).toContain('201');
      expect(await axeViolations()).toEqual([]);
    },
    AXE_TIMEOUT_MS,
  );

  it(
    'refuses empty and dot path values before sending',
    async () => {
      await render(lang);
      const remove = await open('deleteAdminServicesById');
      await click(remove.querySelector('input[type="checkbox"]'));
      const input = remove.querySelector('input[data-param="path:id"]') as HTMLInputElement;
      await submit(remove);
      expect(sent.some((r) => r.method === 'DELETE')).toBe(false);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(input);
      expect(remove.textContent).toContain(i18n.t('admin:apiDocs.pathValueEmpty', { name: 'id' }));
      expect(await axeViolations()).toEqual([]);

      await type(input, '..');
      await submit(remove);
      expect(sent.some((r) => r.method === 'DELETE')).toBe(false);
      expect(remove.textContent).toContain(i18n.t('admin:apiDocs.pathValueDot', { name: 'id' }));

      await type(input, 'svc-1');
      expect(input.getAttribute('aria-invalid')).toBeNull();
      await submit(remove);
      expect(sent.find((r) => r.method === 'DELETE')?.url).toBe('/api/admin/services/svc-1');
    },
    AXE_TIMEOUT_MS,
  );
});
