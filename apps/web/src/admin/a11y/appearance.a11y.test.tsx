// @vitest-environment jsdom
/**
 * Settings → Appearance (themes): accessibility (WCAG 2.2 AA, axe-core) of the
 * list, the live preview, the editor and the import dialog in both languages,
 * the activation of a theme that fails AA (refused until confirmed), and the
 * accent preview of Settings without an override.
 * Renders the real admin routes against a fake API.
 */
import { BUILTIN_THEMES, themeContrastFailures, type AdminTheme, type AdminUser, type AuthConfig } from '@openstatuspage/shared';
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
  oidcLinked: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};
const authConfig: AuthConfig = { oidcEnabled: false, oidcLabel: '', localLoginEnabled: true, oidcProviders: [] };

const pale = JSON.parse(JSON.stringify(BUILTIN_THEMES[1])) as AdminTheme['definition'];
pale.id = 'pale';
pale.name = 'Pale';
pale.light.muted = '#b0b0b0';

const entry = (definition: AdminTheme['definition'], patch: Partial<AdminTheme>): AdminTheme => ({
  id: definition.id,
  name: definition.name,
  author: definition.author ?? null,
  description: definition.description ?? null,
  source: 'builtin',
  readOnly: true,
  active: false,
  definition,
  cssBytes: 0,
  contrastFailures: themeContrastFailures(definition),
  contrastUnconfirmed: false,
  updatedAt: null,
  ...patch,
});

const themes: AdminTheme[] = [
  entry(BUILTIN_THEMES[0]!, { active: true }),
  entry(BUILTIN_THEMES[2]!, { source: 'folder', updatedAt: '2026-01-01T00:00:00.000Z' }),
  entry(pale, { source: 'database', readOnly: false, cssBytes: 20, updatedAt: '2026-01-01T00:00:00.000Z' }),
];
/** Pale is active, but nobody confirmed its failures (its file changed after the activation). */
const unconfirmedThemes: AdminTheme[] = [
  entry(BUILTIN_THEMES[0]!, {}),
  themes[1]!,
  { ...themes[2]!, active: true, contrastUnconfirmed: true },
];
let served = themes;
/** The accent in effect that the public settings answer (the active theme's, without an override). */
let publicAccent = settings.accentColor;

const JSONAPI = { version: '1.1' };
const one = (type: string, id: string, attributes: object) => ({ jsonapi: JSONAPI, data: { type, id, attributes } });
const many = (type: string, items: { id: string }[]) => ({
  jsonapi: JSONAPI,
  data: items.map(({ id, ...attributes }) => ({ type, id, attributes })),
});

const requests: { method: string; path: string; body: unknown }[] = [];

function respond(method: string, path: string, body: unknown): { status: number; body: unknown } {
  if (method === 'GET' && path === '/api/auth/config') return { status: 200, body: one('auth-configs', 'current', authConfig) };
  if (method === 'GET' && path === '/api/auth/session') {
    return {
      status: 200,
      body: {
        jsonapi: JSONAPI,
        data: { type: 'sessions', id: 'current', attributes: { oidcEnabled: false }, relationships: { user: { data: { type: 'users', id: admin.id } } } },
        included: [{ type: 'users', id: admin.id, attributes: { ...admin, id: undefined } }],
      },
    };
  }
  if (method === 'GET' && path === '/api/public/settings') return { status: 200, body: settingsDocument({ ...settings, accentColor: publicAccent }) };
  if (method === 'GET' && path === '/api/admin/settings') return { status: 200, body: one('settings', 'site', { ...settings, accentColor: null, analyticsAvailable: false }) };
  // Not part of these tests (the settings page shows the mail status).
  if (method === 'GET' && path === '/api/admin/notifications/status') {
    return { status: 403, body: { jsonapi: JSONAPI, errors: [{ status: '403', code: 'forbidden', detail: 'not here' }] } };
  }
  if (method === 'GET' && path === '/api/admin/themes') return { status: 200, body: many('themes', served) };
  const single = /^\/api\/admin\/themes\/([^/]+)$/.exec(path);
  if (method === 'GET' && single) {
    const theme = served.find((x) => x.id === single[1])!;
    return { status: 200, body: one('themes', theme.id, { ...theme, css: theme.cssBytes ? '.osp-group{gap:1rem}' : null }) };
  }
  const activate = /^\/api\/admin\/themes\/([^/]+)\/activate$/.exec(path);
  if (method === 'POST' && activate) {
    requests.push({ method, path, body });
    const theme = served.find((x) => x.id === activate[1])!;
    const accepted = (body as { data?: { attributes?: { acceptContrastFailures?: boolean } } })?.data?.attributes?.acceptContrastFailures;
    if (theme.contrastFailures.length > 0 && !accepted) {
      return {
        status: 409,
        body: { jsonapi: JSONAPI, errors: [{ status: '409', code: 'contrast_failures', detail: 'fails', meta: { failures: theme.contrastFailures } }] },
      };
    }
    return { status: 200, body: one('themes', theme.id, { ...theme, active: true }) };
  }
  return { status: 200, body: { jsonapi: JSONAPI, data: [] } };
}

let root: Root | null = null;
let queryClient: QueryClient | null = null;

async function render(path: string, lang: 'en' | 'de', ready = 'table'): Promise<HTMLElement> {
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
    if (container.querySelector('main h1') && container.querySelector(ready) && !container.querySelector('[aria-busy="true"], .animate-spin')) {
      return container;
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

const byText = (selector: string, text: string) =>
  [...document.querySelectorAll(selector)].find((el) => el.textContent?.trim() === text || el.getAttribute('aria-label') === text);

beforeAll(() => {
  installBrowserStubs();
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const answer = respond(init?.method ?? 'GET', url.pathname, body);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/vnd.api+json' } });
  };
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

afterEach(() => {
  served = themes;
  publicAccent = settings.accentColor;
  act(() => root?.unmount());
  queryClient?.clear();
  root = null;
});

describe.each(['en', 'de'] as const)('Appearance (%s)', (lang) => {
  it(
    'theme list, live preview, editor and import have no WCAG A/AA violations',
    async () => {
      const container = await render('/admin/appearance', lang);
      expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
      // Source badges and the contrast result of every theme.
      expect(container.textContent).toContain(i18n.t('admin:appearance.sources.folder'));
      expect(container.textContent).toContain(i18n.t('admin:appearance.sources.database'));
      expect(container.textContent).toContain(i18n.t('admin:appearance.failsAA', { count: themes[2]!.contrastFailures.length }));
      // The public preview link carries ?theme=<id> (the server only honours it for signed-in admins).
      expect(container.querySelector('a[href="/?theme=forest"]')).toBeTruthy();
      expect(await axeViolations()).toEqual([]);

      await click(byText('button', i18n.t('admin:appearance.previewLabel', { name: 'Forest' })));
      expect(container.textContent).toContain(i18n.t('admin:appearance.livePreview', { name: 'Forest' }));
      expect(await axeViolations()).toEqual([]);

      await click(byText('button', i18n.t('admin:appearance.editLabel', { name: 'Pale' })));
      const dialog = document.querySelector('dialog[open]')!;
      expect(dialog.querySelectorAll('input[type="color"]').length).toBeGreaterThan(20);
      expect(dialog.textContent).toContain(i18n.t('admin:appearance.failsAA', { count: themes[2]!.contrastFailures.length }));
      expect(await axeViolations()).toEqual([]);
      await click(byText('dialog[open] button', i18n.t('common:actions.cancel')));

      await click(byText('button', i18n.t('admin:appearance.import')));
      expect(document.querySelector('dialog[open] input[type="file"]')).toBeTruthy();
      expect(await axeViolations()).toEqual([]);
    },
    AXE_TIMEOUT_MS,
  );

  it('activating a theme that fails AA asks first and then sends the confirmation', async () => {
    requests.length = 0;
    await render('/admin/appearance', lang);
    await click(byText('button', i18n.t('admin:appearance.activate')) && [...document.querySelectorAll('tbody tr')][2]!.querySelector('button'));
    // Nothing sent yet: the dialog lists the failures.
    expect(requests).toHaveLength(0);
    const dialog = document.querySelector('dialog[open]')!;
    expect(dialog.textContent).toContain(i18n.t('admin:appearance.failingTitle'));
    await click(byText('dialog[open] button', i18n.t('admin:appearance.activateAnyway')));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe('/api/admin/themes/pale/activate');
    expect(requests[0]!.body).toMatchObject({ data: { type: 'themes', attributes: { acceptContrastFailures: true } } });
  });

  it(
    'an active theme whose failures nobody confirmed is flagged and can be confirmed',
    async () => {
      requests.length = 0;
      served = unconfirmedThemes;
      const container = await render('/admin/appearance', lang);
      const count = themes[2]!.contrastFailures.length;
      expect(container.textContent).toContain(i18n.t('admin:appearance.unconfirmed', { name: 'Pale', count }));
      expect(await axeViolations()).toEqual([]);
      await click(byText('button', i18n.t('admin:appearance.review')));
      expect(requests).toHaveLength(0);
      expect(document.querySelector('dialog[open]')!.textContent).toContain(i18n.t('admin:appearance.failingTitle'));
      await click(byText('dialog[open] button', i18n.t('admin:appearance.activateAnyway')));
      expect(requests).toHaveLength(1);
      expect(requests[0]!.path).toBe('/api/admin/themes/pale/activate');
      expect(requests[0]!.body).toMatchObject({ data: { attributes: { acceptContrastFailures: true } } });
    },
    AXE_TIMEOUT_MS,
  );

  it('the accent preview of the settings shows the accent of the active theme while no override is set', async () => {
    publicAccent = '#2563eb';
    const label = i18n.t('admin:settings.pickColor');
    await render('/admin/settings', lang, `input[type="color"][aria-label="${label}"]`);
    const picker = document.querySelector<HTMLInputElement>(`input[type="color"][aria-label="${label}"]`)!;
    expect(picker.value).toBe('#2563eb');
    expect(document.querySelector<HTMLInputElement>('#accent-hex')!.value).toBe('');
  });
});
