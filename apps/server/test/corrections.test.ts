import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { runMaintenanceTransitions } from '../src/services/maintenance-scheduler.js';
import { MemoryMailer, type MailMessage } from '../src/mail/mailer.js';
import { adminClient, client, createTestApp, createUser, data, login, page, type Client, type TestApp } from './helpers.js';

/** Plain object of a public service response (uptime, status). */
type PublicServiceBody = { status: string; uptimePercent: number | null; uptime: { status: string; minutes: Record<string, number>; corrected?: boolean }[] };

const HOUR = 3600_000;
const DAY = 24 * HOUR;

let t: TestApp;
let mailer: MemoryMailer;
let admin: Client;
let api: string;
let web: string;
let hidden: string;

/** Fixed per test, so seeded segments and corrections share exact boundaries. */
let anchor = Date.now();
const iso = (msAgo: number) => new Date(anchor - msAgo).toISOString();
const get = (url: string) => t.app.inject({ method: 'GET', url });

/** Replaces a service's measured history: operational for 3 days with a 2 h outage ending 22 h ago. */
async function seedOutage(serviceId: string) {
  await t.db.deleteFrom('service_status_history').where('service_id', '=', serviceId).execute();
  const rows = [
    { status: 'operational' as const, started_at: iso(3 * DAY), ended_at: iso(24 * HOUR) },
    { status: 'major_outage' as const, started_at: iso(24 * HOUR), ended_at: iso(22 * HOUR) },
    { status: 'operational' as const, started_at: iso(22 * HOUR), ended_at: null },
  ];
  for (const r of rows) {
    await t.db.insertInto('service_status_history').values({ id: newId(), service_id: serviceId, ...r }).execute();
  }
}

async function deliver(): Promise<MailMessage[]> {
  const before = mailer.sent.length;
  await t.app.ctx.notifications.deliverDue(new Date());
  return mailer.sent.slice(before);
}

async function publicPercent(serviceId: string): Promise<number | null> {
  const res = await get(`/api/public/services/${serviceId}`);
  expect(res.statusCode).toBe(200);
  return data<PublicServiceBody>(res).uptimePercent;
}

beforeEach(async () => {
  anchor = Date.now();
  mailer = new MemoryMailer();
  t = await createTestApp({}, { mailer });
  admin = await adminClient(t);
  api = (await admin.post('/api/admin/services', { name: 'Public API' })).json().id;
  web = (await admin.post('/api/admin/services', { name: 'Web App' })).json().id;
  hidden = (await admin.post('/api/admin/services', { name: 'Hidden backend', isPublic: false })).json().id;
  await admin.patch('/api/admin/settings', { siteName: 'Example Status', emailSubscriptionsEnabled: true, uptimeDays: 7 });
});
afterEach(async () => {
  await t.close();
});

describe('status corrections', () => {
  const falseAlarm = () => ({
    serviceIds: [api, web],
    startsAt: iso(24 * HOUR),
    endsAt: iso(22 * HOUR),
    status: 'operational',
    reason: 'Monitoring host lost its network (INTERNAL-REASON-42)',
  });

  it('creates, lists, updates and deletes corrections with audit entries', async () => {
    const created = await admin.post('/api/admin/corrections', falseAlarm());
    expect(created.statusCode).toBe(201);
    const c = created.json();
    expect(c).toMatchObject({ status: 'operational', showPublic: false, publicNote: null, createdByName: 'admin' });
    expect(c.services.map((s: { name: string }) => s.name).sort()).toEqual(['Public API', 'Web App']);

    const listed = await admin.get(`/api/admin/corrections?serviceId=${api}`);
    expect(listed.json()).toMatchObject({ total: 1, items: [{ id: c.id }] });
    expect((await admin.get(`/api/admin/corrections?serviceId=${hidden}`)).json().total).toBe(0);
    expect((await admin.get(`/api/admin/corrections?to=${encodeURIComponent(iso(30 * HOUR))}`)).json().total).toBe(0);
    expect((await admin.get(`/api/admin/corrections?from=${encodeURIComponent(iso(23 * HOUR))}`)).json().total).toBe(1);

    const patched = await admin.patch(`/api/admin/corrections/${c.id}`, {
      serviceIds: [api],
      showPublic: true,
      publicNote: 'False alarm of the monitoring.',
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ showPublic: true, publicNote: 'False alarm of the monitoring.' });
    expect(patched.json().services).toEqual([{ id: api, name: 'Public API' }]);

    expect((await admin.delete(`/api/admin/corrections/${c.id}`)).statusCode).toBe(204);
    expect((await admin.get(`/api/admin/corrections/${c.id}`)).statusCode).toBe(404);

    const audit = await t.db
      .selectFrom('audit_log')
      .select(['action', 'entity_id', 'details'])
      .where('entity_type', '=', 'correction')
      .execute();
    expect(audit.map((a) => a.action)).toEqual(['correction.create', 'correction.update', 'correction.delete']);
    expect(audit.every((a) => a.entity_id === c.id)).toBe(true);
    const update = audit[1]!.details;
    const details = typeof update === 'string' ? JSON.parse(update) : update;
    expect(details.before).toMatchObject({ serviceIds: expect.arrayContaining([api, web]), showPublic: false, publicNote: null });
    expect(details.after).toMatchObject({ serviceIds: [api], showPublic: true, publicNote: 'False alarm of the monitoring.' });
  });

  it('validates input', async () => {
    const base = falseAlarm();
    const bad = [
      { ...base, reason: '   ' },
      { ...base, serviceIds: [] },
      { ...base, serviceIds: ['missing'] },
      { ...base, status: 'broken' },
      { ...base, endsAt: base.startsAt },
      { ...base, startsAt: iso(400 * DAY) },
      { ...base, endsAt: new Date(Date.now() + 2 * HOUR).toISOString() },
      { ...base, startsAt: new Date(Date.now() + HOUR).toISOString(), endsAt: new Date(Date.now() + 2 * HOUR).toISOString() },
      { ...base, publicNote: 'x'.repeat(501) },
    ];
    for (const body of bad) {
      expect((await admin.post('/api/admin/corrections', body)).statusCode, JSON.stringify(body).slice(0, 120)).toBe(400);
    }
    const created = (await admin.post('/api/admin/corrections', base)).json();
    expect((await admin.patch(`/api/admin/corrections/${created.id}`, { startsAt: base.endsAt })).statusCode).toBe(400);
    expect((await admin.patch(`/api/admin/corrections/missing`, { reason: 'x' })).statusCode).toBe(404);
  });

  it('clamps an end time just after now to now', async () => {
    const res = await admin.post('/api/admin/corrections', {
      ...falseAlarm(),
      endsAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(res.statusCode).toBe(201);
    expect(new Date(res.json().endsAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('allows editors and rejects anonymous requests', async () => {
    await createUser(t.db, { email: 'editor@example.com', role: 'editor' });
    const editor = client(t.app, { cookie: await login(t.app, 'editor@example.com') });
    const created = await editor.post('/api/admin/corrections', falseAlarm());
    expect(created.statusCode).toBe(201);
    expect((await editor.patch(`/api/admin/corrections/${created.json().id}`, { status: 'degraded' })).statusCode).toBe(200);
    expect((await editor.get(`/api/admin/services/${api}/history?from=${encodeURIComponent(iso(DAY))}&to=${encodeURIComponent(iso(0))}`)).statusCode).toBe(200);
    expect((await editor.delete(`/api/admin/corrections/${created.json().id}`)).statusCode).toBe(204);

    const anon = client(t.app, {});
    expect((await anon.get('/api/admin/corrections')).statusCode).toBe(401);
    expect((await anon.post('/api/admin/corrections', falseAlarm())).statusCode).toBe(401);
  });

  it('applies corrections to public uptime and marks public ones without leaking the reason', async () => {
    await seedOutage(api);
    await seedOutage(web);
    const before = await publicPercent(api);
    expect(before).toBeLessThan(100);

    const internal = await admin.post('/api/admin/corrections', { ...falseAlarm(), serviceIds: [web] });
    expect(internal.statusCode).toBe(201);
    const pub = await admin.post('/api/admin/corrections', {
      ...falseAlarm(),
      serviceIds: [api],
      showPublic: true,
      publicNote: 'False alarm of the monitoring.',
    });
    expect(pub.statusCode).toBe(201);

    expect(await publicPercent(api)).toBe(100);
    expect(await publicPercent(web)).toBe(100);

    const summary = await get('/api/public/summary');
    const body = summary.body;
    expect(body).not.toContain('INTERNAL-REASON-42');
    const json = data<{ ungrouped: unknown[]; groups: { services: unknown[] }[] }>(summary);
    const services = [...json.ungrouped, ...json.groups.flatMap((g: { services: unknown[] }) => g.services)] as { id: string; uptime: { corrected?: boolean; correctionNotes?: string[]; uptime: number | null }[] }[];
    const apiDays = services.find((s) => s.id === api)!.uptime;
    const marked = apiDays.filter((d) => d.corrected);
    expect(marked.length).toBeGreaterThanOrEqual(1);
    expect(marked[0]!.correctionNotes).toEqual(['False alarm of the monitoring.']);
    expect(apiDays.every((d) => d.uptime === null || d.uptime === 100)).toBe(true);
    // Not public: corrected data, but no marker.
    expect(services.find((s) => s.id === web)!.uptime.some((d) => d.corrected)).toBe(false);

    const detail = await get(`/api/public/services/${api}`);
    expect(detail.body).not.toContain('INTERNAL-REASON-42');
    expect(data<PublicServiceBody>(detail).uptime.some((d) => d.corrected)).toBe(true);

    // Deleting restores the measured data.
    await admin.delete(`/api/admin/corrections/${pub.json().id}`);
    expect(await publicPercent(api)).toBe(before);
  });

  it('lets a later correction win over an earlier one', async () => {
    await seedOutage(api);
    await admin.post('/api/admin/corrections', { ...falseAlarm(), serviceIds: [api] });
    await admin.post('/api/admin/corrections', { ...falseAlarm(), serviceIds: [api], status: 'major_outage', reason: 'Was real' });
    expect(await publicPercent(api)).toBeLessThan(100);
  });

  it('can record a missed outage', async () => {
    await t.db.deleteFrom('service_status_history').where('service_id', '=', api).execute();
    await t.db
      .insertInto('service_status_history')
      .values({ id: newId(), service_id: api, status: 'operational', started_at: iso(3 * DAY), ended_at: null })
      .execute();
    expect(await publicPercent(api)).toBe(100);
    await admin.post('/api/admin/corrections', { ...falseAlarm(), serviceIds: [api], status: 'major_outage', reason: 'Monitoring was down' });
    expect(await publicPercent(api)).toBeLessThan(100);
  });

  it('compares measured and corrected history for a time range', async () => {
    await seedOutage(api);
    const c = (await admin.post('/api/admin/corrections', { ...falseAlarm(), serviceIds: [api] })).json();
    const from = iso(2 * DAY);
    const to = new Date(Date.now() + HOUR).toISOString();
    const res = await admin.get(`/api/admin/services/${api}/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(res.statusCode).toBe(200);
    const h = res.json();
    expect(h.measured.map((s: { status: string }) => s.status)).toEqual(['operational', 'major_outage', 'operational']);
    expect(h.measured[0].startedAt).toBe(from);
    expect(h.measured[2].endedAt).toBeNull();
    expect(h.corrected).toEqual([
      expect.objectContaining({ status: 'operational', source: 'measured' }),
      expect.objectContaining({ status: 'operational', source: 'correction', sourceId: c.id }),
      expect.objectContaining({ status: 'operational', source: 'measured', endedAt: null }),
    ]);
    expect(h.measuredUptime).toBeLessThan(100);
    expect(h.correctedUptime).toBe(100);
    expect(h.corrections.map((x: { id: string }) => x.id)).toEqual([c.id]);

    const missing = await admin.get(`/api/admin/services/missing/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(missing.statusCode).toBe(404);
    const tooLong = await admin.get(
      `/api/admin/services/${api}/history?from=${encodeURIComponent(iso(400 * DAY))}&to=${encodeURIComponent(to)}`,
    );
    expect(tooLong.statusCode).toBe(400);
  });

  it('unlinks a deleted service and removes corrections left without services', async () => {
    const c = (await admin.post('/api/admin/corrections', falseAlarm())).json();
    const webOnly = (await admin.post('/api/admin/corrections', { ...falseAlarm(), serviceIds: [web] })).json();
    await admin.delete(`/api/admin/services/${web}`);
    expect((await admin.get(`/api/admin/corrections/${c.id}`)).json().services).toEqual([{ id: api, name: 'Public API' }]);
    expect((await admin.get(`/api/admin/corrections/${webOnly.id}`)).statusCode).toBe(404);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('details')
      .where('action', '=', 'service.delete')
      .where('entity_id', '=', web)
      .executeTakeFirstOrThrow();
    expect(String(audit.details)).toContain(webOnly.id);
  });
});

describe('retroactive maintenance', () => {
  async function subscribe() {
    const now = new Date().toISOString();
    await t.db
      .insertInto('subscribers')
      .values({
        id: newId(),
        email: 'all@example.com',
        locale: 'en',
        all_services: 1,
        token_salt: newId(),
        confirmed_at: now,
        confirmation_sent_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  it('creates a past window as completed, without emails, counting as maintenance', async () => {
    await subscribe();
    await seedOutage(api);
    const before = await publicPercent(api);
    const res = await admin.post('/api/admin/maintenances', {
      title: 'Forgotten switch upgrade',
      serviceIds: [api],
      scheduledStart: iso(25 * HOUR),
      scheduledEnd: iso(21 * HOUR),
    });
    expect(res.statusCode).toBe(201);
    const m = res.json();
    expect(m).toMatchObject({
      status: 'completed',
      retroactive: true,
      actualStart: m.scheduledStart,
      actualEnd: m.scheduledEnd,
      reminderSentAt: null,
    });
    expect(m.updates.map((u: { status: string }) => u.status)).toEqual(['completed', 'in_progress']);
    expect(m.updates[0].createdAt).toBe(m.scheduledEnd);

    expect(await deliver()).toHaveLength(0);
    await t.app.ctx.notifications.sendDueReminders();
    expect(await deliver()).toHaveLength(0);

    expect(before).toBeLessThan(100);
    expect(await publicPercent(api)).toBe(100);
    const days = data<PublicServiceBody>(await get(`/api/public/services/${api}`)).uptime;
    expect(days.some((d) => d.status === 'maintenance')).toBe(true);
    // The current status is not affected.
    expect(data<PublicServiceBody>(await get(`/api/public/services/${api}`)).status).toBe('operational');

    // Public history lists it like any other maintenance.
    const history = await get('/api/public/history?filter[type]=maintenance');
    expect(page<{ id: string }>(history).items.map((i) => i.id)).toContain(m.id);

    // Moving the window keeps the actual times in line; deleting removes the correction.
    const moved = await admin.patch(`/api/admin/maintenances/${m.id}`, { scheduledStart: iso(26 * HOUR) });
    expect(moved.json().actualStart).toBe(moved.json().scheduledStart);
    const future = await admin.patch(`/api/admin/maintenances/${m.id}`, { scheduledEnd: new Date(Date.now() + HOUR).toISOString() });
    expect(future.statusCode).toBe(400);
    await admin.delete(`/api/admin/maintenances/${m.id}`);
    expect(await publicPercent(api)).toBe(before);
  });

  it('does not count or list a non-public retroactive maintenance', async () => {
    await seedOutage(api);
    const before = await publicPercent(api);
    expect(before).toBeLessThan(100);
    const m = (
      await admin.post('/api/admin/maintenances', {
        title: 'Internal window',
        isPublic: false,
        serviceIds: [api],
        scheduledStart: iso(25 * HOUR),
        scheduledEnd: iso(21 * HOUR),
      })
    ).json();
    expect(await publicPercent(api)).toBe(before);
    const history = await get('/api/public/history?filter[type]=maintenance');
    expect(history.statusCode).toBe(200);
    expect(history.body).not.toContain(m.id);
  });

  it('starts a partly past window right away and only sends "in progress"', async () => {
    await subscribe();
    await seedOutage(api);
    const res = await admin.post('/api/admin/maintenances', {
      title: 'Running since yesterday',
      serviceIds: [api],
      scheduledStart: iso(25 * HOUR),
      scheduledEnd: new Date(Date.now() + 2 * HOUR).toISOString(),
    });
    const m = res.json();
    expect(m).toMatchObject({ status: 'in_progress', retroactive: true, actualStart: m.scheduledStart });
    expect(m.updates.map((u: { status: string }) => u.status)).toEqual(['in_progress']);
    const mails = await deliver();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain('Running since yesterday: In progress');
    expect(data<PublicServiceBody>(await get(`/api/public/services/${api}`)).status).toBe('maintenance');
    expect(await publicPercent(api)).toBe(100);
  });

  it('completes a running retroactive window silently when its end moves into the past', async () => {
    await subscribe();
    await seedOutage(api);
    const m = (
      await admin.post('/api/admin/maintenances', {
        title: 'Ended earlier',
        serviceIds: [api],
        scheduledStart: iso(25 * HOUR),
        scheduledEnd: new Date(Date.now() + 2 * HOUR).toISOString(),
      })
    ).json();
    await deliver();
    const end = iso(23 * HOUR);
    const res = await admin.patch(`/api/admin/maintenances/${m.id}`, { scheduledEnd: end });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'completed', actualEnd: res.json().scheduledEnd });
    const updates = res.json().updates as { status: string; createdAt: string }[];
    expect(updates.map((u) => u.status).sort()).toEqual(['completed', 'in_progress']);
    expect(updates.find((u) => u.status === 'completed')!.createdAt).toBe(res.json().scheduledEnd);
    await runMaintenanceTransitions(t.db, t.app.ctx.engine, undefined, t.app.ctx.notifications);
    expect(await deliver()).toHaveLength(0);
    // Only 25 h..23 h counts as maintenance: the outage up to 22 h ago still partly counts.
    expect(await publicPercent(api)).toBeLessThan(100);
    expect(data<PublicServiceBody>(await get(`/api/public/services/${api}`)).status).not.toBe('maintenance');
  });

  it('keeps the existing behavior for upcoming windows and windows starting now', async () => {
    await subscribe();
    const upcoming = (
      await admin.post('/api/admin/maintenances', {
        title: 'Upcoming',
        serviceIds: [api],
        scheduledStart: new Date(Date.now() + 48 * HOUR).toISOString(),
        scheduledEnd: new Date(Date.now() + 50 * HOUR).toISOString(),
      })
    ).json();
    expect(upcoming).toMatchObject({ status: 'scheduled', retroactive: false, actualStart: null });
    expect((await deliver())[0]!.subject).toContain('Scheduled maintenance: Upcoming');

    const now = (
      await admin.post('/api/admin/maintenances', {
        title: 'Now',
        serviceIds: [web],
        scheduledStart: iso(60_000),
        scheduledEnd: new Date(Date.now() + HOUR).toISOString(),
      })
    ).json();
    expect(now).toMatchObject({ retroactive: false, status: 'in_progress' });
    const mails = await deliver();
    expect(mails.map((x) => x.subject)).toEqual([
      '[Example Status] Scheduled maintenance: Now',
      '[Example Status] Maintenance Now: In progress',
    ]);

    // Without auto start a past start stays scheduled (not retroactive).
    const manual = (
      await admin.post('/api/admin/maintenances', {
        title: 'Manual',
        autoStart: false,
        scheduledStart: iso(2 * HOUR),
        scheduledEnd: new Date(Date.now() + HOUR).toISOString(),
      })
    ).json();
    expect(manual).toMatchObject({ status: 'scheduled', retroactive: false });
  });
});
