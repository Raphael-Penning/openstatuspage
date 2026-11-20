// @vitest-environment jsdom
/**
 * Server-side rendering and hydration of every public page: the markup of
 * entry-server.tsx (rendered against the fake API of the accessibility tests)
 * hydrates without a single hydration warning or recoverable error, in both
 * languages, and the browser then switches to the visitor's time zone.
 */
import type { DataDocument, PublicDocumentSource, SsrFormState, SsrRenderResult } from '@openstatuspage/shared';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cacheKey, pageUrl, render } from './entry-server';
import { hydratePublic } from './hydrate';
import { incident, respond, settings, SUBSCRIPTION_TOKEN } from './public/a11y/fixtures';
import { installBrowserStubs, settle } from './public/a11y/harness';
import type { SsrState } from './public/ssr-state';

const BASE_URL = 'https://status.example.com';

const source: PublicDocumentSource = {
  async get(path) {
    const { status, body } = respond('GET', path);
    if (status !== 200) throw Object.assign(new Error('Not found'), { status });
    return body as DataDocument;
  },
};

const PAGES: [name: string, url: string, status: number][] = [
  ['overview', '/', 200],
  ['services', '/services', 200],
  ['service detail', '/services/api', 200],
  ['unknown service', '/services/missing', 404],
  ['locations', '/locations', 200],
  ['history', '/history?type=incident', 200],
  ['incident', '/incidents/inc-1', 200],
  ['unknown incident', '/incidents/missing', 404],
  ['maintenance', '/maintenance/m-1', 200],
  ['subscribe', '/subscribe', 200],
  ['subscription confirm', `/subscription/confirm?id=sub-1#token=${SUBSCRIPTION_TOKEN}`, 200],
  ['subscription confirm (query token)', `/subscription/confirm?id=sub-1&token=${SUBSCRIPTION_TOKEN}`, 200],
  ['subscription manage', '/subscription/manage?id=sub-1', 200],
  ['subscription manage (query token)', `/subscription/manage?id=sub-1&token=${SUBSCRIPTION_TOKEN}&saved=1`, 200],
  ['subscription manage (unsubscribe)', `/subscription/manage?id=sub-1&token=${SUBSCRIPTION_TOKEN}&unsubscribe=1`, 200],
  ['subscribed', '/subscribe?sent=1', 200],
  ['services filtered', '/services?q=api&status=operational', 200],
  ['history page 2', '/history?type=all&service=&month=&page=2', 200],
  ['not found', '/does-not-exist', 404],
];

beforeAll(() => installBrowserStubs());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

async function serverRender(
  url: string,
  init: { cookie?: string; acceptLanguage?: string; form?: SsrFormState } = {},
): Promise<SsrRenderResult> {
  return render({ url: url.split('#')[0]!, source, baseUrl: BASE_URL, ...init });
}

/** Puts the server markup into the document like the server's page template, then hydrates it. */
async function hydrateResult(url: string, result: SsrRenderResult): Promise<{ root: HTMLElement; problems: string[] }> {
  window.history.replaceState(null, '', url);
  document.head.innerHTML = `<title>${result.head.title}</title>${result.hoisted}`;
  document.body.innerHTML = `<div id="root">${result.html}</div>`;
  const root = document.getElementById('root')!;
  const problems: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => problems.push(args.map(String).join(' ')));
  // The state travels as JSON text, like in the page.
  const state = JSON.parse(result.state) as SsrState;
  await act(async () => {
    await hydratePublic(root, state, { onRecoverableError: (err) => problems.push(`recoverable: ${String(err)}`) });
  });
  await settle(20);
  return { root, problems };
}

describe('server rendering', () => {
  it.each(PAGES)('%s renders with status %i', async (_name, url, status) => {
    const result = await serverRender(url);
    expect(result.status).toBe(status);
    expect(result.html).toContain('<main');
    expect(result.lang).toBe('en');
    expect(JSON.parse(result.state)).toMatchObject({ v: 1, lang: 'en', baseUrl: BASE_URL });
  });

  it('renders the data of the page', async () => {
    const overview = await serverRender('/');
    expect(overview.html).toContain(settings.siteName);
    expect(overview.html).toContain(incident.title);
    const detail = await serverRender('/incidents/inc-1');
    expect(detail.html).toContain(incident.title);
    expect(detail.head.title).toBe(`${incident.title} · ${settings.siteName}`);
    expect(detail.head.canonical).toBe(`${BASE_URL}/incidents/inc-1`);
    const missing = await serverRender('/incidents/missing');
    expect(missing.head).toMatchObject({ status: 404, robots: 'noindex', canonical: null });
  });

  it('renders the uptime bars of every screen width, narrow ones by media query', async () => {
    const services = await serverRender('/services');
    const bar = /aria-roledescription="uptime bar"[^>]*>([\s\S]*?)<\/div><\/div>/.exec(services.html)?.[1] ?? '';
    const segments = bar.match(/<div class="[^"]*"/g) ?? [];
    expect(segments.length).toBeGreaterThan(30);
    // The newest 30 days show on phones, the newest 60 on tablets: no re-render after hydration.
    expect(segments.filter((s) => !s.includes('max-sm:hidden'))).toHaveLength(30);
    expect(segments.filter((s) => !s.includes('max-lg:hidden')).length).toBe(Math.min(60, segments.length));
  });

  it('moves hoisted elements to the head', async () => {
    const overview = await serverRender('/');
    expect(overview.hoisted).toContain('<link rel="alternate" type="application/rss+xml"');
    expect(overview.html).not.toContain('<link');
    expect(overview.html.startsWith('<div')).toBe(true);
    const manage = await serverRender('/subscription/manage');
    expect(manage.hoisted).toContain('<meta name="referrer" content="no-referrer"/>');
  });

  it('renders times in UTC', async () => {
    const detail = await serverRender('/incidents/inc-1');
    expect(detail.html).toMatch(/ UTC</);
  });

  it('picks the language from ?lang=, the cookie, Accept-Language, then the page default', async () => {
    expect((await serverRender('/', { cookie: 'a=1; osp-lang=de', acceptLanguage: 'en' })).lang).toBe('de');
    expect((await serverRender('/?lang=de')).lang).toBe('de');
    // The language version the canonical URL and hreflang name, whatever the cookie says.
    expect((await serverRender('/?lang=de', { cookie: 'osp-lang=en' })).lang).toBe('de');
    expect((await serverRender('/', { acceptLanguage: 'fr-CH, de;q=0.8, en;q=0.5' })).lang).toBe('de');
    expect((await serverRender('/', { acceptLanguage: 'fr' })).lang).toBe(settings.defaultLocale);
    expect((await serverRender('/?lang=de')).html).toContain('lang="de"');
  });

  it('takes the theme from the cookie', async () => {
    expect((await serverRender('/', { cookie: 'osp-theme=dark' })).theme).toBe('dark');
    expect((await serverRender('/', { cookie: 'osp-theme=evil' })).theme).toBe(settings.defaultTheme);
  });

  it('has a cache key per URL, language and theme input', () => {
    const key = (url: string, cookie?: string, acceptLanguage?: string) => cacheKey({ url, cookie, acceptLanguage });
    expect(key('/', 'osp-lang=de')).not.toBe(key('/'));
    expect(key('/', undefined, 'de-AT')).not.toBe(key('/', undefined, 'en'));
    expect(key('/', undefined, 'en-US')).toBe(key('/', undefined, 'en'));
    expect(key('/', 'osp-theme=dark')).not.toBe(key('/'));
    expect(key('/?lang=de')).not.toBe(key('/'));
    // Only the query parameters the pages read, in a fixed order.
    expect(key('/?x=1')).toBe(key('/'));
    expect(key('/history?x=1&page=2&type=incident')).toBe(key('/history?type=incident&page=2'));
  });

  it('renders pages with the query parameters they read only', () => {
    expect(pageUrl('/history?utm_source=x&page=2&type=incident&lang=de')).toBe('/history?lang=de&type=incident&page=2');
    expect(pageUrl('/?x=1')).toBe('/');
    expect(pageUrl('/services?q=a%20b&status=operational')).toBe('/services?q=a+b&status=operational');
  });
});

describe('hydration', () => {
  it.each(PAGES)('%s hydrates without mismatches', async (_name, url) => {
    const result = await serverRender(url);
    const { root, problems } = await hydrateResult(url, result);
    expect(problems).toEqual([]);
    // Hoisted elements are adopted, not duplicated.
    expect(document.querySelectorAll('link[rel="alternate"][type="application/rss+xml"]')).toHaveLength(1);
    expect(root.querySelector('link, meta')).toBeNull();
  });

  it.each(['en', 'de'])('hydrates in the server language (%s)', async (lang) => {
    const result = await serverRender(`/services/api?lang=${lang}`);
    const { root, problems } = await hydrateResult('/services/api', result);
    expect(problems).toEqual([]);
    expect(document.documentElement.lang).toBe(lang);
    expect(root.textContent).toContain('API');
  });

  it('hydrates a page that answers a form with its values and errors', async () => {
    const form: SsrFormState = {
      values: { email: 'not-an-email', locale: 'de', scope: 'selected', service: [] },
      issues: [
        { path: ['email'], code: 'invalid_format' },
        { path: ['serviceIds'], code: 'custom' },
      ],
    };
    const result = await serverRender('/subscribe', { form });
    expect(result.head.title).toMatch(/^Error: /);
    expect(result.html).toContain('value="not-an-email"');
    expect(result.html).toContain('aria-invalid="true"');
    const { root, problems } = await hydrateResult('/subscribe', result);
    expect(problems).toEqual([]);
    const email = root.querySelector<HTMLInputElement>('input[name="email"]')!;
    expect(email.value).toBe('not-an-email');
    expect(root.querySelector('[role="alert"] a[href="#subscription-email"]')).not.toBeNull();
    expect(root.querySelector<HTMLInputElement>('input[name="scope"][value="selected"]')!.checked).toBe(true);
  });

  it('renders the manage page of a query token on the server', async () => {
    const result = await serverRender(`/subscription/manage?id=sub-1&token=${SUBSCRIPTION_TOKEN}`);
    expect(result.html).toContain('action="/subscription/manage"');
    expect(result.html).toContain(`name="token" value="${SUBSCRIPTION_TOKEN}"`);
    const confirm = await serverRender(`/subscription/manage?id=sub-1&token=${SUBSCRIPTION_TOKEN}&unsubscribe=1`);
    expect(confirm.html).toContain('action="/subscription/unsubscribe"');
  });

  it('mirrors a theme stored before the cookie existed into the cookie', async () => {
    document.cookie = 'osp-theme=; Max-Age=0; Path=/';
    localStorage.setItem('osp-theme', 'dark');
    const result = await serverRender('/');
    const { problems } = await hydrateResult('/', result);
    expect(problems).toEqual([]);
    expect(document.cookie).toContain('osp-theme=dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    document.cookie = 'osp-theme=; Max-Age=0; Path=/';
  });

  it('switches to the visitor time zone after hydration', async () => {
    localStorage.setItem('osp-tz', 'local');
    const result = await serverRender('/incidents/inc-1');
    expect(result.html).toMatch(/ UTC</);
    const { root, problems } = await hydrateResult('/incidents/inc-1', result);
    expect(problems).toEqual([]);
    expect(root.innerHTML).not.toMatch(/ UTC</);
  });
});
