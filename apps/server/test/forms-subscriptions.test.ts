/**
 * The email subscription as plain HTML forms (no JavaScript): every handler on
 * success (303 to the outcome), invalid input (the page itself with values and
 * errors), cross-site posts (403) and its rate limit.
 */
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryMailer } from '../src/mail/mailer.js';
import { subscriberTokens } from '../src/services/subscriptions.js';
import { adminClient, createTestApp, type Client, type TestApp } from './helpers.js';
import { createWebDir, elements, formHtml, renderFromSource, rootOf } from './web-fixture.js';

let web: ReturnType<typeof createWebDir>;
beforeAll(() => {
  web = createWebDir();
});
afterAll(() => web.remove());

let t: TestApp;
let admin: Client;
let mailer: MemoryMailer;
let groupId: string;
let groupServices: string[];
let looseService: string;
let hiddenService: string;
let ip = 0;

beforeEach(async () => {
  mailer = new MemoryMailer();
  t = await createTestApp({}, { mailer, web: { dir: web.dir, ssrModule: renderFromSource } });
  admin = await adminClient(t);
  await admin.patch('/api/admin/settings', { siteName: 'Example Status', emailSubscriptionsEnabled: true });
  groupId = (await admin.post('/api/admin/service-groups', { name: 'Platform' })).json().data.id;
  groupServices = [
    (await admin.post('/api/admin/services', { name: 'Public API', groupId })).json().data.id,
    (await admin.post('/api/admin/services', { name: 'Dashboard', groupId })).json().data.id,
  ];
  looseService = (await admin.post('/api/admin/services', { name: 'Website' })).json().data.id;
  hiddenService = (await admin.post('/api/admin/services', { name: 'Hidden backend', isPublic: false })).json().data.id;
});
afterEach(() => t.close());

const FORM = 'application/x-www-form-urlencoded';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

type Fields = [string, string][];

/** Posts a form like a browser of this site; every call from another address unless given (rate limits). */
async function post(url: string, fields: Fields, options: { headers?: Record<string, string>; ip?: string } = {}) {
  const res = await t.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': FORM, ...(options.headers ?? SAME_ORIGIN) },
    payload: new URLSearchParams(fields).toString(),
    remoteAddress: options.ip ?? `198.51.100.${++ip % 250}`,
  });
  await t.app.ctx.worker.idle();
  return res;
}

const subscribers = () => t.db.selectFrom('subscribers').selectAll().execute();

async function subscriberWithTokens(email = 'jane@example.com', fields: Fields = []) {
  expect((await post('/subscribe', [['email', email], ['locale', 'en'], ['scope', 'all'], ...fields])).statusCode).toBe(303);
  const row = (await subscribers()).find((s) => s.email === email)!;
  return { id: row.id, ...subscriberTokens(t.config, row) };
}

const serviceIdsOf = async (id: string) =>
  (await t.db.selectFrom('subscriber_services').select('service_id').where('subscriber_id', '=', id).execute())
    .map((r) => r.service_id)
    .sort();

/** A page answering a form: HTML, never stored, and the answer of the form handler (not a redirect). */
function expectFormPage(res: LightMyRequestResponse, status: number) {
  expect(res.statusCode).toBe(status);
  expect(res.headers['content-type']).toContain('text/html');
  expect(res.headers['cache-control']).toBe('private, no-store');
  return rootOf(res);
}

describe('POST /subscribe', () => {
  it('subscribes and redirects to the confirmation notice (303)', async () => {
    const res = await post('/subscribe', [
      ['email', ' Jane@Example.com '],
      ['locale', 'de'],
      ['scope', 'selected'],
      ['service', looseService],
      ['group', groupId],
    ]);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/subscribe?sent=1');
    expect(res.headers['cache-control']).toBe('no-store');
    const [row] = await subscribers();
    expect(row).toMatchObject({ email: 'jane@example.com', locale: 'de', all_services: 0 });
    // The group checkbox stands for all public services of the group.
    expect(await serviceIdsOf(row!.id)).toEqual([...groupServices, looseService].sort());
    await t.app.ctx.notifications.deliverDue();
    expect(mailer.sent).toHaveLength(1);

    // The page the redirect leads to tells to check the inbox, without the address.
    const page = await t.app.inject({ method: 'GET', url: res.headers.location as string });
    expect(page.statusCode).toBe(200);
    expect(rootOf(page)).toContain('Check your inbox');
    expect(rootOf(page)).not.toContain('jane@example.com');
  });

  it('answers invalid input with the form: values, error summary, field errors', async () => {
    const res = await post('/subscribe', [
      ['email', 'not-an-email'],
      ['locale', 'de'],
      ['scope', 'selected'],
    ]);
    const root = expectFormPage(res, 422);
    expect(await subscribers()).toHaveLength(0);
    expect(res.body).toMatch(/<title>Error: Email notifications/);
    const form = formHtml(root, '/subscribe')!;
    expect(form).not.toBeNull();
    const email = elements(form, 'input').find((i) => i.name === 'email')!;
    expect(email).toMatchObject({ value: 'not-an-email', 'aria-invalid': 'true' });
    expect(form).toContain(`id="${email['aria-describedby']}"`);
    // The error summary links to the fields.
    expect(form).toMatch(/role="alert"[\s\S]*href="#subscription-email"[\s\S]*href="#subscription-scope"/);
    expect(elements(form, 'fieldset')[0]).toMatchObject({ id: 'subscription-scope', 'aria-invalid': 'true' });
    expect(elements(form, 'input').find((i) => i.name === 'scope' && i.value === 'selected')).toHaveProperty('checked');
    expect(elements(form, 'option').find((o) => o.value === 'de')).toHaveProperty('selected');
  });

  it('rejects hidden or unknown services like the API', async () => {
    const res = await post('/subscribe', [
      ['email', 'jane@example.com'],
      ['scope', 'selected'],
      ['service', hiddenService],
    ]);
    const root = expectFormPage(res, 422);
    expect(root).toContain('no longer available');
    expect(root).not.toContain('Hidden backend');
    expect(await subscribers()).toHaveLength(0);
  });

  it('answers a filled-in honeypot like a subscribe, but subscribes nobody', async () => {
    const res = await post('/subscribe', [
      ['email', 'bot@example.com'],
      ['website', 'https://spam.example'],
    ]);
    expect(res.headers.location).toBe('/subscribe?sent=1');
    expect(await subscribers()).toHaveLength(0);
  });

  it('rejects posts from other sites', async () => {
    for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://evil.example' }]) {
      const res = await post('/subscribe', [['email', 'jane@example.com']], { headers });
      expect(res.statusCode).toBe(403);
    }
    expect(await subscribers()).toHaveLength(0);
  });

  it('has the rate limit of the API and keeps what was entered', async () => {
    const fields: Fields = [
      ['email', 'jane@example.com'],
      ['scope', 'all'],
    ];
    for (let i = 0; i < 5; i++) expect((await post('/subscribe', fields, { ip: '203.0.113.9' })).statusCode).toBe(303);
    const res = await post('/subscribe', fields, { ip: '203.0.113.9' });
    const root = expectFormPage(res, 429);
    expect(root).toContain('Too many attempts');
    expect(elements(root, 'input').find((i) => i.name === 'email')).toMatchObject({ value: 'jane@example.com' });
  });

  it('sends visitors back to the page when subscriptions are off', async () => {
    await admin.patch('/api/admin/settings', { emailSubscriptionsEnabled: false });
    const res = await post('/subscribe', [['email', 'jane@example.com']]);
    expect(res.headers.location).toBe('/subscribe');
    expect(await subscribers()).toHaveLength(0);
  });
});

describe('POST /subscription/confirm', () => {
  it('confirms and redirects to the manage page with its token', async () => {
    const sub = await subscriberWithTokens();
    const res = await post('/subscription/confirm', [
      ['id', sub.id],
      ['token', sub.confirm],
    ]);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/subscription/manage?id=${sub.id}&token=${sub.manage}&confirmed=1`);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect((await subscribers())[0]!.confirmed_at).not.toBeNull();

    const page = await t.app.inject({ method: 'GET', url: res.headers.location as string });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('private, no-store');
    expect(rootOf(page)).toContain('Your subscription is confirmed');
    expect(rootOf(page)).toContain('jane@example.com');
  });

  it('sends a wrong token to the invalid link page', async () => {
    const sub = await subscriberWithTokens();
    const res = await post('/subscription/confirm', [
      ['id', sub.id],
      ['token', sub.manage],
    ]);
    expect(res.headers.location).toBe('/subscription/confirm?error=invalid');
    expect((await subscribers())[0]!.confirmed_at).toBeNull();
    const page = await t.app.inject({ method: 'GET', url: '/subscription/confirm?error=invalid' });
    expect(rootOf(page)).toContain('This link is invalid or has expired');
  });

  it('rejects posts from other sites', async () => {
    const sub = await subscriberWithTokens();
    const res = await post(
      '/subscription/confirm',
      [
        ['id', sub.id],
        ['token', sub.confirm],
      ],
      { headers: { 'sec-fetch-site': 'cross-site' } },
    );
    expect(res.statusCode).toBe(403);
    expect((await subscribers())[0]!.confirmed_at).toBeNull();
  });
});

describe('POST /subscription/manage', () => {
  it('saves the preferences and redirects back with a notice', async () => {
    const sub = await subscriberWithTokens();
    const res = await post('/subscription/manage', [
      ['id', sub.id],
      ['token', sub.manage],
      ['locale', 'de'],
      ['scope', 'selected'],
      ['service', looseService],
    ]);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/subscription/manage?id=${sub.id}&token=${sub.manage}&saved=1`);
    expect((await subscribers())[0]).toMatchObject({ locale: 'de', all_services: 0 });
    expect(await serviceIdsOf(sub.id)).toEqual([looseService]);
    const page = await t.app.inject({ method: 'GET', url: res.headers.location as string });
    // The page language is the visitor's, not the subscription's.
    expect(rootOf(page)).toContain('Preferences saved.');
  });

  it('answers invalid input with the form and its errors', async () => {
    const sub = await subscriberWithTokens();
    const res = await post('/subscription/manage', [
      ['id', sub.id],
      ['token', sub.manage],
      ['locale', 'en'],
      ['scope', 'selected'],
    ]);
    const root = expectFormPage(res, 422);
    const form = formHtml(root, '/subscription/manage')!;
    expect(elements(form, 'input').find((i) => i.name === 'token')).toMatchObject({ type: 'hidden', value: sub.manage });
    expect(form).toContain('Select at least one service.');
    expect(elements(form, 'fieldset')[0]).toMatchObject({ 'aria-invalid': 'true' });
    expect((await subscribers())[0]).toMatchObject({ all_services: 1 });
  });

  it('sends a wrong token to the invalid link page without looking at the input', async () => {
    const sub = await subscriberWithTokens();
    const res = await post('/subscription/manage', [
      ['id', sub.id],
      ['token', sub.confirm],
      ['scope', 'selected'],
    ]);
    expect(res.headers.location).toBe('/subscription/manage?error=invalid');
  });

  it('rejects posts from other sites', async () => {
    const sub = await subscriberWithTokens();
    const res = await post(
      '/subscription/manage',
      [
        ['id', sub.id],
        ['token', sub.manage],
        ['locale', 'de'],
      ],
      { headers: { origin: 'https://evil.example' } },
    );
    expect(res.statusCode).toBe(403);
    expect((await subscribers())[0]).toMatchObject({ locale: 'en' });
  });

  it('has the rate limit of the API', async () => {
    const sub = await subscriberWithTokens();
    const fields: Fields = [
      ['id', sub.id],
      ['token', sub.manage],
      ['scope', 'all'],
    ];
    for (let i = 0; i < 30; i++) expect((await post('/subscription/manage', fields, { ip: '203.0.113.7' })).statusCode).toBe(303);
    const res = await post('/subscription/manage', fields, { ip: '203.0.113.7' });
    const root = expectFormPage(res, 429);
    expect(root).toContain('Too many attempts');
    expect(formHtml(root, '/subscription/manage')).not.toBeNull();
  });
});

describe('POST /subscription/unsubscribe', () => {
  it('deletes the subscription and shows the outcome', async () => {
    const sub = await subscriberWithTokens();
    const res = await post('/subscription/unsubscribe', [
      ['id', sub.id],
      ['token', sub.manage],
    ]);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/subscription/manage?unsubscribed=1');
    expect(await subscribers()).toHaveLength(0);
    const page = await t.app.inject({ method: 'GET', url: '/subscription/manage?unsubscribed=1' });
    expect(rootOf(page)).toContain('You have been unsubscribed');
  });

  it('sends a wrong token to the invalid link page', async () => {
    const sub = await subscriberWithTokens();
    const res = await post('/subscription/unsubscribe', [
      ['id', sub.id],
      ['token', 'x'.repeat(43)],
    ]);
    expect(res.headers.location).toBe('/subscription/manage?error=invalid');
    expect(await subscribers()).toHaveLength(1);
  });

  it('rejects posts from other sites', async () => {
    const sub = await subscriberWithTokens();
    const res = await post(
      '/subscription/unsubscribe',
      [
        ['id', sub.id],
        ['token', sub.manage],
      ],
      { headers: { 'sec-fetch-site': 'same-site' } },
    );
    expect(res.statusCode).toBe(403);
    expect(await subscribers()).toHaveLength(1);
  });

  it('has the rate limit of the API', async () => {
    const fields: Fields = [
      ['id', 'unknown'],
      ['token', 'x'.repeat(43)],
    ];
    for (let i = 0; i < 30; i++) await post('/subscription/unsubscribe', fields, { ip: '203.0.113.8' });
    expect((await post('/subscription/unsubscribe', fields, { ip: '203.0.113.8' })).statusCode).toBe(429);
  });
});

describe('without the rendering bundle', () => {
  it('answers invalid input with a redirect and an error code', async () => {
    await t.close();
    t = await createTestApp({}, { mailer, web: { dir: web.dir, ssrModule: () => Promise.reject(new Error('no bundle')) } });
    admin = await adminClient(t);
    await admin.patch('/api/admin/settings', { emailSubscriptionsEnabled: true });
    const res = await post('/subscribe', [['email', 'nope']]);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/subscribe?error=invalid');
  });
});
