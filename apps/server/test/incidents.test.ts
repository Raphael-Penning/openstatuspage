import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminClient, createTestApp, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Client;
let serviceId: string;
let otherServiceId: string;

beforeEach(async () => {
  t = await createTestApp();
  admin = await adminClient(t);
  serviceId = (await admin.post('/api/admin/services', { name: 'Public API' })).json().data.id;
  otherServiceId = (await admin.post('/api/admin/services', { name: 'Dashboard' })).json().data.id;
});
afterEach(async () => {
  await t.close();
});

const statusOf = async (id: string) => (await admin.get(`/api/admin/services/${id}`)).json().data.attributes.status as string;
const historyOf = (id: string) =>
  t.db
    .selectFrom('service_status_history')
    .select(['status', 'ended_at'])
    .where('service_id', '=', id)
    // Insertion order (SQLite rowid): segments created within one millisecond share started_at.
    .orderBy(sql`rowid`)
    .execute();

describe('incident lifecycle', () => {
  it('changes the service status and records history', async () => {
    const created = await admin.post('/api/admin/incidents', {
      title: 'Elevated error rates',
      impact: 'major',
      message: 'We are investigating.',
      affectedServices: [{ serviceId, status: 'partial_outage' }],
    });
    expect(created.statusCode).toBe(201);
    const incident = created.json();
    expect(incident).toMatchObject({
      status: 'investigating',
      impact: 'major',
      resolvedAt: null,
      isPublic: true,
      source: 'manual',
      affectedServices: [{ id: serviceId, name: 'Public API', status: 'partial_outage' }],
    });
    expect(incident.updates).toHaveLength(1);
    expect(incident.createdBy).toEqual(expect.any(String));
    expect(await statusOf(serviceId)).toBe('partial_outage');

    // Update with new affected services: old and new services are recomputed.
    const moved = await admin.post(`/api/admin/incidents/${incident.id}/updates`, {
      status: 'identified',
      message: 'Root cause found.',
      affectedServices: [{ serviceId: otherServiceId, status: 'degraded' }],
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().updates.map((u: { status: string }) => u.status)).toEqual(['identified', 'investigating']);
    expect(await statusOf(serviceId)).toBe('operational');
    expect(await statusOf(otherServiceId)).toBe('degraded');

    // Resolve.
    const resolved = await admin.post(`/api/admin/incidents/${incident.id}/updates`, {
      status: 'resolved',
      message: 'Fixed.',
    });
    expect(resolved.json().resolvedAt).toEqual(expect.any(String));
    expect(await statusOf(otherServiceId)).toBe('operational');

    // Re-open.
    const reopened = await admin.post(`/api/admin/incidents/${incident.id}/updates`, {
      status: 'monitoring',
      message: 'Errors are back.',
    });
    expect(reopened.json()).toMatchObject({ status: 'monitoring', resolvedAt: null });
    expect(await statusOf(otherServiceId)).toBe('degraded');

    const history = await historyOf(serviceId);
    expect(history.map((h) => h.status)).toEqual(['operational', 'partial_outage', 'operational']);
    expect(history.at(-1)!.ended_at).toBeNull();

    // Hiding the incident removes its influence.
    const hidden = await admin.patch(`/api/admin/incidents/${incident.id}`, { isPublic: false, title: 'Errors' });
    expect(hidden.json()).toMatchObject({ isPublic: false, title: 'Errors' });
    expect(await statusOf(otherServiceId)).toBe('operational');

    // Edit and delete update entries.
    const updateId = reopened.json().updates[0].id;
    const edited = await admin.patch(`/api/admin/incidents/${incident.id}/updates/${updateId}`, { message: 'Edited.' });
    expect(edited.json().updates[0].message).toBe('Edited.');
    expect((await admin.delete(`/api/admin/incidents/${incident.id}/updates/${updateId}`)).statusCode).toBe(204);

    // Delete the incident.
    await admin.patch(`/api/admin/incidents/${incident.id}`, { isPublic: true });
    expect(await statusOf(otherServiceId)).toBe('degraded');
    expect((await admin.delete(`/api/admin/incidents/${incident.id}`)).statusCode).toBe(204);
    expect(await statusOf(otherServiceId)).toBe('operational');
    expect((await admin.get(`/api/admin/incidents/${incident.id}`)).statusCode).toBe(404);
  });

  it('lists incidents with status filter and pagination', async () => {
    for (let i = 0; i < 3; i++) {
      await admin.post('/api/admin/incidents', {
        title: `Incident ${i}`,
        message: 'x',
        startedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      });
    }
    await admin.post('/api/admin/incidents', { title: 'Old', message: 'x', status: 'resolved' });

    const page = await admin.get('/api/admin/incidents?page=1&pageSize=2');
    expect(page.json()).toMatchObject({ total: 4, page: 1, pageSize: 2 });
    expect(page.json().items).toHaveLength(2);
    expect((await admin.get('/api/admin/incidents?status=active')).json().total).toBe(3);
    const resolved = (await admin.get('/api/admin/incidents?status=resolved')).json();
    expect(resolved.total).toBe(1);
    expect(resolved.items[0].resolvedAt).toEqual(expect.any(String));
    expect((await admin.get('/api/admin/incidents?pageSize=1000')).statusCode).toBe(400);
  });

  it('validates input', async () => {
    expect((await admin.post('/api/admin/incidents', { title: 'x' })).statusCode).toBe(400);
    const unknown = await admin.post('/api/admin/incidents', {
      title: 'x',
      message: 'y',
      affectedServices: [{ serviceId: 'nope', status: 'degraded' }],
    });
    expect(unknown.statusCode).toBe(400);
    const open = (await admin.post('/api/admin/incidents', { title: 'x', message: 'y' })).json();
    const badResolve = await admin.patch(`/api/admin/incidents/${open.id}`, { resolvedAt: new Date().toISOString() });
    expect(badResolve.statusCode).toBe(400);
  });
});

describe('maintenance lifecycle', () => {
  it('moves through scheduled → in_progress → completed and sets maintenance status', async () => {
    const start = new Date(Date.now() + 86400_000).toISOString();
    const end = new Date(Date.now() + 2 * 86400_000).toISOString();
    const created = await admin.post('/api/admin/maintenances', {
      title: 'Database upgrade',
      description: 'Planned upgrade.',
      scheduledStart: start,
      scheduledEnd: end,
      serviceIds: [serviceId],
    });
    expect(created.statusCode).toBe(201);
    const m = created.json();
    expect(m).toMatchObject({ status: 'scheduled', actualStart: null, autoStart: true, affectedServices: [{ id: serviceId }] });
    expect(await statusOf(serviceId)).toBe('operational');
    expect((await admin.get('/api/admin/maintenances?status=upcoming')).json().total).toBe(1);

    const started = await admin.post(`/api/admin/maintenances/${m.id}/updates`, {
      status: 'in_progress',
      message: 'Started early.',
    });
    expect(started.json()).toMatchObject({ status: 'in_progress', actualStart: expect.any(String), actualEnd: null });
    expect(await statusOf(serviceId)).toBe('maintenance');
    expect((await admin.get('/api/admin/maintenances?status=active')).json().total).toBe(1);

    // An incident on top of maintenance still shows.
    await admin.post('/api/admin/incidents', {
      title: 'Upgrade failed',
      message: 'Rolling back.',
      affectedServices: [{ serviceId, status: 'major_outage' }],
    });
    expect(await statusOf(serviceId)).toBe('major_outage');
    const incidents = (await admin.get('/api/admin/incidents')).json();
    await admin.post(`/api/admin/incidents/${incidents.items[0].id}/updates`, { status: 'resolved', message: 'Ok.' });
    expect(await statusOf(serviceId)).toBe('maintenance');

    const done = await admin.post(`/api/admin/maintenances/${m.id}/updates`, { status: 'completed', message: 'Done.' });
    expect(done.json()).toMatchObject({ status: 'completed', actualEnd: expect.any(String) });
    expect(done.json().updates.map((u: { status: string }) => u.status)).toEqual(['completed', 'in_progress', 'scheduled']);
    expect(await statusOf(serviceId)).toBe('operational');
    expect((await admin.get('/api/admin/maintenances?status=past')).json().total).toBe(1);
  });

  it('starts due windows immediately and updates services on change', async () => {
    const created = await admin.post('/api/admin/maintenances', {
      title: 'Now',
      scheduledStart: new Date(Date.now() - 60_000).toISOString(),
      scheduledEnd: new Date(Date.now() + 3600_000).toISOString(),
      serviceIds: [serviceId],
    });
    expect(created.json().status).toBe('in_progress');
    expect(await statusOf(serviceId)).toBe('maintenance');

    const moved = await admin.patch(`/api/admin/maintenances/${created.json().id}`, { serviceIds: [otherServiceId] });
    expect(moved.statusCode).toBe(200);
    expect(await statusOf(serviceId)).toBe('operational');
    expect(await statusOf(otherServiceId)).toBe('maintenance');

    expect((await admin.patch(`/api/admin/maintenances/${created.json().id}`, {
      scheduledEnd: new Date(Date.now() - 3600_000).toISOString(),
    })).statusCode).toBe(400);

    expect((await admin.delete(`/api/admin/maintenances/${created.json().id}`)).statusCode).toBe(204);
    expect(await statusOf(otherServiceId)).toBe('operational');
  });

  it('rejects windows that end before they start', async () => {
    const res = await admin.post('/api/admin/maintenances', {
      title: 'Bad',
      scheduledStart: '2030-01-02T00:00:00.000Z',
      scheduledEnd: '2030-01-01T00:00:00.000Z',
    });
    expect(res.statusCode).toBe(400);
  });
});
