/**
 * Webhook and SMS subscriptions as plain HTML forms (no JavaScript): subscribe,
 * enter the code, manage and unsubscribe, with the pages rendered on the server.
 */
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SafeResponse } from '../src/lib/safe-http.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { channelCode } from '../src/services/channels/subscriptions.js';
import { adminClient, createTestApp, type Client, type TestApp } from './helpers.js';
import { createWebDir, elements, formHtml, renderFromSource, rootOf } from './web-fixture.js';

let web: ReturnType<typeof createWebDir>;
beforeAll(() => {
  web = createWebDir();
});
afterAll(() => web.remove());

let t: TestApp;
let admin: Client;
let service: string;
let ip = 0;
const sent: string[] = [];

beforeEach(async () => {
  t = await createTestApp({}, { mailer: new MemoryMailer(), web: { dir: web.dir, ssrModule: renderFromSource } });
  admin = await adminClient(t);
  await admin.patch('/api/admin/settings', { siteName: 'Example Status' });
  service = (await admin.post('/api/admin/services', { name: 'Public API' })).json().data.id;
  await admin.patch('/api/admin/channel-settings', { webhookSubscriptions: true, smsCallingCodes: ['49'] });
  const preset = (await admin.get('/api/admin/sms-presets')).json().data.find((p: { id: string }) => p.id === 'seven').attributes;
  await admin.patch('/api/admin/sms-provider', { ...preset, enabled: true, password: 'key' });
  sent.length = 0;
  t.app.ctx.channels!.request = async (_url, init = {}): Promise<SafeResponse> => {
    sent.push(init.body ?? '');
    return { status: 200, body: '', address: '203.0.113.1' };
  };
});
afterEach(() => t.close());

const FORM = 'application/x-www-form-urlencoded';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

async function post(url: string, fields: [string, string][], headers: Record<string, string> = SAME_ORIGIN) {
  const res = await t.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': FORM, ...headers },
    payload: new URLSearchParams(fields).toString(),
    remoteAddress: `198.51.100.${++ip % 250}`,
  });
  await t.app.ctx.worker.idle();
  return res;
}

function formPage(res: LightMyRequestResponse, status: number) {
  expect(res.statusCode).toBe(status);
  expect(res.headers['cache-control']).toBe('private, no-store');
  return rootOf(res);
}

async function codeFor(reference: string) {
  const row = await t.db.selectFrom('channel_subscribers').select('token_salt').where('target_hash', '=', reference).executeTakeFirstOrThrow();
  return channelCode(t.config.SUBSCRIPTION_TOKEN_KEY, row.token_salt);
}

describe('webhook subscription without JavaScript', () => {
  it('renders the subscribe page with a plain form', async () => {
    const page = await t.app.inject('/subscribe/webhook');
    expect(page.statusCode).toBe(200);
    const form = formHtml(rootOf(page), '/subscribe/webhook')!;
    expect(form).not.toBeNull();
    expect(elements(form, 'input').filter((i) => i.name === 'kind').map((i) => i.value)).toEqual(['discord', 'slack', 'teams']);
    expect(elements(form, 'input').find((i) => i.name === 'url')).toMatchObject({ type: 'url' });
  });

  it('subscribes, confirms with the code, saves preferences and unsubscribes', async () => {
    const res = await post('/subscribe/webhook', [
      ['kind', 'discord'],
      ['url', 'https://discord.com/api/webhooks/1/form-token'],
      ['locale', 'de'],
      ['scope', 'selected'],
      ['service', service],
    ]);
    expect(res.statusCode).toBe(303);
    const location = new URL(res.headers.location as string, 'https://status.example.com');
    expect(location.pathname).toBe('/subscription/verify');
    expect(location.searchParams.get('channel')).toBe('webhook');
    const ref = location.searchParams.get('ref')!;

    // The code page is a plain form too.
    const verifyPage = await t.app.inject(location.pathname + location.search);
    const verifyForm = formHtml(rootOf(verifyPage), '/subscription/verify')!;
    expect(elements(verifyForm, 'input').find((i) => i.name === 'ref')?.value).toBe(ref);
    expect(elements(verifyForm, 'input').find((i) => i.name === 'code')).toMatchObject({ autocomplete: 'one-time-code' });

    await t.app.ctx.channels!.deliverDue();
    const code = await codeFor(ref);
    expect(sent[0]).toContain(code);

    // A wrong code: the page again, with the error at the field.
    const wrong = await post('/subscription/verify', [['ref', ref], ['code', code === '000000' ? '111111' : '000000'], ['channel', 'webhook']]);
    const wrongRoot = formPage(wrong, 422);
    expect(wrongRoot).toContain('wrong or has expired');
    expect(elements(formHtml(wrongRoot, '/subscription/verify')!, 'input').find((i) => i.name === 'code')).toMatchObject({ 'aria-invalid': 'true' });

    const ok = await post('/subscription/verify', [['ref', ref], ['code', code.slice(0, 3) + ' ' + code.slice(3)], ['channel', 'webhook']]);
    expect(ok.statusCode).toBe(303);
    const manage = new URL(ok.headers.location as string, 'https://status.example.com');
    expect(manage.pathname).toBe('/subscription/channel');
    expect(manage.searchParams.get('confirmed')).toBe('1');
    const id = manage.searchParams.get('id')!;
    const token = manage.searchParams.get('token')!;

    const managePage = await t.app.inject(manage.pathname + manage.search);
    expect(managePage.statusCode).toBe(200);
    expect(managePage.headers['cache-control']).toBe('private, no-store');
    const root = rootOf(managePage);
    expect(root).toContain('discord.com/…');
    expect(root).not.toContain('form-token');
    expect(formHtml(root, '/subscription/channel/unsubscribe')).not.toBeNull();

    const saved = await post('/subscription/channel', [['id', id], ['token', token], ['locale', 'en'], ['scope', 'all']]);
    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toContain('saved=1');
    const row = await t.db.selectFrom('channel_subscribers').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ locale: 'en', all_services: 1 });

    const gone = await post('/subscription/channel/unsubscribe', [['id', id], ['token', token]]);
    expect(gone.statusCode).toBe(303);
    expect(gone.headers.location).toBe('/subscription/channel?unsubscribed=1');
    expect(await t.db.selectFrom('channel_subscribers').selectAll().execute()).toEqual([]);
  });

  it('answers an invalid URL with the form and the field error', async () => {
    const res = await post('/subscribe/webhook', [
      ['kind', 'slack'],
      ['url', 'https://example.com/services/T/B/X'],
      ['scope', 'all'],
    ]);
    const root = formPage(res, 422);
    const form = formHtml(root, '/subscribe/webhook')!;
    expect(elements(form, 'input').find((i) => i.name === 'url')).toMatchObject({ value: 'https://example.com/services/T/B/X', 'aria-invalid': 'true' });
    expect(form).toContain('not a webhook URL of the chosen service');
    expect(await t.db.selectFrom('channel_subscribers').selectAll().execute()).toEqual([]);
  });

  it('rejects cross-site posts', async () => {
    const res = await post('/subscribe/webhook', [['kind', 'discord'], ['url', 'https://discord.com/api/webhooks/1/x']], { 'sec-fetch-site': 'cross-site' });
    expect(res.statusCode).toBe(403);
  });
});

describe('SMS subscription without JavaScript', () => {
  it('validates the number and the country', async () => {
    const res = await post('/subscribe/sms', [['phone', '+44 7700 900123'], ['scope', 'all']]);
    const root = formPage(res, 422);
    expect(root).toContain('Numbers from this country cannot subscribe here.');
    const ok = await post('/subscribe/sms', [['phone', '+49 151 2345678'], ['scope', 'all']]);
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toMatch(/^\/subscription\/verify\?ref=[\w-]{43}&channel=sms$/);
  });
});
