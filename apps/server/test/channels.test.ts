/**
 * Webhook and SMS notifications: the admin API, fan-out and delivery (with a
 * fake outbound request), and the public subscriptions with their codes.
 */
import { createHmac } from 'node:crypto';
import { JSONAPI_MEDIA_TYPE } from '@openstatuspage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SafeRequestInit, SafeResponse } from '../src/lib/safe-http.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { AUTO_DISABLE_FAILURES } from '../src/services/channels/service.js';
import { channelCode, confirmChannel } from '../src/services/channels/subscriptions.js';
import { adminClient, createTestApp, data, doc, errors, page, type Client, type TestApp } from './helpers.js';

type Sent = { url: string; init: SafeRequestInit; options: { allowHttp?: boolean } };

let t: TestApp;
let admin: Client;
let mailer: MemoryMailer;
let sent: Sent[];
/** Status the fake endpoint answers with. */
let answer: number;
let serviceA: string;
let serviceB: string;
let ip = 0;

const JSONAPI = { 'content-type': JSONAPI_MEDIA_TYPE };

beforeEach(async () => {
  mailer = new MemoryMailer();
  t = await createTestApp({}, { mailer });
  admin = await adminClient(t);
  await admin.patch('/api/admin/settings', { siteName: 'Example Status' });
  serviceA = (await admin.post('/api/admin/services', { name: 'Public API' })).json().data.id;
  serviceB = (await admin.post('/api/admin/services', { name: 'Dashboard' })).json().data.id;
  sent = [];
  answer = 204;
  t.app.ctx.channels.request = async (url, init = {}, options = {}): Promise<SafeResponse> => {
    sent.push({ url, init, options });
    return { status: answer, body: answer >= 400 ? '{"message":"Unknown Webhook"}' : '', address: '203.0.113.1' };
  };
});
afterEach(async () => {
  await t.close();
});

const deliver = () => t.app.ctx.channels.deliverDue();
const bodyOf = (s: Sent) => JSON.parse(s.init.body ?? '{}') as Record<string, unknown>;

async function incident(serviceIds: string[], notify = true) {
  const affectedServices = serviceIds.map((serviceId) => ({ serviceId, status: 'degraded' }));
  const res = await admin.post('/api/admin/incidents', { title: 'API errors', message: 'Looking into it', affectedServices, notify });
  expect(res.statusCode, res.body).toBe(201);
  return data<{ id: string }>(res).id;
}

describe('admin webhooks', () => {
  it('stores the URL write-only and returns the signing secret once', async () => {
    const insecure = await admin.post('/api/admin/webhooks', { name: 'Ops', kind: 'generic', url: 'http://hooks.example.com/x' });
    expect(insecure.statusCode).toBe(400);
    const res = await admin.post('/api/admin/webhooks', {
      name: 'Ops',
      kind: 'generic',
      url: 'https://hooks.example.com/osp?key=secret-value',
      headers: [{ name: 'Authorization', value: 'Bearer header-secret' }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = data<{ id: string; signingSecret: string; host: string; headerNames: string[] }>(res);
    expect(created.signingSecret).toMatch(/^whsec_/);
    expect(created.host).toBe('hooks.example.com');
    expect(created.headerNames).toEqual(['Authorization']);
    const listed = await admin.get('/api/admin/webhooks');
    expect(listed.body).not.toContain('secret-value');
    expect(listed.body).not.toContain('header-secret');
    expect(listed.body).not.toContain(created.signingSecret);
    const stored = await t.db.selectFrom('notification_webhooks').selectAll().executeTakeFirstOrThrow();
    expect(stored.url_enc).not.toContain('hooks.example.com');
    // The audit log never holds the URL or the secret.
    const audit = await t.db.selectFrom('audit_log').select('details').execute();
    expect(JSON.stringify(audit)).not.toContain('secret-value');
  });

  it('signs generic deliveries and sends the custom headers (test button)', async () => {
    const res = await admin.post('/api/admin/webhooks', {
      name: 'Ops',
      kind: 'generic',
      url: 'https://hooks.example.com/osp',
      headers: [{ name: 'X-Team', value: 'ops' }],
    });
    const { id, signingSecret } = data<{ id: string; signingSecret: string }>(res);
    const test = await admin.post(`/api/admin/webhooks/${id}/test`, {});
    expect(test.json().meta).toMatchObject({ ok: true, statusCode: 204 });
    const s = sent[0]!;
    const headers = s.init.headers!;
    expect(headers['x-team']).toBe('ops');
    expect(headers['x-osp-event']).toBe('test');
    const expected = createHmac('sha256', signingSecret).update(`${headers['x-osp-timestamp']}.${s.init.body}`).digest('hex');
    expect(headers['x-osp-signature']).toBe(`v1=${expected}`);
    expect(bodyOf(s)).toMatchObject({ version: 1, event: 'test', site: { name: 'Example Status' } });
    const log = page<{ event: string; status: string; statusCode: number }>(await admin.get(`/api/admin/webhooks/${id}/deliveries`));
    expect(log.items[0]).toMatchObject({ event: 'test', status: 'sent', statusCode: 204 });
  });

  it('notifies on incidents within its scope, with retries and a delivery log', async () => {
    const all = data<{ id: string }>(await admin.post('/api/admin/webhooks', { name: 'All', kind: 'discord', url: 'https://discord.com/api/webhooks/1/abc' })).id;
    const onlyB = data<{ id: string }>(
      await admin.post('/api/admin/webhooks', { name: 'B', kind: 'slack', url: 'https://hooks.slack.com/services/T/B/X', allServices: false, serviceIds: [serviceB] }),
    ).id;
    await incident([serviceA]);
    await incident([serviceA], false);
    answer = 500;
    expect(await deliver()).toMatchObject({ retried: 1 });
    expect(sent.length).toBe(1);
    expect(sent[0]!.url).toBe('https://discord.com/api/webhooks/1/abc');
    expect(bodyOf(sent[0]!)).toMatchObject({ allowed_mentions: { parse: [] }, embeds: [{ title: 'Incident: API errors' }] });
    // Due again after the backoff.
    answer = 204;
    const later = new Date(Date.now() + 2 * 60_000);
    t.app.ctx.channels.clock = () => later;
    expect(await t.app.ctx.channels.deliverDue(later)).toMatchObject({ sent: 1 });
    const log = page<{ status: string; attempts: number }>(await admin.get(`/api/admin/webhooks/${all}/deliveries`));
    expect(log.items[0]).toMatchObject({ status: 'sent', attempts: 2 });
    expect(page(await admin.get(`/api/admin/webhooks/${onlyB}/deliveries`)).items).toEqual([]);
  });

  it('is disabled after repeated failures, with a notice to the admins', async () => {
    const id = data<{ id: string }>(await admin.post('/api/admin/webhooks', { name: 'Gone', kind: 'discord', url: 'https://discord.com/api/webhooks/1/abc' })).id;
    answer = 404;
    for (let i = 0; i < AUTO_DISABLE_FAILURES; i++) await incident([serviceA]);
    await deliver();
    const wh = data<{ enabled: boolean; disabledReason: string; consecutiveFailures: number }>(await admin.get(`/api/admin/webhooks/${id}`));
    expect(wh.enabled).toBe(false);
    expect(wh.disabledReason).toContain('failed deliveries');
    // 404 is not retried.
    expect(sent.length).toBe(AUTO_DISABLE_FAILURES);
    const notice = await t.db.selectFrom('email_outbox').selectAll().where('kind', '=', 'admin_notice').execute();
    expect(notice.map((n) => n.recipient)).toEqual(['admin@example.com']);
    // Enabling it again resets the failures.
    const enabled = data<{ enabled: boolean; disabledReason: string | null; consecutiveFailures: number }>(
      await admin.patch(`/api/admin/webhooks/${id}`, { enabled: true }),
    );
    expect(enabled).toMatchObject({ enabled: true, disabledReason: null, consecutiveFailures: 0 });
  });

  it('formats Teams messages as Adaptive Cards', async () => {
    await admin.post('/api/admin/webhooks', {
      name: 'Teams',
      kind: 'teams',
      url: 'https://prod-1.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=x',
    });
    await incident([serviceA]);
    await deliver();
    expect(bodyOf(sent[0]!)).toMatchObject({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive' }] });
  });
});

describe('SMS provider and on-call recipients', () => {
  async function configureSms(extra: Record<string, unknown> = {}) {
    const preset = (await admin.get('/api/admin/sms-presets')).json().data.find((p: { id: string }) => p.id === 'twilio').attributes;
    const res = await admin.patch('/api/admin/sms-provider', { ...preset, enabled: true, from: '+15005550006', username: 'AC1', password: 'auth-token-secret', ...extra });
    expect(res.statusCode, res.body).toBe(200);
    return res;
  }

  it('keeps the credentials write-only', async () => {
    const res = await configureSms();
    expect(res.body).not.toContain('auth-token-secret');
    expect(data(res)).toMatchObject({ preset: 'twilio', usernameSet: true, passwordSet: true });
    // Left out: kept; null: removed.
    expect(data(await admin.patch('/api/admin/sms-provider', { from: '+15005550007' }))).toMatchObject({ passwordSet: true });
    expect(data(await admin.patch('/api/admin/sms-provider', { password: null }))).toMatchObject({ passwordSet: false });
    const bad = await admin.patch('/api/admin/sms-provider', { url: 'http://sms.example.com/send' });
    expect(bad.statusCode).toBe(400);
  });

  it('sends on-call SMS for incidents in scope', async () => {
    answer = 201;
    await configureSms();
    const bad = await admin.post('/api/admin/sms-recipients', { name: 'On call', phone: '0151 234' });
    expect(bad.statusCode).toBe(400);
    await admin.post('/api/admin/sms-recipients', { name: 'On call', phone: '+49 151 2345678' });
    await admin.post('/api/admin/sms-recipients', { name: 'B only', phone: '+49 151 9999999', allServices: false, serviceIds: [serviceB] });
    await incident([serviceA]);
    await deliver();
    expect(sent.length).toBe(1);
    const form = new URLSearchParams(sent[0]!.init.body);
    expect(form.get('To')).toBe('+491512345678');
    expect(form.get('Body')).toBe('Example Status: Incident: API errors (Investigating)');
    expect(sent[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
  });

  it('tests the provider and counts the SMS', async () => {
    answer = 201;
    await configureSms();
    const res = await admin.post('/api/admin/sms-provider/test', { to: '+491512345678' });
    expect(res.json().meta).toMatchObject({ ok: true, statusCode: 201 });
    expect(data(await admin.get('/api/admin/sms-provider'))).toMatchObject({ sentThisMonth: 1 });
  });
});

/** Every call from another client address (the per-IP limit is tested on its own). */
function subscribe(values: Record<string, unknown>, remoteAddress = `198.51.100.${++ip % 250}`) {
  return t.app
    .inject({
      method: 'POST',
      url: '/api/public/channel-subscriptions',
      headers: JSONAPI,
      remoteAddress,
      payload: JSON.stringify(doc('channel-subscriptions', values, { relationships: { serviceIds: 'services' } })),
    })
    .then(async (res) => {
      await t.app.ctx.worker.idle();
      return res;
    });
}

function confirm(reference: string, code: string) {
  return t.app.inject({
    method: 'POST',
    url: '/api/public/channel-subscriptions/confirm',
    headers: JSONAPI,
    remoteAddress: `198.51.100.${++ip % 250}`,
    payload: JSON.stringify(doc('channel-subscriptions', { reference, code })),
  });
}

async function codeOf(reference: string): Promise<string> {
  const row = await t.db.selectFrom('channel_subscribers').select('token_salt').where('target_hash', '=', reference).executeTakeFirstOrThrow();
  return channelCode(t.config.SUBSCRIPTION_TOKEN_KEY, row.token_salt);
}

describe('webhook subscriptions of visitors', () => {
  const discord = 'https://discord.com/api/webhooks/123/token-abc';

  it('are off by default and offered once enabled', async () => {
    const summary = await t.app.inject('/api/public/summary');
    expect(data<{ channelSubscriptions: unknown }>(summary).channelSubscriptions).toEqual({ webhookKinds: [], sms: false, smsCallingCodes: [] });
    expect((await subscribe({ channel: 'webhook', webhookKind: 'discord', url: discord })).statusCode).toBe(404);
    await admin.patch('/api/admin/channel-settings', { webhookSubscriptions: true });
    const after = data<{ channelSubscriptions: { webhookKinds: string[] } }>(await t.app.inject('/api/public/summary'));
    expect(after.channelSubscriptions.webhookKinds).toEqual(['discord', 'slack', 'teams']);
    // Generic only with its own setting.
    expect((await subscribe({ channel: 'webhook', webhookKind: 'generic', url: 'https://hooks.example.com/x' })).statusCode).toBe(404);
  });

  it('only accept the official hosts of the kind', async () => {
    await admin.patch('/api/admin/channel-settings', { webhookSubscriptions: true });
    const res = await subscribe({ channel: 'webhook', webhookKind: 'discord', url: 'https://evil.example.com/api/webhooks/1/x' });
    expect(res.statusCode).toBe(400);
    expect(errors(res)[0]).toMatchObject({ code: 'webhook_host', source: { pointer: '/data/attributes/url' } });
  });

  it('confirm with the code of the confirmation message', async () => {
    await admin.patch('/api/admin/channel-settings', { webhookSubscriptions: true });
    const res = await subscribe({ channel: 'webhook', webhookKind: 'discord', url: discord, allServices: false, serviceIds: [serviceA] });
    expect(res.statusCode).toBe(202);
    const { reference } = res.json().meta as { reference: string };
    // The answer for a known target looks the same.
    const again = await subscribe({ channel: 'webhook', webhookKind: 'discord', url: discord });
    expect(again.json().meta.reference).toBe(reference);
    await deliver();
    expect(sent.length).toBe(1);
    const code = await codeOf(reference);
    const confirmMsg = JSON.stringify(bodyOf(sent[0]!));
    expect(confirmMsg).toContain(code);
    expect(confirmMsg).toContain('https://status.example.com/s/');
    // Not active yet: no notifications.
    await incident([serviceA]);
    await deliver();
    expect(sent.length).toBe(1);

    const wrong = await confirm(reference, code === '000000' ? '111111' : '000000');
    expect(wrong.statusCode).toBe(404);
    const ok = await confirm(reference, code);
    expect(ok.statusCode, ok.body).toBe(200);
    const sub = data<{ id: string; manageToken: string; confirmed: boolean; target: string; serviceIds: string[] }>(ok);
    expect(sub).toMatchObject({ confirmed: true, target: 'discord.com/…' });
    expect(sub.serviceIds).toEqual([serviceA]);
    // A code works once.
    expect((await confirm(reference, code)).statusCode).toBe(404);

    await incident([serviceA]);
    await incident([serviceB]);
    await deliver();
    expect(sent.length).toBe(2);
    expect(JSON.stringify(bodyOf(sent[1]!))).toContain('/s/');

    // Manage with the token.
    const headers = { ...JSONAPI, 'x-subscription-token': sub.manageToken };
    const got = await t.app.inject({ url: `/api/public/channel-subscriptions/${sub.id}`, headers });
    expect(got.statusCode).toBe(200);
    expect((await t.app.inject({ url: `/api/public/channel-subscriptions/${sub.id}`, headers: { ...JSONAPI, 'x-subscription-token': 'x'.repeat(22) } })).statusCode).toBe(404);
    const patched = await t.app.inject({
      method: 'PATCH',
      url: `/api/public/channel-subscriptions/${sub.id}`,
      headers,
      payload: JSON.stringify(doc('channel-subscriptions', { allServices: true }, { id: sub.id })),
    });
    expect(data<{ allServices: boolean }>(patched).allServices).toBe(true);
    // Short link → manage page.
    const short = await t.app.inject(`/s/${sub.id}/${sub.manageToken}`);
    expect(short.statusCode).toBe(303);
    expect(short.headers.location).toBe(`/subscription/channel?id=${sub.id}&token=${sub.manageToken}`);
    expect((await t.app.inject(`/s/${sub.id}/wrongtokenwrongtoken12`)).headers.location).toBe('/subscription/channel?error=invalid');
    const deleted = await t.app.inject({ method: 'DELETE', url: `/api/public/channel-subscriptions/${sub.id}`, headers: { 'x-subscription-token': sub.manageToken } });
    expect(deleted.statusCode).toBe(204);
    expect(await t.db.selectFrom('channel_subscribers').selectAll().execute()).toEqual([]);
  });

  it('end a code after five wrong attempts', async () => {
    await admin.patch('/api/admin/channel-settings', { webhookSubscriptions: true });
    const { reference } = (await subscribe({ channel: 'webhook', webhookKind: 'slack', url: 'https://hooks.slack.com/services/T/B/X' })).json().meta;
    const code = await codeOf(reference);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await confirm(reference, wrong)).statusCode).toBe(404);
    expect((await confirm(reference, code)).statusCode).toBe(404);
  });

  it('count concurrent wrong codes against the five attempts', async () => {
    await admin.patch('/api/admin/channel-settings', { webhookSubscriptions: true });
    const { reference } = (await subscribe({ channel: 'webhook', webhookKind: 'slack', url: 'https://hooks.slack.com/services/T/B/Y' })).json().meta;
    const code = await codeOf(reference);
    const wrong = code === '000000' ? '111111' : '000000';
    // Straight to the service: requests through inject run one after the other.
    const answers = await Promise.allSettled(Array.from({ length: 8 }, () => confirmChannel(t.app.ctx, reference, wrong)));
    expect(answers.every((a) => a.status === 'rejected')).toBe(true);
    expect((await confirm(reference, code)).statusCode).toBe(404);
    const row = await t.db.selectFrom('channel_subscribers').select('code_attempts').executeTakeFirstOrThrow();
    expect(row.code_attempts).toBe(5);
  });

  it('sign generic subscriber webhooks with the secret shown on the manage page', async () => {
    await admin.patch('/api/admin/channel-settings', { webhookSubscriptions: true, genericWebhookSubscriptions: true });
    const { reference } = (await subscribe({ channel: 'webhook', webhookKind: 'generic', url: 'https://hooks.example.com/in' })).json().meta;
    const sub = data<{ signingSecret: string }>(await confirm(reference, await codeOf(reference)));
    expect(sub.signingSecret).toMatch(/^whsec_/);
    await deliver();
    const s = sent[0]!;
    const h = s.init.headers!;
    expect(h['x-osp-signature']).toBe(`v1=${createHmac('sha256', sub.signingSecret).update(`${h['x-osp-timestamp']}.${s.init.body}`).digest('hex')}`);
    expect(bodyOf(s)).toMatchObject({ event: 'subscription.confirm' });
    // Turning generic subscriptions off stops their deliveries.
    await admin.patch('/api/admin/channel-settings', { genericWebhookSubscriptions: false });
    await incident([serviceA]);
    await deliver();
    expect(sent.length).toBe(1);
  });

  it('are removed after five deliveries the webhook refused', async () => {
    await admin.patch('/api/admin/channel-settings', { webhookSubscriptions: true });
    const { reference } = (await subscribe({ channel: 'webhook', webhookKind: 'discord', url: discord })).json().meta;
    await deliver();
    expect((await confirm(reference, await codeOf(reference))).statusCode).toBe(200);
    answer = 404;
    for (let i = 0; i < 4; i++) {
      await incident([serviceA]);
      await deliver();
    }
    expect(await t.db.selectFrom('channel_subscribers').select('id').execute()).toHaveLength(1);
    await incident([serviceA]);
    await deliver();
    expect(await t.db.selectFrom('channel_subscribers').select('id').execute()).toEqual([]);
  });

  it('are kept when deliveries fail on this side', async () => {
    await admin.patch('/api/admin/channel-settings', { webhookSubscriptions: true });
    const { reference } = (await subscribe({ channel: 'webhook', webhookKind: 'discord', url: discord })).json().meta;
    await deliver();
    await confirm(reference, await codeOf(reference));
    // The server's own network (or the SSRF guard) refuses: not the destination's fault.
    t.app.ctx.channels.request = async () => {
      throw Object.assign(new Error('address not allowed'), { code: 'address' });
    };
    for (let i = 0; i < 6; i++) {
      await incident([serviceA]);
      await deliver();
    }
    expect(await t.db.selectFrom('channel_outbox').select('id').where('status', '=', 'failed').execute()).toHaveLength(6);
    expect(await t.db.selectFrom('channel_subscribers').select('id').execute()).toHaveLength(1);
  });

  it('share the per-client subscribe limit with the email subscriptions', async () => {
    await admin.patch('/api/admin/channel-settings', { webhookSubscriptions: true });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await subscribe({ channel: 'webhook', webhookKind: 'discord', url: `https://discord.com/api/webhooks/${i}/x` }, '192.0.2.77')).statusCode);
    }
    expect(codes).toEqual([202, 202, 202, 202, 202, 429]);
  });
});

describe('SMS subscriptions of visitors', () => {
  async function enableSms(settings: Record<string, unknown> = {}) {
    const preset = (await admin.get('/api/admin/sms-presets')).json().data.find((p: { id: string }) => p.id === 'messagebird').attributes;
    await admin.patch('/api/admin/sms-provider', { ...preset, enabled: true, from: 'Status', password: 'live_key' });
    await admin.patch('/api/admin/channel-settings', { smsCallingCodes: ['49'], ...settings });
  }

  it('are off until countries are allowed', async () => {
    const preset = (await admin.get('/api/admin/sms-presets')).json().data[0].attributes;
    await admin.patch('/api/admin/sms-provider', { ...preset, enabled: true, password: 'x' });
    expect((await subscribe({ channel: 'sms', phone: '+491512345678' })).statusCode).toBe(404);
    await admin.patch('/api/admin/channel-settings', { smsCallingCodes: ['49'] });
    const other = await subscribe({ channel: 'sms', phone: '+44 7700 900123' });
    expect(other.statusCode).toBe(400);
    expect(errors(other)[0]).toMatchObject({ code: 'phone_country' });
    expect(errors(await subscribe({ channel: 'sms', phone: '0151 2345678' }))[0]).toMatchObject({ code: 'phone_format' });
  });

  it('send a short confirmation SMS with code and unsubscribe link', async () => {
    answer = 201;
    await enableSms();
    const res = await subscribe({ channel: 'sms', phone: '+49 151 2345678' });
    expect(res.statusCode).toBe(202);
    const { reference } = res.json().meta;
    await deliver();
    const body = bodyOf(sent[0]!) as { recipients: string[]; body: string };
    expect(body.recipients).toEqual(['491512345678']);
    expect(body.body).toContain(await codeOf(reference));
    expect(body.body).toMatch(/https:\/\/status\.example\.com\/s\/[\w-]{12}\/[\w-]{22}$/);
    expect(body.body.length).toBeLessThanOrEqual(160);
    // Subscribing again within the hour sends nothing more (per number).
    await subscribe({ channel: 'sms', phone: '+491512345678' });
    await deliver();
    expect(sent.length).toBe(1);
  });

  it('pause when the monthly budget is used up and notify the admins', async () => {
    answer = 201;
    await enableSms({ smsMonthlyBudget: 2 });
    const { reference } = (await subscribe({ channel: 'sms', phone: '+491512345678' })).json().meta;
    await deliver();
    await confirm(reference, await codeOf(reference));
    // One more SMS reaches the budget (2), the next subscriber SMS is not sent.
    await admin.post('/api/admin/sms-provider/test', { to: '+491512345679' });
    expect(data<{ channelSubscriptions: { sms: boolean } }>(await t.app.inject('/api/public/summary')).channelSubscriptions.sms).toBe(false);
    await incident([serviceA]);
    const before = sent.length;
    await deliver();
    expect(sent.length).toBe(before);
    // Nothing is queued for the subscriber once the budget is used up.
    const queued = await t.db.selectFrom('channel_outbox').select('id').where('event', '=', 'incident.created').execute();
    expect(queued).toEqual([]);
    const notice = await t.db.selectFrom('email_outbox').select('subject').where('kind', '=', 'admin_notice').execute();
    expect(notice).toEqual([{ subject: 'Monthly SMS budget used up' }]);
    expect((await subscribe({ channel: 'sms', phone: '+491512345670' })).statusCode).toBe(404);
  });

  it('keep their subscribers while the budget is used up', async () => {
    answer = 201;
    await enableSms({ smsMonthlyBudget: 2 });
    const { reference } = (await subscribe({ channel: 'sms', phone: '+491512345678' })).json().meta;
    await deliver();
    await confirm(reference, await codeOf(reference));
    await admin.post('/api/admin/sms-provider/test', { to: '+491512345679' });
    for (let i = 0; i < 7; i++) {
      await incident([serviceA]);
      await deliver();
    }
    expect(await t.db.selectFrom('channel_subscribers').select('id').execute()).toHaveLength(1);
  });

  it('keep their subscribers when the provider refuses the credentials', async () => {
    answer = 201;
    await enableSms();
    const { reference } = (await subscribe({ channel: 'sms', phone: '+491512345678' })).json().meta;
    await deliver();
    await confirm(reference, await codeOf(reference));
    answer = 401;
    for (let i = 0; i < 6; i++) {
      await incident([serviceA]);
      await deliver();
    }
    expect(await t.db.selectFrom('channel_outbox').select('id').where('status_code', '=', 401).execute()).toHaveLength(6);
    expect(await t.db.selectFrom('channel_subscribers').select('id').execute()).toHaveLength(1);
  });

  it('remove a number the provider keeps rejecting while others are sent', async () => {
    answer = 201;
    await enableSms();
    const subscribed: string[] = [];
    for (const phone of ['+491512345678', '+491512345600']) {
      const { reference } = (await subscribe({ channel: 'sms', phone })).json().meta;
      await deliver();
      await confirm(reference, await codeOf(reference));
      subscribed.push(phone.slice(1));
    }
    t.app.ctx.channels.request = async (url, init = {}): Promise<SafeResponse> => {
      sent.push({ url, init, options: {} });
      const rejected = (bodyOf({ url, init, options: {} }) as { recipients: string[] }).recipients[0] === subscribed[0];
      return { status: rejected ? 422 : 201, body: '', address: '203.0.113.1' };
    };
    for (let i = 0; i < 5; i++) {
      await incident([serviceA]);
      await deliver();
    }
    const left = await t.db.selectFrom('channel_subscribers').select('target_hint').execute();
    expect(left).toHaveLength(1);
  });
});

describe('admin subscriber list', () => {
  it('lists and filters every channel', async () => {
    await admin.patch('/api/admin/channel-settings', { webhookSubscriptions: true });
    await subscribe({ channel: 'webhook', webhookKind: 'discord', url: 'https://discord.com/api/webhooks/1/x' });
    const list = page<{ channel: string; target: string; confirmed: boolean }>(await admin.get('/api/admin/channel-subscribers?filter[channel]=webhook'));
    expect(list.items).toEqual([expect.objectContaining({ channel: 'webhook', target: 'discord.com/…', confirmed: false })]);
    expect(page(await admin.get('/api/admin/channel-subscribers?filter[channel]=sms')).items).toEqual([]);
    const id = (list.items[0] as unknown as { id: string }).id;
    expect((await admin.delete(`/api/admin/channel-subscribers/${id}`)).statusCode).toBe(204);
  });
});
