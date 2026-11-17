import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryMailer, type MailMessage } from '../src/mail/mailer.js';
import { subscriptionToken, TOKEN_PLACEHOLDERS } from '../src/services/subscriptions.js';
import { adminClient, BASE_URL, createTestApp, type Client, type TestApp } from './helpers.js';

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
  publicService = (await admin.post('/api/admin/services', { name: 'Public API' })).json().id;
  otherService = (await admin.post('/api/admin/services', { name: 'Dashboard' })).json().id;
  hiddenService = (await admin.post('/api/admin/services', { name: 'Hidden backend', isPublic: false })).json().id;
  await enableSubscriptions();
});
afterEach(async () => {
  await t.close();
});

async function enableSubscriptions(enabled = true) {
  const res = await admin.put('/api/admin/settings', { siteName: 'Example Status', emailSubscriptionsEnabled: enabled });
  expect(res.statusCode).toBe(200);
}

/** Every call uses another client IP unless given, so the per-IP rate limit does not interfere. */
function subscribe(payload: object, remoteAddress = `192.0.2.${++ip % 250}`) {
  return t.app.inject({ method: 'POST', url: '/api/public/subscriptions', payload, remoteAddress });
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
  const res = await t.app.inject({ method: 'POST', url: `/api/public/subscriptions/${id}/confirm`, payload: { token } });
  expect(res.statusCode).toBe(200);
  return { id, manageToken: res.json().manageToken as string };
}

const manage = (method: 'GET' | 'PUT' | 'DELETE', id: string, token: string, payload?: object) =>
  t.app.inject({
    method,
    url: `/api/public/subscriptions/${id}`,
    headers: { 'x-subscription-token': token },
    ...(payload ? { payload } : {}),
  });

describe('subscribe and confirm', () => {
  it('creates a pending subscription and confirms it via the emailed link', async () => {
    const res = await subscribe({ email: 'Jane@Example.com', locale: 'de' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers['cache-control']).toBe('no-store');

    const row = await t.db.selectFrom('subscribers').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ email: 'jane@example.com', locale: 'de', all_services: 1, confirmed_at: null });
    // Tokens are not stored anywhere in the row.
    const confirmToken = subscriptionToken(t.config.SECRET_KEY, 'confirm', row.id, row.token_salt);
    expect(JSON.stringify(row)).not.toContain(confirmToken);

    const [mail] = await deliver();
    expect(mail!.to).toBe('jane@example.com');
    expect(mail!.subject).toBe('[Example Status] Bitte bestätigen Sie Ihr Abonnement');
    const { id, token } = linkParams(mail!, 'confirm');
    expect(id).toBe(row.id);
    expect(token).toBe(confirmToken);
    expect(mail!.html).toContain(`href="${BASE_URL}/subscription/confirm?id=${id}#token=${token}"`);
    // The token is only in the URL fragment, never in a query string.
    expect(mail!.text).not.toMatch(/[?&]token=/);

    const confirmed = await t.app.inject({
      method: 'POST',
      url: `/api/public/subscriptions/${id}/confirm`,
      payload: { token },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.headers['cache-control']).toBe('no-store');
    const body = confirmed.json();
    expect(body.subscription).toEqual({
      id,
      email: 'jane@example.com',
      locale: 'de',
      allServices: true,
      serviceIds: [],
      confirmed: true,
    });
    expect(body.manageToken).toBe(subscriptionToken(t.config.SECRET_KEY, 'manage', row.id, row.token_salt));

    // Idempotent.
    const again = await t.app.inject({ method: 'POST', url: `/api/public/subscriptions/${id}/confirm`, payload: { token } });
    expect(again.statusCode).toBe(200);
    expect(again.json().manageToken).toBe(body.manageToken);
  });

  it('answers unknown ids and wrong tokens identically', async () => {
    await subscribe({ email: 'jane@example.com' });
    const row = await t.db.selectFrom('subscribers').select('id').executeTakeFirstOrThrow();
    const token = 'x'.repeat(43);
    const wrong = await t.app.inject({ method: 'POST', url: `/api/public/subscriptions/${row.id}/confirm`, payload: { token } });
    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/public/subscriptions/00000000-0000-0000-0000-000000000000/confirm',
      payload: { token },
    });
    expect(wrong.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(wrong.body).toBe(unknown.body);
    // The manage token is no confirm token and vice versa.
    const sub = await t.db.selectFrom('subscribers').selectAll().executeTakeFirstOrThrow();
    const manageToken = subscriptionToken(t.config.SECRET_KEY, 'manage', sub.id, sub.token_salt);
    const confirmToken = subscriptionToken(t.config.SECRET_KEY, 'confirm', sub.id, sub.token_salt);
    expect(
      (await t.app.inject({ method: 'POST', url: `/api/public/subscriptions/${sub.id}/confirm`, payload: { token: manageToken } }))
        .statusCode,
    ).toBe(404);
    expect((await manage('GET', sub.id, confirmToken)).statusCode).toBe(404);
    expect((await manage('GET', sub.id, '')).statusCode).toBe(404);
  });

  it('gives identical answers for new, pending and confirmed addresses and throttles mails', async () => {
    const first = await subscribe({ email: 'jane@example.com' });
    expect((await deliver()).length).toBe(1);
    // Pending: preferences are updated, the confirmation is not re-sent within 10 minutes.
    const pending = await subscribe({ email: 'jane@example.com', allServices: false, serviceIds: [publicService] });
    expect(pending.statusCode).toBe(first.statusCode);
    expect(pending.body).toBe(first.body);
    expect((await deliver()).length).toBe(0);
    const row = await t.db.selectFrom('subscribers').selectAll().executeTakeFirstOrThrow();
    expect(row.all_services).toBe(0);

    // After the throttle window the confirmation is sent again.
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    await t.db.updateTable('subscribers').set({ confirmation_sent_at: old }).execute();
    await subscribe({ email: 'jane@example.com', allServices: false, serviceIds: [publicService] });
    const [resent] = await deliver();
    expect(resent!.text).toContain('/subscription/confirm?');

    // Confirmed: preferences stay unchanged, a manage mail is sent instead (throttled as well).
    const { id } = linkParams(resent!, 'confirm');
    await t.app.inject({
      method: 'POST',
      url: `/api/public/subscriptions/${id}/confirm`,
      payload: { token: linkParams(resent!, 'confirm').token },
    });
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
    expect((await t.app.inject({ method: 'GET', url: '/api/public/summary' })).json().emailSubscriptions).toBe(false);

    await enableSubscriptions(true);
    expect((await t.app.inject({ method: 'GET', url: '/api/public/summary' })).json().emailSubscriptions).toBe(true);

    const noTransport = await createTestApp();
    try {
      const a = await adminClient(noTransport);
      await a.put('/api/admin/settings', { siteName: 'Example Status', emailSubscriptionsEnabled: true });
      const res = await noTransport.app.inject({
        method: 'POST',
        url: '/api/public/subscriptions',
        payload: { email: 'jane@example.com' },
      });
      expect(res.statusCode).toBe(404);
      expect((await noTransport.app.inject({ method: 'GET', url: '/api/public/summary' })).json().emailSubscriptions).toBe(
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
    expect(got.json()).toMatchObject({ id, allServices: true, confirmed: true });

    const updated = await manage('PUT', id, manageToken, { locale: 'de', allServices: false, serviceIds: [publicService] });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ locale: 'de', allServices: false, serviceIds: [publicService] });
    expect((await manage('PUT', id, manageToken, { allServices: false, serviceIds: [hiddenService] })).statusCode).toBe(400);
    expect((await manage('PUT', id, 'wrong-token-wrong-token', { allServices: true })).statusCode).toBe(404);

    // A service hidden later is not revealed in the subscription.
    expect((await admin.put(`/api/admin/services/${publicService}`, { name: 'Public API', isPublic: false })).statusCode).toBe(
      200,
    );
    expect((await manage('GET', id, manageToken)).json().serviceIds).toEqual([]);

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
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await t.db.selectFrom('subscribers').selectAll().execute()).toHaveLength(0);

    // Empty body works as well.
    const other = await subscribeAndConfirm('john@example.com');
    const empty = await t.app.inject({
      method: 'POST',
      url: `/api/public/subscriptions/${other.id}/unsubscribe?token=${other.manageToken}`,
    });
    expect(empty.statusCode).toBe(200);
    expect(await t.db.selectFrom('subscribers').selectAll().execute()).toHaveLength(0);
  });

  it('keeps managing and unsubscribing possible when subscriptions get disabled', async () => {
    const { id, manageToken } = await subscribeAndConfirm('jane@example.com');
    await enableSubscriptions(false);
    expect((await manage('GET', id, manageToken)).statusCode).toBe(200);
    expect((await manage('DELETE', id, manageToken)).statusCode).toBe(204);
  });
});
