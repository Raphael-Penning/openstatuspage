import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminClient, createTestApp, data, doc, errors, page, type Client, type TestApp } from './helpers.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

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
    const incident = data<Any>(created);
    expect(created.headers.location).toBe(`/api/admin/incidents/${incident.id}`);
    expect(created.json().included.map((r: { type: string }) => r.type)).toEqual(['incident-updates']);
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
    const moved = await admin.post(`/api/admin/incidents/${incident.id}/updates`, doc('incident-updates', {
      status: 'identified',
      message: 'Root cause found.',
      affectedServices: [{ serviceId: otherServiceId, status: 'degraded' }],
    }));
    expect(moved.statusCode).toBe(201);
    const movedUpdate = data<Any>(moved);
    expect(moved.headers.location).toBe(`/api/admin/incidents/${incident.id}/updates/${movedUpdate.id}`);
    expect(movedUpdate).toMatchObject({ status: 'identified', message: 'Root cause found.', incidentId: incident.id });
    expect(movedUpdate.incident).toMatchObject({ status: 'identified', affectedServices: [{ id: otherServiceId }] });
    const detail = data<Any>(await admin.get(`/api/admin/incidents/${incident.id}`));
    expect(detail.updates.map((u: { status: string }) => u.status)).toEqual(['identified', 'investigating']);
    const withoutUpdates = await admin.get(`/api/admin/incidents/${incident.id}?include=`);
    expect(withoutUpdates.json()).not.toHaveProperty('included');
    expect((await admin.get(`/api/admin/incidents/${incident.id}?include=locations`)).statusCode).toBe(400);
    const plainType = await admin.post(`/api/admin/incidents/${incident.id}/updates`, { status: 'identified', message: 'x' });
    expect(errors(plainType)[0]).toMatchObject({ status: '409', code: 'type_mismatch' });
    expect(await statusOf(serviceId)).toBe('operational');
    expect(await statusOf(otherServiceId)).toBe('degraded');

    // Resolve.
    const resolved = await admin.post(`/api/admin/incidents/${incident.id}/updates`, doc('incident-updates', {
      status: 'resolved',
      message: 'Fixed.',
    }));
    expect(data<Any>(resolved).incident.resolvedAt).toEqual(expect.any(String));
    expect(await statusOf(otherServiceId)).toBe('operational');

    // Re-open.
    const reopened = await admin.post(`/api/admin/incidents/${incident.id}/updates`, doc('incident-updates', {
      status: 'monitoring',
      message: 'Errors are back.',
    }));
    expect(data<Any>(reopened).incident).toMatchObject({ status: 'monitoring', resolvedAt: null });
    expect(await statusOf(otherServiceId)).toBe('degraded');

    const history = await historyOf(serviceId);
    expect(history.map((h) => h.status)).toEqual(['operational', 'partial_outage', 'operational']);
    expect(history.at(-1)!.ended_at).toBeNull();

    // Hiding the incident removes its influence.
    const hidden = await admin.patch(`/api/admin/incidents/${incident.id}`, { isPublic: false, title: 'Errors' });
    expect(data(hidden)).toMatchObject({ isPublic: false, title: 'Errors' });
    expect(await statusOf(otherServiceId)).toBe('operational');

    // Edit and delete update entries.
    const updateId = data<Any>(reopened).id;
    const updateUrl = `/api/admin/incidents/${incident.id}/updates/${updateId}`;
    const edited = await admin.patch(updateUrl, { data: { type: 'incident-updates', id: updateId, attributes: { message: 'Edited.' } } });
    expect(data(edited)).toMatchObject({ id: updateId, message: 'Edited.' });
    expect(data(await admin.get(updateUrl))).toMatchObject({ message: 'Edited.', status: 'monitoring' });
    const wrongId = await admin.patch(updateUrl, { data: { type: 'incident-updates', id: incident.id, attributes: { message: 'x' } } });
    expect(wrongId.statusCode).toBe(409);
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

    const first = await admin.get('/api/admin/incidents?page[number]=1&page[size]=2');
    expect(page(first)).toMatchObject({ total: 4, page: 1, pageSize: 2 });
    expect(page(first).items).toHaveLength(2);
    expect(page<Any>(first).items[0].updates).toHaveLength(1);
    expect(first.json().links.next).toBe('/api/admin/incidents?page[number]=2&page[size]=2');
    expect(page(await admin.get('/api/admin/incidents?filter[status]=active')).total).toBe(3);
    const resolved = page<Any>(await admin.get('/api/admin/incidents?filter[status]=resolved'));
    expect(resolved.total).toBe(1);
    expect(resolved.items[0].resolvedAt).toEqual(expect.any(String));
    const tooLarge = await admin.get('/api/admin/incidents?page[size]=1000');
    expect(errors(tooLarge)[0]).toMatchObject({ status: '400', source: { parameter: 'page[size]' } });
    expect((await admin.get('/api/admin/incidents?filter[status]=open')).statusCode).toBe(400);
  });

  it('validates input', async () => {
    const missing = await admin.post('/api/admin/incidents', { title: 'x' });
    expect(missing.statusCode).toBe(400);
    expect(errors(missing)[0]).toMatchObject({ source: { pointer: '/data/attributes/message' } });
    const unknown = await admin.post('/api/admin/incidents', {
      title: 'x',
      message: 'y',
      affectedServices: [{ serviceId: 'nope', status: 'degraded' }],
    });
    expect(unknown.statusCode).toBe(400);
    const open = data<Any>(await admin.post('/api/admin/incidents', { title: 'x', message: 'y' }));
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
    const m = data<Any>(created);
    expect(created.headers.location).toBe(`/api/admin/maintenances/${m.id}`);
    expect(m).toMatchObject({
      status: 'scheduled',
      actualStart: null,
      autoStart: true,
      affectedServices: [{ id: serviceId }],
      serviceIds: [serviceId],
    });
    expect(m.updates).toHaveLength(1);
    expect(await statusOf(serviceId)).toBe('operational');
    const upcoming = await admin.get('/api/admin/maintenances?filter[status]=upcoming&include=');
    expect(page(upcoming).total).toBe(1);
    expect(upcoming.json()).not.toHaveProperty('included');

    const started = await admin.post(`/api/admin/maintenances/${m.id}/updates`, doc('maintenance-updates', {
      status: 'in_progress',
      message: 'Started early.',
    }));
    expect(started.statusCode).toBe(201);
    const startedUpdate = data<Any>(started);
    expect(started.headers.location).toBe(`/api/admin/maintenances/${m.id}/updates/${startedUpdate.id}`);
    expect(startedUpdate).toMatchObject({ status: 'in_progress', message: 'Started early.', maintenanceId: m.id });
    expect(startedUpdate.maintenance).toMatchObject({ status: 'in_progress', actualStart: expect.any(String), actualEnd: null });
    expect(data(await admin.get(started.headers.location as string))).toMatchObject({ id: startedUpdate.id });
    expect(await statusOf(serviceId)).toBe('maintenance');
    expect(page(await admin.get('/api/admin/maintenances?filter[status]=active')).total).toBe(1);

    // An incident on top of maintenance still shows.
    await admin.post('/api/admin/incidents', {
      title: 'Upgrade failed',
      message: 'Rolling back.',
      affectedServices: [{ serviceId, status: 'major_outage' }],
    });
    expect(await statusOf(serviceId)).toBe('major_outage');
    const incidents = page<Any>(await admin.get('/api/admin/incidents'));
    await admin.post(`/api/admin/incidents/${incidents.items[0].id}/updates`, doc('incident-updates', { status: 'resolved', message: 'Ok.' }));
    expect(await statusOf(serviceId)).toBe('maintenance');

    const done = await admin.post(`/api/admin/maintenances/${m.id}/updates`, doc('maintenance-updates', { status: 'completed', message: 'Done.' }));
    expect(data<Any>(done).maintenance).toMatchObject({ status: 'completed', actualEnd: expect.any(String) });
    const detail = data<Any>(await admin.get(`/api/admin/maintenances/${m.id}`));
    expect(detail.updates.map((u: { status: string }) => u.status)).toEqual(['completed', 'in_progress', 'scheduled']);
    expect(await statusOf(serviceId)).toBe('operational');
    expect(page(await admin.get('/api/admin/maintenances?filter[status]=past')).total).toBe(1);
  });

  it('starts due windows immediately and updates services on change', async () => {
    const created = await admin.post('/api/admin/maintenances', {
      title: 'Now',
      scheduledStart: new Date(Date.now() - 60_000).toISOString(),
      scheduledEnd: new Date(Date.now() + 3600_000).toISOString(),
      serviceIds: [serviceId],
    });
    const m = data<Any>(created);
    expect(m.status).toBe('in_progress');
    expect(await statusOf(serviceId)).toBe('maintenance');

    const moved = await admin.patch(`/api/admin/maintenances/${m.id}`, {
      data: { type: 'maintenances', id: m.id, relationships: { services: { data: [{ type: 'services', id: otherServiceId }] } } },
    });
    expect(moved.statusCode).toBe(200);
    expect(data(moved)).toMatchObject({ serviceIds: [otherServiceId] });
    expect(await statusOf(serviceId)).toBe('operational');
    expect(await statusOf(otherServiceId)).toBe('maintenance');

    expect((await admin.patch(`/api/admin/maintenances/${m.id}`, {
      scheduledEnd: new Date(Date.now() - 3600_000).toISOString(),
    })).statusCode).toBe(400);

    expect((await admin.delete(`/api/admin/maintenances/${m.id}`)).statusCode).toBe(204);
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
