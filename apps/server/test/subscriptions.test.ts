import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryMailer, type MailMessage } from '../src/mail/mailer.js';
import {
  subscriberTokens,
  subscriptionToken,
  syncSubscriptionTokenHashes,
  tokenHash,
  tokenKeyFingerprint,
  TOKEN_PLACEHOLDERS,
} from '../src/services/subscriptions.js';
import { JSONAPI_MEDIA_TYPE } from '@openstatuspage/shared';
import { adminClient, BASE_URL, createTestApp, data, doc, errors, type Client, type TestApp } from './helpers.js';

const JSONAPI_HEADERS = { 'content-type': JSONAPI_MEDIA_TYPE };

/** Request document of a subscription; serviceIds go to the `services` relationship. */
const subscriptionBody = (values: object, id?: string) =>
  JSON.stringify(doc('subscriptions', values as Record<string, unknown>, { id, relationships: { serviceIds: 'services' } }));

const confirm = (id: string, token: string) =>
  t.app.inject({
    method: 'POST',
    url: `/api/public/subscriptions/${id}/confirm`,
    headers: JSONAPI_HEADERS,
    payload: subscriptionBody({ token }),
  });

type Subscription = { id: string; serviceIds: string[]; manageToken?: string };

const emailSubscriptions = (res: LightMyRequestResponse) => data<{ emailSubscriptions: boolean }>(res).emailSubscriptions;

let t: TestApp;
let mailer: MemoryMailer;
let admin: Client;
let publicService: string;
let otherService: string;
let hiddenService: string;
let ip = 0;

beforeEach(async () => {
  mailer = new MemoryMailer();
  t = await createTestApp({}, { mailer });
  admin = await adminClient(t);
  publicService = (await admin.post('/api/admin/services', { name: 'Public API' })).json().data.id;
  otherService = (await admin.post('/api/admin/services', { name: 'Dashboard' })).json().data.id;
  hiddenService = (await admin.post('/api/admin/services', { name: 'Hidden backend', isPublic: false })).json().data.id;
  await enableSubscriptions();
});
afterEach(async () => {
  await t.close();
});

async function enableSubscriptions(enabled = true) {
  const res = await admin.patch('/api/admin/settings', { siteName: 'Example Status', emailSubscriptionsEnabled: enabled });
  expect(res.statusCode).toBe(200);
}

/** Every call uses another client IP unless given, so the per-IP rate limit does not interfere. */
async function subscribe(payload: object, remoteAddress = `192.0.2.${++ip % 250}`) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/public/subscriptions',
    headers: JSONAPI_HEADERS,
    payload: subscriptionBody(payload),
    remoteAddress,
  });
  // The subscribe work runs after the answer; wait for it so the tests see its effects.
  await t.app.ctx.worker.idle();
  return res;
}

async function deliver(): Promise<MailMessage[]> {
  const before = mailer.sent.length;
  await t.app.ctx.notifications.deliverDue();
  return mailer.sent.slice(before);
}

function linkParams(mail: MailMessage, path: 'confirm' | 'manage') {
  const match = new RegExp(`${BASE_URL}/subscription/${path}\\?id=([^&#\\s]+)#token=([A-Za-z0-9_-]+)`).exec(mail.text);
  if (!match) throw new Error(`no ${path} link in mail:\n${mail.text}`);
  return { id: decodeURIComponent(match[1]!), token: match[2]! };
}

async function subscribeAndConfirm(email: string, extra: object = {}) {
  expect((await subscribe({ email, ...extra })).statusCode).toBe(202);
  const [mail] = await deliver();
  const { id, token } = linkParams(mail!, 'confirm');
  const res = await confirm(id, token);
  expect(res.statusCode).toBe(200);
  return { id, manageToken: data<Subscription>(res).manageToken! };
}

const manage = (method: 'GET' | 'PATCH' | 'DELETE', id: string, token: string, payload?: object) =>
  t.app.inject({
    method,
    url: `/api/public/subscriptions/${id}`,
    headers: { 'x-subscription-token': token, ...(payload ? JSONAPI_HEADERS : {}) },
    ...(payload ? { payload: subscriptionBody(payload, id) } : {}),
  });

describe('subscribe and confirm', () => {
  it('creates a pending subscription and confirms it via the emailed link', async () => {
    const res = await subscribe({ email: 'Jane@Example.com', locale: 'de' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ jsonapi: { version: '1.1' }, meta: { accepted: true } });
    expect(res.headers['content-type']).toBe(JSONAPI_MEDIA_TYPE);
    expect(res.headers['cache-control']).toBe('no-store');

    const row = await t.db.selectFrom('subscribers').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ email: 'jane@example.com', locale: 'de', all_services: 1, confirmed_at: null });
    // Tokens are not stored anywhere in the row.
    const confirmToken = subscriptionToken(t.config.SECRET_KEY, 'confirm', row.id, row.token_salt);
    expect(JSON.stringify(row)).not.toContain(confirmToken);

    const [mail] = await deliver();
    expect(mail!.to).toBe('jane@example.com');
    expect(mail!.subject).toBe('[Example Status] Bitte bestätige dein Abonnement');
    const { id, token } = linkParams(mail!, 'confirm');
    expect(id).toBe(row.id);
    expect(token).toBe(confirmToken);
    expect(mail!.html).toContain(`href="${BASE_URL}/subscription/confirm?id=${id}#token=${token}"`);
    // The token is only in the URL fragment, never in a query string.
    expect(mail!.text).not.toMatch(/[?&]token=/);

    const confirmed = await confirm(id, token);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.headers['cache-control']).toBe('no-store');
    expect(confirmed.json().data).toMatchObject({
      type: 'subscriptions',
      id,
      relationships: { services: { data: [] } },
      links: { self: `/api/public/subscriptions/${id}` },
    });
    const body = data<Subscription>(confirmed);
    expect(body).toEqual({
      id,
      email: 'jane@example.com',
      locale: 'de',
      allServices: true,
      serviceIds: [],
      // An empty to-many relationship resolves to an empty list.
      services: [],
      confirmed: true,
      manageToken: subscriptionToken(t.config.SECRET_KEY, 'manage', row.id, row.token_salt),
    });

    // Idempotent.
    const again = await confirm(id, token);
    expect(again.statusCode).toBe(200);
    expect(data<Subscription>(again).manageToken).toBe(body.manageToken);
  });

  it('answers unknown ids and wrong tokens identically', async () => {
    await subscribe({ email: 'jane@example.com' });
    const row = await t.db.selectFrom('subscribers').select('id').executeTakeFirstOrThrow();
    const token = 'x'.repeat(43);
    const wrong = await confirm(row.id, token);
    const unknown = await confirm('00000000-0000-0000-0000-000000000000', token);
    expect(wrong.statusCode).toBe(404);
    expect(errors(wrong)[0]).toMatchObject({ status: '404', code: 'not_found' });
    expect(unknown.statusCode).toBe(404);
    expect(wrong.body).toBe(unknown.body);
    // The manage token is no confirm token and vice versa.
    const sub = await t.db.selectFrom('subscribers').selectAll().executeTakeFirstOrThrow();
    const manageToken = subscriptionToken(t.config.SECRET_KEY, 'manage', sub.id, sub.token_salt);
    const confirmToken = subscriptionToken(t.config.SECRET_KEY, 'confirm', sub.id, sub.token_salt);
    expect(
      (await confirm(sub.id, manageToken)).statusCode,
    ).toBe(404);
    expect((await manage('GET', sub.id, confirmToken)).statusCode).toBe(404);
    expect((await manage('GET', sub.id, '')).statusCode).toBe(404);
  });

  it('gives identical answers for new, pending and confirmed addresses and throttles mails', async () => {
    const first = await subscribe({ email: 'jane@example.com', allServices: false, serviceIds: [publicService] });
    expect((await deliver()).length).toBe(1);
    // Pending: preferences stay unchanged, the confirmation is not re-sent within 10 minutes.
    const pending = await subscribe({ email: 'jane@example.com', locale: 'de' });
    expect(pending.statusCode).toBe(first.statusCode);
    expect(pending.body).toBe(first.body);
    expect((await deliver()).length).toBe(0);
    const row = await t.db.selectFrom('subscribers').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ all_services: 0, locale: 'en' });

    // After the throttle window the confirmation is sent again, still with the original choice.
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    await t.db.updateTable('subscribers').set({ confirmation_sent_at: old }).execute();
    await subscribe({ email: 'jane@example.com', allServices: false, serviceIds: [otherService] });
    const [resent] = await deliver();
    expect(resent!.text).toContain('/subscription/confirm?');
    expect(resent!.subject).toMatch(/Confirm your subscription/);

    // Confirmed: preferences stay unchanged, a manage mail is sent instead (throttled as well).
    const { id } = linkParams(resent!, 'confirm');
    await confirm(id, linkParams(resent!, 'confirm').token);
    await t.db.updateTable('subscribers').set({ confirmation_sent_at: old }).execute();
    const confirmed = await subscribe({ email: 'jane@example.com', allServices: false, serviceIds: [otherService] });
    expect(confirmed.statusCode).toBe(202);
    expect(confirmed.body).toBe(first.body);
    const [manageMail] = await deliver();
    expect(manageMail!.subject).toBe('[Example Status] Manage your subscription');
    expect(manageMail!.text).toContain('/subscription/manage?');
    await subscribe({ email: 'jane@example.com' });
    expect((await deliver()).length).toBe(0);
    const services = await t.db.selectFrom('subscriber_services').select('service_id').execute();
    expect(services.map((s) => s.service_id)).toEqual([publicService]);
  });

  it('answers before the subscribe work runs, and logs its failures', async () => {
    // The response time must not depend on the address's state, so the answer may not wait for the work.
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const enqueue = vi.spyOn(t.app.ctx.notifications, 'enqueue').mockImplementationOnce(async () => blocked);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/public/subscriptions',
      headers: JSONAPI_HEADERS,
      payload: subscriptionBody({ email: 'jane@example.com' }),
      remoteAddress: '192.0.2.251',
    });
    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    release();
    await t.app.ctx.worker.idle();
    expect(await t.db.selectFrom('subscribers').select('email').execute()).toEqual([{ email: 'jane@example.com' }]);

    // A failing job is logged and does not change the answer.
    const logError = vi.spyOn(t.app.ctx.log, 'error');
    await t.db.schema.dropTable('subscriber_services').execute();
    const failing = await subscribe({ email: 'john@example.com', allServices: false, serviceIds: [publicService] });
    expect(failing.statusCode).toBe(202);
    expect(failing.body).toBe(res.body);
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ task: 'subscribe' }), 'background task failed');
  });

  it('validates input and service ids', async () => {
    expect((await subscribe({ email: 'not-an-email' })).statusCode).toBe(400);
    expect((await subscribe({ email: 'jane@example.com', allServices: false })).statusCode).toBe(400);
    const hidden = await subscribe({ email: 'jane@example.com', allServices: false, serviceIds: [hiddenService] });
    const unknown = await subscribe({ email: 'jane@example.com', allServices: false, serviceIds: ['nope'] });
    expect(hidden.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
    // Hidden services are indistinguishable from unknown ones.
    expect(hidden.body).toBe(unknown.body);
    expect(hidden.body).not.toContain(hiddenService);
    expect(await t.db.selectFrom('subscribers').selectAll().execute()).toHaveLength(0);
  });

  it('answers a filled-in honeypot like a successful subscribe but creates and sends nothing', async () => {
    const real = await subscribe({ email: 'jane@example.com' });
    const bot = await subscribe({ email: 'bot@example.com', website: 'http://spam.example.com' });
    expect(bot.statusCode).toBe(202);
    expect(bot.body).toBe(real.body);
    expect(bot.headers['cache-control']).toBe('no-store');
    const rows = await t.db.selectFrom('subscribers').select('email').execute();
    expect(rows.map((r) => r.email)).toEqual(['jane@example.com']);
    expect(await deliver()).toHaveLength(1);
    // An empty honeypot is a normal subscribe; overlong values are still rejected.
    expect((await subscribe({ email: 'john@example.com', website: '' })).statusCode).toBe(202);
    expect(await t.db.selectFrom('subscribers').selectAll().execute()).toHaveLength(2);
    expect((await subscribe({ email: 'bot@example.com', website: 'x'.repeat(501) })).statusCode).toBe(400);
  });

  it('never stores tokens in the outbox and fills them in when sending', async () => {
    await subscribe({ email: 'jane@example.com' });
    const sub = await t.db.selectFrom('subscribers').selectAll().executeTakeFirstOrThrow();
    const confirmToken = subscriptionToken(t.config.SECRET_KEY, 'confirm', sub.id, sub.token_salt);
    const manageToken = subscriptionToken(t.config.SECRET_KEY, 'manage', sub.id, sub.token_salt);
    const queued = JSON.stringify(await t.db.selectFrom('email_outbox').selectAll().execute());
    expect(queued).not.toContain(confirmToken);
    expect(queued).not.toContain(manageToken);
    expect(queued).toContain(TOKEN_PLACEHOLDERS.confirm);

    const [mail] = await deliver();
    expect(linkParams(mail!, 'confirm').token).toBe(confirmToken);
    expect(mail!.html).toContain(confirmToken);
    expect(mail!.text).not.toContain('__OSP_');
    // Sent rows keep subject and status, but no bodies or headers.
    const sent = await t.db.selectFrom('email_outbox').selectAll().executeTakeFirstOrThrow();
    expect(sent).toMatchObject({ status: 'sent', kind: 'confirm', text_body: '', html_body: '', headers: null });
    expect(sent.subject).toBe(mail!.subject);
  });

  it('is 404 when disabled in the settings or without mail transport', async () => {
    await enableSubscriptions(false);
    expect((await subscribe({ email: 'jane@example.com' })).statusCode).toBe(404);
    expect(emailSubscriptions(await t.app.inject({ method: 'GET', url: '/api/public/summary' }))).toBe(false);

    await enableSubscriptions(true);
    expect(emailSubscriptions(await t.app.inject({ method: 'GET', url: '/api/public/summary' }))).toBe(true);

    const noTransport = await createTestApp();
    try {
      const a = await adminClient(noTransport);
      await a.patch('/api/admin/settings', { siteName: 'Example Status', emailSubscriptionsEnabled: true });
      const res = await noTransport.app.inject({
        method: 'POST',
        url: '/api/public/subscriptions',
        headers: JSONAPI_HEADERS,
        payload: subscriptionBody({ email: 'jane@example.com' }),
      });
      expect(res.statusCode).toBe(404);
      expect(emailSubscriptions(await noTransport.app.inject({ method: 'GET', url: '/api/public/summary' }))).toBe(
        false,
      );
    } finally {
      await noTransport.close();
    }
  });

  it('rate limits subscribe requests per IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await subscribe({ email: `user${i}@example.com` }, '198.51.100.7')).statusCode);
    expect(codes.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(codes[5]).toBe(429);
  });
});

describe('manage and unsubscribe', () => {
  it('reads, updates and deletes with the manage token', async () => {
    const { id, manageToken } = await subscribeAndConfirm('jane@example.com');
    const got = await manage('GET', id, manageToken);
    expect(got.statusCode).toBe(200);
    expect(got.headers['cache-control']).toBe('no-store');
    expect(data(got)).toMatchObject({ id, allServices: true, confirmed: true });
    expect(data(got)).not.toHaveProperty('manageToken');

    const updated = await manage('PATCH', id, manageToken, { locale: 'de', allServices: false, serviceIds: [publicService] });
    expect(updated.statusCode).toBe(200);
    expect(data(updated)).toMatchObject({ locale: 'de', allServices: false, serviceIds: [publicService] });
    // Partial: attributes left out keep their value.
    expect(data(await manage('PATCH', id, manageToken, { locale: 'en' }))).toMatchObject({
      locale: 'en',
      allServices: false,
      serviceIds: [publicService],
    });
    const hidden = await manage('PATCH', id, manageToken, { allServices: false, serviceIds: [hiddenService] });
    expect(hidden.statusCode).toBe(400);
    const empty = await manage('PATCH', id, manageToken, { allServices: false, serviceIds: [] });
    expect(errors(empty)[0]).toMatchObject({ source: { pointer: '/data/relationships/services' } });
    expect((await manage('PATCH', id, 'wrong-token-wrong-token', { allServices: true })).statusCode).toBe(404);

    // A service hidden later is not revealed in the subscription.
    expect((await admin.patch(`/api/admin/services/${publicService}`, { isPublic: false })).statusCode).toBe(
      200,
    );
    expect(data<Subscription>(await manage('GET', id, manageToken)).serviceIds).toEqual([]);

    expect((await manage('DELETE', id, 'wrong-token-wrong-token')).statusCode).toBe(404);
    expect((await manage('DELETE', id, manageToken)).statusCode).toBe(204);
    expect(await t.db.selectFrom('subscribers').selectAll().execute()).toHaveLength(0);
    expect(await t.db.selectFrom('subscriber_services').selectAll().execute()).toHaveLength(0);
    expect((await manage('GET', id, manageToken)).statusCode).toBe(404);
  });

  it('supports RFC 8058 one-click unsubscribe', async () => {
    const { id, manageToken } = await subscribeAndConfirm('jane@example.com');
    const url = `/api/public/subscriptions/${id}/unsubscribe?token=${manageToken}`;

    // A browser GET only redirects to the manage page.
    const get = await t.app.inject({ method: 'GET', url });
    expect(get.statusCode).toBe(303);
    expect(get.headers.location).toBe(`${BASE_URL}/subscription/manage?id=${id}&unsubscribe=1#token=${manageToken}`);
    expect(await t.db.selectFrom('subscribers').selectAll().execute()).toHaveLength(1);

    const wrong = await t.app.inject({
      method: 'POST',
      url: `/api/public/subscriptions/${id}/unsubscribe?token=nope`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(wrong.statusCode).toBe(404);

    const res = await t.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(res.statusCode).toBe(204);
    expect(await t.db.selectFrom('subscribers').selectAll().execute()).toHaveLength(0);

    // Empty body works as well.
    const other = await subscribeAndConfirm('john@example.com');
    const empty = await t.app.inject({
      method: 'POST',
      url: `/api/public/subscriptions/${other.id}/unsubscribe?token=${other.manageToken}`,
    });
    expect(empty.statusCode).toBe(204);
    expect(await t.db.selectFrom('subscribers').selectAll().execute()).toHaveLength(0);
  });

  it('keeps managing and unsubscribing possible when subscriptions get disabled', async () => {
    const { id, manageToken } = await subscribeAndConfirm('jane@example.com');
    await enableSubscriptions(false);
    expect((await manage('GET', id, manageToken)).statusCode).toBe(200);
    expect((await manage('DELETE', id, manageToken)).statusCode).toBe(204);
  });
});

describe('token hashes', () => {
  it('stores the hashes of both tokens, never the tokens', async () => {
    await subscribe({ email: 'jane@example.com' });
    const row = await t.db.selectFrom('subscribers').selectAll().executeTakeFirstOrThrow();
    const tokens = subscriberTokens(t.config, row);
    expect(row).toMatchObject({
      confirm_token_hash: tokenHash(tokens.confirm),
      manage_token_hash: tokenHash(tokens.manage),
      token_key: tokenKeyFingerprint(t.config.SECRET_KEY),
    });
    expect(row.confirm_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(tokens.confirm);
    expect(JSON.stringify(row)).not.toContain(tokens.manage);
  });

  it('fills missing hashes and refreshes hashes of another SECRET_KEY', async () => {
    await subscribe({ email: 'jane@example.com' });
    await subscribe({ email: 'john@example.com' });
    await t.db
      .updateTable('subscribers')
      .set({ confirm_token_hash: null, manage_token_hash: null, token_key: null })
      .where('email', '=', 'jane@example.com')
      .execute();
    expect(await syncSubscriptionTokenHashes(t.db, t.config.SECRET_KEY)).toBe(1);
    expect(await syncSubscriptionTokenHashes(t.db, t.config.SECRET_KEY)).toBe(0);
    const jane = await t.db.selectFrom('subscribers').selectAll().where('email', '=', 'jane@example.com').executeTakeFirstOrThrow();
    expect(jane.manage_token_hash).toBe(tokenHash(subscriberTokens(t.config, jane).manage));

    const rotated = 'another-secret-key-that-is-long-enough-0987654321';
    expect(await syncSubscriptionTokenHashes(t.db, rotated, 1)).toBe(2);
    for (const r of await t.db.selectFrom('subscribers').selectAll().execute()) {
      expect(r.token_key).toBe(tokenKeyFingerprint(rotated));
      expect(r.confirm_token_hash).toBe(tokenHash(subscriptionToken(rotated, 'confirm', r.id, r.token_salt)));
    }
  });
});
