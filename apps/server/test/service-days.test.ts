/**
 * GET /api/public/services/{idOrSlug}/days/{date}: one day of the uptime bar in
 * detail (resource type service-days).
 */
import { deserializeDocument, shiftUptimeDay, uptimeDayOf, type PublicServiceDay } from '@openstatuspage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { daySegments } from '../src/services/service-days.js';
import { adminClient, createTestApp, data, errors, type Client, type TestApp } from './helpers.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let t: TestApp;
let admin: Client;
let api: string;
let apiSlug: string;
let hidden: string;
let correctionId: string;
/** Yesterday (UTC): the day with the outage, a public correction, an incident and a maintenance window. */
let day: string;
let dayStart: number;
let today: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const get = (url: string) => t.app.inject({ method: 'GET', url });
const at = (hours: number) => new Date(dayStart + hours * HOUR).toISOString();

async function insertIncident(id: string, title: string, isPublic: number, startedAt: string, resolvedAt: string | null, serviceId: string) {
  const ts = { created_at: startedAt, updated_at: resolvedAt ?? startedAt };
  await t.db
    .insertInto('incidents')
    .values({
      id,
      title,
      status: resolvedAt ? 'resolved' : 'investigating',
      impact: 'major',
      is_public: isPublic,
      source: 'manual',
      started_at: startedAt,
      resolved_at: resolvedAt,
      created_by: null,
      ...ts,
    })
    .execute();
  await t.db.insertInto('incident_services').values({ incident_id: id, service_id: serviceId, status: 'major_outage' }).execute();
}

async function insertMaintenance(id: string, title: string, isPublic: number, status: 'completed' | 'cancelled', start: string, end: string) {
  await t.db
    .insertInto('maintenances')
    .values({
      id,
      title,
      description: 'Planned work',
      status,
      scheduled_start: start,
      scheduled_end: end,
      actual_start: status === 'completed' ? start : null,
      actual_end: status === 'completed' ? end : null,
      auto_start: 0,
      auto_complete: 0,
      is_public: isPublic,
      notify_subscribers: 0,
      reminder_sent_at: null,
      retroactive: 0,
      created_by: null,
      created_at: start,
      updated_at: end,
    })
    .execute();
  await t.db.insertInto('maintenance_services').values({ maintenance_id: id, service_id: api }).execute();
}

beforeEach(async () => {
  const now = Date.now();
  today = uptimeDayOf(now);
  day = shiftUptimeDay(today, -1);
  dayStart = Date.parse(`${day}T00:00:00.000Z`);

  t = await createTestApp();
  admin = await adminClient(t);
  await admin.patch('/api/admin/settings', { siteName: 'Example Status', uptimeDays: 7 });
  const created = data<Any>(await admin.post('/api/admin/services', { name: 'Public API' }));
  api = created.id;
  apiSlug = created.slug;
  hidden = data<Any>(await admin.post('/api/admin/services', { name: 'Hidden backend', isPublic: false })).id;

  // Measured: operational, a 2 h outage yesterday 10:00–12:00, operational until now.
  for (const id of [api, hidden]) {
    await t.db.deleteFrom('service_status_history').where('service_id', '=', id).execute();
    const rows = [
      { status: 'operational' as const, started_at: new Date(dayStart - 3 * DAY).toISOString(), ended_at: at(10) },
      { status: 'major_outage' as const, started_at: at(10), ended_at: at(12) },
      { status: 'operational' as const, started_at: at(12), ended_at: null },
    ];
    for (const r of rows) await t.db.insertInto('service_status_history').values({ id: newId(), service_id: id, ...r }).execute();
  }

  // The first hour of the outage was a false alarm: corrected publicly, with an internal reason.
  const correction = await admin.post('/api/admin/corrections', {
    serviceIds: [api],
    startsAt: at(10),
    endsAt: at(11),
    status: 'operational',
    reason: 'Monitoring host lost its network (INTERNAL-REASON-42)',
    showPublic: true,
    publicNote: 'False alarm of the monitoring.',
  });
  expect(correction.statusCode).toBe(201);
  correctionId = data<Any>(correction).id;

  await insertIncident('inc-day', 'Elevated error rates', 1, at(10), at(12), api);
  await insertIncident('inc-hidden', 'Private incident', 0, at(10), at(12), api);
  await insertIncident('inc-other-day', 'Older incident', 1, new Date(dayStart - 2 * DAY).toISOString(), new Date(dayStart - 2 * DAY + HOUR).toISOString(), api);
  await insertIncident('inc-hidden-service', 'Hidden service incident', 1, at(10), at(12), hidden);
  await insertMaintenance('mnt-day', 'Database upgrade', 1, 'completed', at(14), at(15));
  await insertMaintenance('mnt-hidden', 'Private maintenance', 0, 'completed', at(14), at(15));
  await insertMaintenance('mnt-cancelled', 'Cancelled maintenance', 1, 'cancelled', at(16), at(17));
});
afterEach(async () => {
  await t.close();
});

describe('public service days', () => {
  it('returns the bucket, the periods, incidents and maintenance of a day', async () => {
    const res = await get(`/api/public/services/${apiSlug}/days/${day}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    const body = res.json();
    expect(body.data).toMatchObject({
      type: 'service-days',
      id: `${api}:${day}`,
      links: { self: `/api/public/services/${apiSlug}/days/${day}` },
      relationships: {
        service: { data: { type: 'services', id: api } },
        incidents: { data: [{ type: 'incidents', id: 'inc-day' }] },
        maintenances: { data: [{ type: 'maintenances', id: 'mnt-day' }] },
      },
    });
    const included = (body.included as { type: string; id: string }[]).map((r) => `${r.type}:${r.id}`).sort();
    expect(included).toEqual([`incidents:inc-day`, `maintenances:mnt-day`, `services:${api}`]);
    // The service without its bars.
    const service = body.included.find((r: { type: string }) => r.type === 'services');
    expect(service.attributes.uptime).toBeUndefined();
    expect(service.attributes.name).toBe('Public API');

    const plain = deserializeDocument<PublicServiceDay & { service: { name: string }; incidents: Any[]; maintenances: Any[] }>(body).data;
    expect(plain).toMatchObject({
      date: day,
      startsAt: `${day}T00:00:00.000Z`,
      endsAt: new Date(dayStart + DAY).toISOString(),
      complete: true,
      status: 'major_outage',
      // 23 of 24 hours up after the correction.
      uptime: 95.83,
      minutes: { major_outage: 60 },
      corrected: true,
      correctionNotes: ['False alarm of the monitoring.'],
      previousDate: shiftUptimeDay(day, -1),
      nextDate: today,
    });
    expect(plain.segments).toEqual([
      { status: 'operational', startedAt: at(0), endedAt: at(10) },
      { status: 'operational', startedAt: at(10), endedAt: at(11), corrected: true },
      { status: 'major_outage', startedAt: at(11), endedAt: at(12) },
      { status: 'operational', startedAt: at(12), endedAt: at(24) },
    ]);
    expect(plain.service.name).toBe('Public API');
    expect(plain.incidents.map((i) => i.title)).toEqual(['Elevated error rates']);
    expect(plain.maintenances.map((m) => m.title)).toEqual(['Database upgrade']);
  });

  it('matches the bucket of the uptime bar', async () => {
    const service = data<Any>(await get(`/api/public/services/${api}`));
    const bucket = service.uptime.find((d: { date: string }) => d.date === day);
    const plain = data<Any>(await get(`/api/public/services/${api}/days/${day}`));
    expect({ status: plain.status, uptime: plain.uptime, minutes: plain.minutes, corrected: plain.corrected }).toEqual({
      status: bucket.status,
      uptime: bucket.uptime,
      minutes: bucket.minutes,
      corrected: bucket.corrected,
    });
  });

  it('exposes only public data', async () => {
    const res = await get(`/api/public/services/${api}/days/${day}`);
    for (const secret of [
      'INTERNAL-REASON-42',
      correctionId,
      'Private incident',
      'Private maintenance',
      'Cancelled maintenance',
      'Hidden service incident',
      'Older incident',
      'measured',
      'sourceId',
      '"reason"',
    ]) {
      expect(res.body, secret).not.toContain(secret);
    }
    // An unpublished correction marks nothing and shows no note.
    await t.db.updateTable('status_corrections').set({ show_public: 0 }).execute();
    const unpublished = data<Any>(await get(`/api/public/services/${api}/days/${day}`));
    expect(unpublished.corrected).toBeUndefined();
    expect(unpublished.correctionNotes).toBeUndefined();
    expect(unpublished.segments.some((s: { corrected?: boolean }) => s.corrected)).toBe(false);
    expect(JSON.stringify(unpublished)).not.toContain('False alarm');
  });

  it('marks today as incomplete with a period that still lasts', async () => {
    const plain = data<Any>(await get(`/api/public/services/${api}/days/${today}`));
    expect(plain.complete).toBe(false);
    expect(plain.nextDate).toBeNull();
    expect(plain.previousDate).toBe(day);
    expect(plain.segments).toEqual([{ status: 'operational', startedAt: `${today}T00:00:00.000Z`, endedAt: null }]);
  });

  it('answers 404 outside the uptime range, for hidden services and without uptime', async () => {
    const oldest = shiftUptimeDay(today, -6);
    expect((await get(`/api/public/services/${api}/days/${oldest}`)).statusCode).toBe(200);
    const first = data<Any>(await get(`/api/public/services/${api}/days/${oldest}`));
    expect(first.previousDate).toBeNull();
    for (const url of [
      `/api/public/services/${api}/days/${shiftUptimeDay(today, -7)}`,
      `/api/public/services/${api}/days/${shiftUptimeDay(today, 1)}`,
      `/api/public/services/${hidden}/days/${day}`,
      `/api/public/services/missing/days/${day}`,
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(errors(res)[0]).toMatchObject({ status: '404' });
    }
    await admin.patch('/api/admin/settings', { showUptime: false });
    expect((await get(`/api/public/services/${api}/days/${day}`)).statusCode).toBe(404);
  });

  it('answers 400 for malformed days and unsupported includes', async () => {
    for (const date of ['2026-02-30', 'yesterday', '2026-1-1', `${day}T00:00`]) {
      const res = await get(`/api/public/services/${api}/days/${encodeURIComponent(date)}`);
      expect(res.statusCode, date).toBe(400);
      expect(errors(res)[0]).toMatchObject({ status: '400', code: 'invalid_date' });
    }
    const res = await get(`/api/public/services/${api}/days/${day}?include=updates`);
    expect(res.statusCode).toBe(400);
    expect(errors(res)[0]).toMatchObject({ source: { parameter: 'include' } });
    const lean = (await get(`/api/public/services/${api}/days/${day}?include=`)).json();
    expect(lean.included ?? []).toEqual([]);
  });
});

describe('daySegments', () => {
  it('clips to the day, merges equal periods and keeps the open end of today', () => {
    const start = Date.UTC(2026, 10, 20);
    const iso = (h: number) => new Date(start + h * HOUR).toISOString();
    const now = new Date(start + 18 * HOUR);
    const segments = daySegments(
      [
        { status: 'operational', started_at: iso(-30), ended_at: iso(2) },
        { status: 'operational', started_at: iso(2), ended_at: iso(3) },
        { status: 'degraded', started_at: iso(3), ended_at: iso(4), source: 'maintenance', sourceId: 'm1' },
        { status: 'operational', started_at: iso(4), ended_at: iso(5), source: 'correction', sourceId: 'private' },
        { status: 'operational', started_at: iso(5), ended_at: iso(6), source: 'correction', sourceId: 'public' },
        { status: 'operational', started_at: iso(6), ended_at: null, source: 'measured', sourceId: null },
      ],
      new Set(['public']),
      start,
      now,
    );
    expect(segments).toEqual([
      { status: 'operational', startedAt: iso(0), endedAt: iso(3) },
      { status: 'degraded', startedAt: iso(3), endedAt: iso(4) },
      { status: 'operational', startedAt: iso(4), endedAt: iso(5) },
      { status: 'operational', startedAt: iso(5), endedAt: iso(6), corrected: true },
      { status: 'operational', startedAt: iso(6), endedAt: null },
    ]);
  });
});
