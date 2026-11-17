import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { MemoryMailer, type MailMessage } from '../src/mail/mailer.js';
import { runMaintenanceTransitions } from '../src/services/maintenance-scheduler.js';
import { MAX_ATTEMPTS } from '../src/services/notifications.js';
import { subscriptionToken } from '../src/services/subscriptions.js';
import {
  adminClient,
  BASE_URL,
  client,
  createTestApp,
  createUser,
  login,
  type Client,
  type TestApp,
} from './helpers.js';

const HOUR = 3600_000;

let t: TestApp;
let mailer: MemoryMailer;
let admin: Client;
let api: string;
let web: string;
let hidden: string;

beforeEach(async () => {
  mailer = new MemoryMailer();
  t = await createTestApp({}, { mailer });
  admin = await adminClient(t);
  api = (await admin.post('/api/admin/services', { name: 'Public API' })).json().id;
  web = (await admin.post('/api/admin/services', { name: 'Web App' })).json().id;
  hidden = (await admin.post('/api/admin/services', { name: 'Hidden backend', isPublic: false })).json().id;
  await settings({});
});
afterEach(async () => {
  await t.close();
});

async function settings(extra: object) {
  const res = await admin.put('/api/admin/settings', {
    siteName: 'Example Status',
    emailSubscriptionsEnabled: true,
    ...extra,
  });
  expect(res.statusCode).toBe(200);
}

async function addSubscriber(
  email: string,
  opts: { services?: string[]; confirmed?: boolean; locale?: 'en' | 'de'; createdAt?: string } = {},
): Promise<string> {
  const id = newId();
  const now = opts.createdAt ?? new Date().toISOString();
  await t.db
    .insertInto('subscribers')
    .values({
      id,
      email,
      locale: opts.locale ?? 'en',
      all_services: opts.services ? 0 : 1,
      token_salt: newId(),
      confirmed_at: opts.confirmed === false ? null : now,
      confirmation_sent_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  for (const service_id of opts.services ?? []) {
    await t.db.insertInto('subscriber_services').values({ subscriber_id: id, service_id }).execute();
  }
  return id;
}

async function deliver(now = new Date()): Promise<MailMessage[]> {
  const before = mailer.sent.length;
  await t.app.ctx.notifications.deliverDue(now);
  return mailer.sent.slice(before);
}

const recipients = (mails: MailMessage[]) => mails.map((m) => m.to).sort();

async function seedSubscribers() {
  await addSubscriber('all@example.com');
  await addSubscriber('api@example.com', { services: [api] });
  await addSubscriber('web@example.com', { services: [web] });
  await addSubscriber('hidden@example.com', { services: [hidden] });
  await addSubscriber('pending@example.com', { confirmed: false });
}

describe('incident notifications', () => {
  it('selects recipients by affected public services', async () => {
    await seedSubscribers();
    const created = await admin.post('/api/admin/incidents', {
      title: 'Elevated error rates',
      impact: 'major',
      message: 'We are investigating.',
      affectedServices: [
        { serviceId: api, status: 'partial_outage' },
        { serviceId: hidden, status: 'major_outage' },
      ],
    });
    expect(created.statusCode).toBe(201);
    const mails = await deliver();
    expect(recipients(mails)).toEqual(['all@example.com', 'api@example.com']);

    const mail = mails[0]!;
    expect(mail.subject).toBe('[Example Status] Incident: Elevated error rates');
    expect(mail.text).toContain('Public API');
    expect(mail.text).toContain('We are investigating.');
    expect(mail.text).toContain(`${BASE_URL}/incidents/${created.json().id}`);
    for (const body of [mail.text, mail.html]) {
      expect(body).not.toContain('Hidden backend');
      expect(body).toContain('/subscription/manage?id=');
    }

    // Unsubscribe headers (RFC 8058) carry the manage token of the recipient.
    const sub = await t.db.selectFrom('subscribers').selectAll().where('email', '=', mail.to).executeTakeFirstOrThrow();
    const token = subscriptionToken(t.config.SECRET_KEY, 'manage', sub.id, sub.token_salt);
    expect(mail.headers).toMatchObject({
      'List-Unsubscribe': `<${BASE_URL}/api/public/subscriptions/${sub.id}/unsubscribe?token=${token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'Auto-Submitted': 'auto-generated',
    });

    // Update moves to another service.
    await admin.post(`/api/admin/incidents/${created.json().id}/updates`, {
      status: 'identified',
      message: 'Root cause found.',
      affectedServices: [{ serviceId: web, status: 'degraded' }],
    });
    const updates = await deliver();
    expect(recipients(updates)).toEqual(['all@example.com', 'web@example.com']);
    expect(updates[0]!.subject).toBe('[Example Status] Elevated error rates: Identified');
    expect(updates[0]!.text).toContain('Root cause found.');
  });

  it('reaches only "all services" subscribers when no public service is affected', async () => {
    await seedSubscribers();
    await admin.post('/api/admin/incidents', {
      title: 'Backend issue',
      message: 'x',
      affectedServices: [{ serviceId: hidden, status: 'degraded' }],
    });
    expect(recipients(await deliver())).toEqual(['all@example.com']);
  });

  it('never notifies about private incidents or with notify=false', async () => {
    await seedSubscribers();
    const priv = await admin.post('/api/admin/incidents', { title: 'Private', message: 'x', isPublic: false });
    await admin.post(`/api/admin/incidents/${priv.json().id}/updates`, { status: 'resolved', message: 'done' });
    const quiet = await admin.post('/api/admin/incidents', { title: 'Quiet', message: 'x', notify: false });
    await admin.post(`/api/admin/incidents/${quiet.json().id}/updates`, {
      status: 'resolved',
      message: 'done',
      notify: false,
    });
    expect(await deliver()).toHaveLength(0);
    expect(await t.db.selectFrom('email_outbox').selectAll().execute()).toHaveLength(0);

    // A notifying update of the quiet incident does send.
    await admin.post(`/api/admin/incidents/${quiet.json().id}/updates`, { status: 'monitoring', message: 'again' });
    expect(recipients(await deliver())).toEqual(['all@example.com']);
  });

  it('sends nothing when subscriptions are disabled', async () => {
    await seedSubscribers();
    await settings({ emailSubscriptionsEnabled: false });
    await admin.post('/api/admin/incidents', { title: 'Outage', message: 'x' });
    expect(await t.db.selectFrom('email_outbox').selectAll().execute()).toHaveLength(0);
  });

  it('localizes mails by subscriber locale', async () => {
    await addSubscriber('de@example.com', { locale: 'de' });
    await admin.post('/api/admin/incidents', { title: 'Ausfall', impact: 'critical', message: 'Wir prüfen.' });
    const [mail] = await deliver();
    expect(mail!.subject).toBe('[Example Status] Störung: Ausfall');
    expect(mail!.text).toContain('Auswirkung: Kritisch');
    expect(mail!.text).toContain('Abonnement verwalten');
    expect(mail!.html).toContain('<html lang="de">');
  });
});

describe('maintenance notifications', () => {
  const window = (startInHours: number, hours = 2) => ({
    scheduledStart: new Date(Date.now() + startInHours * HOUR).toISOString(),
    scheduledEnd: new Date(Date.now() + (startInHours + hours) * HOUR).toISOString(),
  });

  it('announces, notifies about automatic transitions and respects the stored flag', async () => {
    await seedSubscribers();
    const created = await admin.post('/api/admin/maintenances', {
      title: 'Database upgrade',
      description: 'Short interruptions may occur.',
      serviceIds: [web, hidden],
      ...window(48),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ notify: true, reminderSentAt: null });
    const id = created.json().id;

    const announced = await deliver();
    expect(recipients(announced)).toEqual(['all@example.com', 'web@example.com']);
    expect(announced[0]!.subject).toBe('[Example Status] Scheduled maintenance: Database upgrade');
    expect(announced[0]!.text).toMatch(/Scheduled window: .+ – .+ UTC/);
    expect(announced[0]!.text).toContain('Short interruptions may occur.');
    expect(announced[0]!.text).toContain(`${BASE_URL}/maintenance/${id}`);
    expect(announced[0]!.text).not.toContain('Hidden backend');

    const { db, engine, notifications } = t.app.ctx;
    await runMaintenanceTransitions(db, engine, new Date(Date.now() + 49 * HOUR).toISOString(), notifications);
    const started = await deliver();
    expect(started).toHaveLength(2);
    expect(started[0]!.subject).toBe('[Example Status] Maintenance Database upgrade: In progress');
    expect(started[0]!.text).toContain('The maintenance has started.');

    await runMaintenanceTransitions(db, engine, new Date(Date.now() + 51 * HOUR).toISOString(), notifications);
    const completed = await deliver();
    expect(completed[0]!.text).toContain('The maintenance has been completed.');

    // Stored flag off: no announcement, no automatic notifications.
    const quiet = await admin.post('/api/admin/maintenances', { title: 'Quiet', notify: false, ...window(48) });
    expect(quiet.json().notify).toBe(false);
    await runMaintenanceTransitions(db, engine, new Date(Date.now() + 49 * HOUR).toISOString(), notifications);
    expect(await deliver()).toHaveLength(0);
    // A manual update with notify (form checkbox) still sends.
    await admin.post(`/api/admin/maintenances/${quiet.json().id}/updates`, { status: 'in_progress', message: 'Still busy.' });
    expect((await deliver())[0]!.text).toContain('Still busy.');
    // PATCH notify updates the stored flag.
    const patched = await admin.patch(`/api/admin/maintenances/${quiet.json().id}`, { notify: true });
    expect(patched.json().notify).toBe(true);
    await runMaintenanceTransitions(db, engine, new Date(Date.now() + 51 * HOUR).toISOString(), notifications);
    expect((await deliver())[0]!.subject).toContain('Quiet: Completed');
  });

  it('sends only the completion for a window that was missed entirely', async () => {
    await addSubscriber('all@example.com');
    await admin.post('/api/admin/maintenances', { title: 'Missed', ...window(1) });
    await deliver();
    const { db, engine, notifications } = t.app.ctx;
    await runMaintenanceTransitions(db, engine, new Date(Date.now() + 5 * HOUR).toISOString(), notifications);
    const mails = await deliver();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe('[Example Status] Maintenance Missed: Completed');
  });

  it('never notifies about private maintenance', async () => {
    await addSubscriber('all@example.com');
    const m = await admin.post('/api/admin/maintenances', { title: 'Private', isPublic: false, ...window(1) });
    await admin.post(`/api/admin/maintenances/${m.json().id}/updates`, { status: 'in_progress', message: 'x' });
    const { db, engine, notifications } = t.app.ctx;
    await runMaintenanceTransitions(db, engine, new Date(Date.now() + 5 * HOUR).toISOString(), notifications);
    expect(await t.db.selectFrom('email_outbox').selectAll().execute()).toHaveLength(0);
  });

  it('reminds once before the window, not for windows created inside the reminder period', async () => {
    await addSubscriber('all@example.com');
    const { notifications } = t.app.ctx;
    const created = await admin.post('/api/admin/maintenances', { title: 'Upgrade', ...window(72) });
    const id = created.json().id;
    const late = await admin.post('/api/admin/maintenances', { title: 'Short notice', ...window(12) });
    await deliver();

    // 12 h before "Upgrade" (24 h reminder period by default).
    const now = new Date(Date.now() + 60 * HOUR);
    expect(await notifications.sendDueReminders(now)).toBe(1);
    const [reminder] = await deliver();
    expect(reminder!.subject).toBe('[Example Status] Reminder: maintenance Upgrade');
    expect(reminder!.text).toContain('This maintenance starts on');
    expect(await notifications.sendDueReminders(now)).toBe(0);
    expect((await admin.get(`/api/admin/maintenances/${id}`)).json().reminderSentAt).toEqual(expect.any(String));
    expect((await admin.get(`/api/admin/maintenances/${late.json().id}`)).json().reminderSentAt).toBeNull();

    // Moving the window later resets the reminder.
    const moved = await admin.patch(`/api/admin/maintenances/${id}`, window(120));
    expect(moved.json().reminderSentAt).toBeNull();
    expect(await notifications.sendDueReminders(now)).toBe(0);
    expect(await notifications.sendDueReminders(new Date(Date.now() + 100 * HOUR))).toBe(1);

    // Moving earlier keeps it.
    const earlier = await admin.patch(`/api/admin/maintenances/${id}`, window(110));
    expect(earlier.json().reminderSentAt).toEqual(expect.any(String));
  });

  it('does not remind when disabled or without notify flag', async () => {
    await addSubscriber('all@example.com');
    const { notifications } = t.app.ctx;
    await admin.post('/api/admin/maintenances', { title: 'Upgrade', ...window(72) });
    await admin.post('/api/admin/maintenances', { title: 'Quiet', notify: false, ...window(72) });
    const now = new Date(Date.now() + 60 * HOUR);
    await settings({ maintenanceReminderHours: 0 });
    expect(await notifications.sendDueReminders(now)).toBe(0);
    await settings({ maintenanceReminderHours: 24 });
    expect(await notifications.sendDueReminders(now)).toBe(1);
  });
});

describe('outbox delivery', () => {
  it('retries with backoff, marks failed after the last attempt and can be retried', async () => {
    await addSubscriber('all@example.com');
    await admin.post('/api/admin/incidents', { title: 'Outage', message: 'x' });
    mailer.failNext = MAX_ATTEMPTS;
    const { notifications } = t.app.ctx;

    let now = Date.now();
    const row = () => t.db.selectFrom('email_outbox').selectAll().executeTakeFirstOrThrow();
    const expectedWaits = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
    for (const wait of expectedWaits) {
      const r = await notifications.deliverDue(new Date(now));
      expect(r).toEqual({ sent: 0, retried: 1, failed: 0 });
      const current = await row();
      expect(current.status).toBe('pending');
      expect(new Date(current.next_attempt_at).getTime()).toBe(now + wait);
      // Not due before the backoff has passed.
      expect((await notifications.deliverDue(new Date(now + wait - 1000))).retried).toBe(0);
      now += wait;
    }
    expect(await notifications.deliverDue(new Date(now))).toEqual({ sent: 0, retried: 0, failed: 1 });
    expect(await row()).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, last_error: '550 simulated delivery failure' });

    const status = (await admin.get('/api/admin/notifications/status')).json();
    expect(status.queue).toEqual({ pending: 0, failed: 1 });
    expect(status.lastError).toMatchObject({ message: '550 simulated delivery failure' });

    const retry = await admin.post('/api/admin/notifications/retry-failed');
    expect(retry.json()).toEqual({ requeued: 1 });
    expect(await deliver()).toHaveLength(1);
    expect(await row()).toMatchObject({ status: 'sent', last_error: null });
    const after = (await admin.get('/api/admin/notifications/status')).json();
    expect(after.queue).toEqual({ pending: 0, failed: 0 });
    expect(after.lastSentAt).toEqual(expect.any(String));
  });

  it('drops queued mails of deleted subscribers', async () => {
    const id = await addSubscriber('all@example.com');
    await admin.post('/api/admin/incidents', { title: 'Outage', message: 'x' });
    expect(await t.db.selectFrom('email_outbox').selectAll().execute()).toHaveLength(1);
    expect((await admin.delete(`/api/admin/subscribers/${id}`)).statusCode).toBe(204);
    expect(await t.db.selectFrom('email_outbox').selectAll().execute()).toHaveLength(0);
    expect(await deliver()).toHaveLength(0);
  });

  it('purges old mails and expired unconfirmed subscriptions', async () => {
    const days = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
    await addSubscriber('old-pending@example.com', { confirmed: false, createdAt: days(8) });
    const resent = await addSubscriber('resent@example.com', { confirmed: false, createdAt: days(8) });
    await t.db.updateTable('subscribers').set({ confirmation_sent_at: days(1) }).where('id', '=', resent).execute();
    await addSubscriber('new-pending@example.com', { confirmed: false, createdAt: days(2) });
    await addSubscriber('old-confirmed@example.com', { createdAt: days(400) });

    const outbox = (status: 'sent' | 'failed' | 'pending', createdAt: string) => ({
      id: newId(),
      subscriber_id: null,
      recipient: 'x@example.com',
      kind: 'incident',
      subject: 's',
      text_body: 't',
      html_body: 'h',
      headers: null,
      status,
      attempts: 1,
      next_attempt_at: createdAt,
      last_error: null,
      last_attempt_at: null,
      created_at: createdAt,
      sent_at: status === 'sent' ? createdAt : null,
    });
    await t.db
      .insertInto('email_outbox')
      .values([outbox('sent', days(31)), outbox('failed', days(31)), outbox('sent', days(5)), outbox('pending', days(31))])
      .execute();

    expect(await t.app.ctx.notifications.purge()).toEqual({ mails: 2, subscribers: 1 });
    const left = await t.db.selectFrom('subscribers').select('email').orderBy('email').execute();
    expect(left.map((s) => s.email)).toEqual(['new-pending@example.com', 'old-confirmed@example.com', 'resent@example.com']);
    expect(await t.db.selectFrom('email_outbox').selectAll().execute()).toHaveLength(2);
  });

  it('keeps mails pending without transport', async () => {
    const none = await createTestApp();
    try {
      await none.db
        .insertInto('email_outbox')
        .values({
          id: newId(),
          subscriber_id: null,
          recipient: 'x@example.com',
          kind: 'incident',
          subject: 's',
          text_body: 't',
          html_body: 'h',
          headers: null,
          status: 'pending',
          attempts: 0,
          next_attempt_at: new Date().toISOString(),
          last_error: null,
          last_attempt_at: null,
          created_at: new Date().toISOString(),
          sent_at: null,
        })
        .execute();
      expect(await none.app.ctx.notifications.deliverDue()).toEqual({ sent: 0, retried: 0, failed: 0 });
      expect((await none.db.selectFrom('email_outbox').select('attempts').executeTakeFirstOrThrow()).attempts).toBe(0);
    } finally {
      await none.close();
    }
  });
});

describe('admin endpoints', () => {
  it('lists, filters and deletes subscribers (admin only)', async () => {
    await addSubscriber('jane@example.com', { services: [api, hidden] });
    await addSubscriber('john_doe@example.com', { confirmed: false });
    await addSubscriber('johnxdoe@example.com');

    const list = (await admin.get('/api/admin/subscribers')).json();
    expect(list.total).toBe(3);
    const jane = list.items.find((s: { email: string }) => s.email === 'jane@example.com');
    expect(jane).toMatchObject({ allServices: false, confirmed: true, confirmedAt: expect.any(String) });
    expect(jane.services.map((s: { name: string }) => s.name).sort()).toEqual(['Hidden backend', 'Public API']);

    expect((await admin.get('/api/admin/subscribers?status=pending')).json().total).toBe(1);
    expect((await admin.get('/api/admin/subscribers?status=confirmed')).json().total).toBe(2);
    // LIKE wildcards are escaped: "_" only matches itself.
    const search = (await admin.get('/api/admin/subscribers?q=JOHN_')).json();
    expect(search.items.map((s: { email: string }) => s.email)).toEqual(['john_doe@example.com']);
    expect((await admin.get('/api/admin/subscribers?pageSize=1&page=2')).json().items).toHaveLength(1);

    await createUser(t.db, { email: 'editor@example.com', role: 'editor' });
    const editor = client(t.app, { cookie: await login(t.app, 'editor@example.com') });
    expect((await editor.get('/api/admin/subscribers')).statusCode).toBe(403);
    expect((await editor.delete(`/api/admin/subscribers/${jane.id}`)).statusCode).toBe(403);
    expect((await editor.get('/api/admin/notifications/status')).statusCode).toBe(403);
    expect((await editor.post('/api/admin/notifications/test', { to: 'x@example.com' })).statusCode).toBe(403);
    expect((await editor.post('/api/admin/notifications/retry-failed')).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/subscribers' })).statusCode).toBe(401);

    expect((await admin.delete(`/api/admin/subscribers/${jane.id}`)).statusCode).toBe(204);
    expect((await admin.delete(`/api/admin/subscribers/${jane.id}`)).statusCode).toBe(404);
    const audit = await t.db.selectFrom('audit_log').selectAll().where('action', '=', 'subscriber.delete').executeTakeFirstOrThrow();
    expect(audit.entity_id).toBe(jane.id);
    expect(JSON.parse(audit.details!)).toEqual({ email: 'j***@example.com' });
    expect(audit.details).not.toContain('jane@');
  });

  it('reports status and sends test mails immediately', async () => {
    await addSubscriber('a@example.com');
    await addSubscriber('b@example.com', { confirmed: false });
    const status = (await admin.get('/api/admin/notifications/status')).json();
    expect(status).toEqual({
      transport: 'smtp',
      configured: true,
      from: 'Example Status <status@example.com>',
      subscriptionsEnabled: true,
      subscribers: { confirmed: 1, pending: 1 },
      queue: { pending: 0, failed: 0 },
      lastSentAt: null,
      lastError: null,
    });

    const ok = await admin.post('/api/admin/notifications/test', { to: 'ops@example.com' });
    expect(ok.json()).toEqual({ ok: true, message: 'Test email sent' });
    expect(mailer.sent.at(-1)).toMatchObject({ to: 'ops@example.com', subject: '[Example Status] Test email' });
    expect(await t.db.selectFrom('email_outbox').selectAll().execute()).toHaveLength(0);

    mailer.failNext = 1;
    const failed = await admin.post('/api/admin/notifications/test', { to: 'ops@example.com' });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toEqual({ ok: false, message: '550 simulated delivery failure' });
    expect((await admin.post('/api/admin/notifications/test', { to: 'nope' })).statusCode).toBe(400);
    const audits = await t.db.selectFrom('audit_log').select('details').where('action', '=', 'notifications.test').execute();
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.details).join()).not.toContain('ops@');

    const none = await createTestApp();
    try {
      const a = await adminClient(none);
      expect((await a.post('/api/admin/notifications/test', { to: 'ops@example.com' })).statusCode).toBe(409);
      expect((await a.get('/api/admin/notifications/status')).json()).toMatchObject({
        transport: 'none',
        configured: false,
        from: null,
        subscriptionsEnabled: false,
      });
    } finally {
      await none.close();
    }
  });

  it('round-trips the subscription settings', async () => {
    const saved = await admin.put('/api/admin/settings', {
      siteName: 'Example Status',
      emailSubscriptionsEnabled: true,
      maintenanceReminderHours: 6,
    });
    expect(saved.json()).toMatchObject({ emailSubscriptionsEnabled: true, maintenanceReminderHours: 6 });
    expect((await admin.get('/api/admin/settings')).json()).toMatchObject({
      emailSubscriptionsEnabled: true,
      maintenanceReminderHours: 6,
    });
    const defaults = await admin.put('/api/admin/settings', { siteName: 'Example Status' });
    expect(defaults.json()).toMatchObject({ emailSubscriptionsEnabled: false, maintenanceReminderHours: 24 });
    expect((await admin.put('/api/admin/settings', { siteName: 'x', maintenanceReminderHours: 500 })).statusCode).toBe(400);
  });
});
