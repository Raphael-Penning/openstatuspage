/**
 * Every public page works without JavaScript: the server-rendered markup has
 * the forms and links of every control (action, method, field names), and no
 * interactive element in it depends on a script.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryMailer } from '../src/mail/mailer.js';
import { subscriberTokens } from '../src/services/subscriptions.js';
import { adminClient, BASE_URL, createTestApp, type Client, type TestApp } from './helpers.js';
import { createWebDir, elements, formHtml, renderFromSource, rootOf } from './web-fixture.js';

let web: ReturnType<typeof createWebDir>;
beforeAll(() => {
  web = createWebDir();
});
afterAll(() => web.remove());

let t: TestApp;
let admin: Client;
let ids: { slug: string; group: string; service: string; incident: string };

beforeEach(async () => {
  t = await createTestApp({}, { mailer: new MemoryMailer(), web: { dir: web.dir, ssrModule: renderFromSource } });
  admin = await adminClient(t);
  await admin.patch('/api/admin/settings', { siteName: 'Example Status', emailSubscriptionsEnabled: true });
  const group = (await admin.post('/api/admin/service-groups', { name: 'Platform', collapsedByDefault: true })).json().data.id;
  const fra = (
    await admin.post('/api/admin/locations', { name: 'Frankfurt', code: 'FRA-1', region: 'europe', latitude: 50.11, longitude: 8.68 })
  ).json().data.id;
  const service = (await admin.post('/api/admin/services', { name: 'Public API', groupId: group, locationIds: [fra] })).json().data.id;
  await admin.post('/api/admin/services', { name: 'Website', kind: 'site', url: 'https://www.example.com' });
  // More than one page of history (20 per page), one minute apart so the order is fixed.
  let incident = '';
  const first = Date.now() - 60 * 60_000;
  for (let i = 0; i < 21; i++) {
    const startedAt = new Date(first + i * 60_000).toISOString();
    incident = (await admin.post('/api/admin/incidents', { title: `Incident ${i}`, message: 'Investigating.', startedAt })).json()
      .data.id;
  }
  const services = (await t.app.inject({ method: 'GET', url: '/api/public/services' })).json().data as {
    id: string;
    attributes: { slug: string };
  }[];
  ids = { slug: services.find((s) => s.id === service)!.attributes.slug, group, service, incident };
});
afterEach(() => t.close());

const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers });

async function page(url: string) {
  const res = await get(url);
  expect(res.statusCode, url).toBe(200);
  return { body: res.body, root: rootOf(res) };
}

/** Strips <noscript> wrappers: what a browser without JavaScript parses. */
const withoutScript = (html: string) => html.replace(/<\/?noscript>/g, '');

/**
 * Nothing in the markup needs JavaScript: every button submits a form (or is
 * disabled until hydration), every link has a target, every field belongs to a
 * form with an action, every disclosure has a summary, and nothing that is not
 * a control takes a tab stop.
 */
function expectWorksWithoutScript(html: string, url: string) {
  const markup = withoutScript(html);
  const forms = [...markup.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map((m) => m[0]);
  const inForms = forms.join('\n');
  for (const f of forms) {
    const attrs = elements(f, 'form')[0]!;
    expect(attrs.action, `${url}: form action`).toMatch(/^\//);
    expect(['get', 'post'], `${url}: form method`).toContain(attrs.method);
  }
  const outside = forms.reduce((html, f) => html.replace(f, ''), markup);
  for (const button of elements(outside, 'button')) {
    expect(button.disabled !== undefined, `${url}: button outside a form ${JSON.stringify(button)}`).toBe(true);
  }
  for (const button of elements(inForms, 'button')) {
    expect(button.type === 'submit' || button.disabled !== undefined, `${url}: button ${JSON.stringify(button)}`).toBe(true);
  }
  for (const tag of ['input', 'select', 'textarea']) {
    expect(elements(outside, tag), `${url}: ${tag} outside a form`).toEqual([]);
  }
  for (const a of elements(markup, 'a')) expect(a.href, `${url}: link without href`).toBeTruthy();
  expect(elements(markup, 'details').length, `${url}: details`).toBe(elements(markup, 'summary').length);
  for (const el of [...elements(markup, 'div'), ...elements(markup, 'span'), ...elements(markup, 'g')]) {
    expect(el.tabindex === undefined || el.tabindex === '-1', `${url}: tab stop on ${JSON.stringify(el)}`).toBe(true);
  }
  expect(markup, url).not.toMatch(/\son[a-z]+=/i);
}

describe('public pages without JavaScript', () => {
  it('none of them needs a script', async () => {
    const sub = await subscriber();
    for (const url of [
      '/',
      '/?upcoming=all',
      '/services',
      '/services?q=api&status=operational',
      `/services/${ids.slug}`,
      '/locations',
      '/history',
      '/history?type=incident&page=2',
      `/incidents/${ids.incident}`,
      '/subscribe',
      '/subscribe?sent=1',
      `/subscription/confirm?id=${sub.id}&token=${sub.confirm}`,
      `/subscription/manage?id=${sub.id}&token=${sub.manage}`,
      `/subscription/manage?id=${sub.id}&token=${sub.manage}&unsubscribe=1`,
      '/subscription/manage?unsubscribed=1',
      '/subscription/manage?error=invalid',
    ]) {
      const { root } = await page(url);
      expectWorksWithoutScript(root, url);
    }
  });

  it('header: the theme is a form, the language links set it and come back', async () => {
    const { root, body } = await page('/history?type=incident');
    const theme = formHtml(root, '/preferences/theme')!;
    expect(elements(theme, 'form')[0]).toMatchObject({ method: 'post' });
    expect(elements(theme, 'input')).toEqual([{ type: 'hidden', name: 'return', value: '/history?type=incident' }]);
    expect(elements(theme, 'button').map((b) => [b.type, b.name, b.value])).toEqual([
      ['submit', 'theme', 'system'],
      ['submit', 'theme', 'light'],
      ['submit', 'theme', 'dark'],
    ]);
    const language = elements(root, 'a').filter((a) => a.hreflang);
    expect(language.map((a) => a.href)).toEqual([
      '/preferences/language?lang=en&return=%2Fhistory%3Ftype%3Dincident',
      '/preferences/language?lang=de&return=%2Fhistory%3Ftype%3Dincident',
    ]);
    expect(language.every((a) => a.rel === 'nofollow')).toBe(true);
    // Search engines get the page in every language (the unfiltered one: a filtered list is not indexed).
    const plain = (await page('/history')).body;
    expect(body).toContain('<meta name="robots" content="noindex, follow" data-osp-head>');
    expect(plain).toContain(`<link rel="alternate" hreflang="de" href="${BASE_URL}/history?lang=de" data-osp-head>`);
    expect(plain).toContain(`<link rel="alternate" hreflang="x-default" href="${BASE_URL}/history" data-osp-head>`);
    // The configured accent color is in the head, before the stylesheet.
    expect(body).toMatch(/<style>html:root\{--accent:#7c6cf2;[^<]*<\/style>[\s\S]*rel="stylesheet"/);
  });

  it('header on personal pages: the language is a form post, the token is in no URL', async () => {
    const sub = await subscriber();
    const url = `/subscription/manage?id=${sub.id}&token=${sub.manage}`;
    const { root } = await page(url);
    const language = formHtml(root, '/preferences/language')!;
    expect(elements(language, 'form')[0]).toMatchObject({ method: 'post' });
    expect(elements(language, 'input')).toEqual([{ type: 'hidden', name: 'return', value: url }]);
    expect(elements(language, 'button').map((b) => [b.type, b.name, b.value])).toEqual([
      ['submit', 'lang', 'en'],
      ['submit', 'lang', 'de'],
    ]);
    // Only the page's own links (unsubscribe step) carry it.
    for (const a of elements(root, 'a').filter((a) => !a.href?.startsWith('/subscription/'))) {
      expect(a.href ?? '', a.href).not.toContain(sub.manage);
    }
  });

  it('a theme chosen without JavaScript is rendered by the server', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/preferences/theme',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      payload: 'theme=dark&return=%2Fservices',
    });
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    const next = await get(res.headers.location as string, { cookie });
    expect(next.body).toContain('<html lang="en" dir="ltr" data-theme="dark">');
    expect(elements(rootOf(next), 'button').find((b) => b.value === 'dark')).toMatchObject({ 'aria-pressed': 'true' });
  });

  it('overview: the subscribe menu and the service groups are disclosures', async () => {
    const { root } = await page('/');
    expect(root).toMatch(/<details[^>]*><summary[^>]*>[\s\S]*Subscribe to updates[\s\S]*href="\/subscribe"[\s\S]*href="\/feed.rss"/);
    // A group collapsed by default is a closed disclosure with the group name as heading outside it.
    const group = /<section class="[^"]*osp-group[\s\S]*?<\/section>/.exec(root)![0];
    expect(group).toMatch(/<h3[^>]*>[\s\S]*Platform/);
    expect(elements(group, 'details')[0]).not.toHaveProperty('open');
    expect(group).toContain('Public API');
  });

  it('services: the search is a GET form, the counters are links, the server filters', async () => {
    const { root } = await page('/services?q=web');
    const search = formHtml(root, '/services')!;
    expect(elements(search, 'form')[0]).toMatchObject({ method: 'get', role: 'search' });
    expect(elements(search, 'input').find((i) => i.name === 'q')).toMatchObject({ type: 'search', value: 'web' });
    expect(withoutScript(search)).toMatch(/<button type="submit"/);
    expect(root).toContain('Website');
    expect(root).not.toContain('Public API');
    const counters = elements(root, 'a').filter((a) => (a.href ?? '').includes('status='));
    expect(counters.map((a) => a.href)).toEqual(
      ['operational', 'degraded', 'offline', 'maintenance'].map((s) => `/services?q=web&status=${s}`),
    );
    const filtered = await page('/services?status=operational');
    const current = elements(filtered.root, 'a').filter((a) => a['aria-current'] === 'true' && !a.hreflang);
    expect(current).toEqual([expect.objectContaining({ href: '/services' })]);
  });

  it('history: the filters are a GET form, the pages are links', async () => {
    const { root } = await page('/history?type=incident');
    const filters = formHtml(root, '/history')!;
    expect(elements(filters, 'form')[0]).toMatchObject({ method: 'get' });
    expect(elements(filters, 'select').map((s) => s.name)).toEqual(['type', 'service', 'location', 'month']);
    expect(elements(filters, 'option').find((o) => o.value === 'incident')).toHaveProperty('selected');
    expect(withoutScript(filters)).toMatch(/<button type="submit"[^>]*>[\s\S]*Apply filters/);
    expect(elements(root, 'a').find((a) => a.rel === 'next')).toMatchObject({ href: '/history?type=incident&page=2' });
    const second = await page('/history?type=incident&page=2');
    expect(elements(second.root, 'a').find((a) => a.rel === 'prev')).toMatchObject({ href: '/history?type=incident' });
    expect(second.root).toContain('Incident 0');
  });

  it('service detail: every day of the uptime bar is in a table', async () => {
    const { root } = await page(`/services/${ids.slug}`);
    expect(root).toMatch(/<details[^>]*><summary[^>]*>Show every day<\/summary>[\s\S]*<table/);
    expect(root).toMatch(/<th scope="row"[^>]*>\d{4}-\d{2}-\d{2}<\/th>/);
  });

  it('locations: the map is rendered on the server', async () => {
    const { root } = await page('/locations');
    expect(root).toMatch(/role="img" aria-label="World map with 1 location"/);
    expect(root).toContain('url(/world-map.svg)');
    expect(root).toMatch(/<g transform="translate\([\d.]+ [\d.]+\)">/);
  });

  it('subscribe: a form with the names of the form handler', async () => {
    const { root } = await page('/subscribe');
    const form = formHtml(root, '/subscribe')!;
    expect(elements(form, 'form')[0]).toMatchObject({ method: 'post' });
    const inputs = elements(form, 'input');
    expect(inputs.find((i) => i.name === 'email')).toMatchObject({ type: 'email', autocomplete: 'email' });
    expect(inputs.filter((i) => i.name === 'scope').map((i) => i.value)).toEqual(['all', 'selected']);
    expect(inputs.find((i) => i.name === 'group')).toMatchObject({ type: 'checkbox', value: ids.group });
    expect(inputs.find((i) => i.name === 'service' && i.value === ids.service)).toMatchObject({ type: 'checkbox' });
    expect(inputs.find((i) => i.name === 'website')).toMatchObject({ tabindex: '-1' });
    expect(elements(form, 'select').map((s) => s.name)).toEqual(['locale']);
  });

  it('confirm: one click posts the link token', async () => {
    const sub = await subscriber();
    const { root } = await page(`/subscription/confirm?id=${sub.id}&token=${sub.confirm}`);
    const form = formHtml(root, '/subscription/confirm')!;
    expect(elements(form, 'form')[0]).toMatchObject({ method: 'post' });
    expect(elements(form, 'input')).toEqual([
      { type: 'hidden', name: 'id', value: sub.id },
      { type: 'hidden', name: 'token', value: sub.confirm },
    ]);
  });

  it('manage: the preferences form, and unsubscribing in two steps', async () => {
    const sub = await subscriber();
    const url = `/subscription/manage?id=${sub.id}&token=${sub.manage}`;
    const res = await get(url);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const root = rootOf(res);
    const form = formHtml(root, '/subscription/manage')!;
    expect(elements(form, 'input').filter((i) => i.type === 'hidden')).toEqual([
      { type: 'hidden', name: 'id', value: sub.id },
      { type: 'hidden', name: 'token', value: sub.manage },
    ]);
    expect(root).toContain('jane@example.com');
    const open = elements(root, 'a').find((a) => (a.href ?? '').includes('unsubscribe=1'))!;
    expect(open.href).toBe(`${url}&unsubscribe=1#unsubscribe`);
    const step = await page(open.href!.split('#')[0]!);
    const confirm = formHtml(step.root, '/subscription/unsubscribe')!;
    expect(elements(confirm, 'form')[0]).toMatchObject({ method: 'post' });
    expect(elements(confirm, 'input').map((i) => i.name)).toEqual(['id', 'token']);
    expect(elements(confirm, 'a')[0]).toMatchObject({ href: url });
  });

  it('a manage link with a wrong token renders the invalid link state', async () => {
    const sub = await subscriber();
    const { root } = await page(`/subscription/manage?id=${sub.id}&token=${sub.confirm}`);
    expect(root).toContain('This link is invalid or has expired');
    expect(root).not.toContain('jane@example.com');
  });
});

async function subscriber() {
  const res = await t.app.inject({
    method: 'POST',
    url: '/subscribe',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    payload: 'email=jane%40example.com&scope=all',
  });
  expect(res.statusCode).toBe(303);
  await t.app.ctx.worker.idle();
  const row = await t.db.selectFrom('subscribers').selectAll().where('email', '=', 'jane@example.com').executeTakeFirstOrThrow();
  return { id: row.id, ...subscriberTokens(t.config, row) };
}
