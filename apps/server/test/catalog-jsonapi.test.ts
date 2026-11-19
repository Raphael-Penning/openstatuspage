/**
 * JSON:API specifics of the admin catalog routes (services, groups, locations,
 * incidents, maintenance, corrections) beyond the behaviour tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminClient, createTestApp, data, doc, errors, type Client, type TestApp } from './helpers.js';

const MEDIA = 'application/vnd.api+json';

let t: TestApp;
let admin: Client;
beforeEach(async () => {
  t = await createTestApp();
  admin = await adminClient(t);
});
afterEach(async () => {
  await t.close();
});

describe('admin catalog documents', () => {
  it('requires a data member in request documents', async () => {
    // `data: undefined` is dropped by JSON.stringify: the body is sent without `data`.
    const plain = await admin.post('/api/admin/locations', { data: undefined, name: 'X', region: 'europe' });
    expect(errors(plain)[0]).toMatchObject({ status: '400', code: 'invalid_document' });
  });

  it('rejects client-generated ids with 403', async () => {
    const res = await admin.post('/api/admin/services', doc('services', { name: 'API' }, { id: 'abc' }));
    expect(res.statusCode).toBe(403);
    expect(errors(res)[0]).toMatchObject({ code: 'client_id_unsupported', source: { pointer: '/data/id' } });
    expect((await admin.get('/api/admin/services')).json().data).toEqual([]);
  });

  it('points validation errors of relationships at the relationship', async () => {
    const svc = data<{ id: string }>(await admin.post('/api/admin/services', { name: 'API' }));
    const res = await admin.post(
      '/api/admin/corrections',
      doc(
        'corrections',
        {
          serviceIds: [],
          startsAt: new Date(Date.now() - 7_200_000).toISOString(),
          endsAt: new Date(Date.now() - 3_600_000).toISOString(),
          status: 'operational',
          reason: 'False alarm',
        },
        { relationships: { serviceIds: 'services' } },
      ),
    );
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toBe(MEDIA);
    expect(errors(res)[0]).toMatchObject({ status: '400', code: 'too_small', source: { pointer: '/data/relationships/services' } });

    const ok = await admin.post(
      '/api/admin/corrections',
      doc(
        'corrections',
        {
          serviceIds: [svc.id],
          startsAt: new Date(Date.now() - 7_200_000).toISOString(),
          endsAt: new Date(Date.now() - 3_600_000).toISOString(),
          status: 'operational',
          reason: 'False alarm',
        },
        { relationships: { serviceIds: 'services' } },
      ),
    );
    expect(ok.statusCode).toBe(201);
    expect(data(ok)).toMatchObject({ serviceIds: [svc.id], services: [{ id: svc.id, name: 'API' }] });
  });

  it('serves the service history with its corrections and their services resolved', async () => {
    const svc = data<{ id: string }>(await admin.post('/api/admin/services', { name: 'API' }));
    const correction = data<{ id: string }>(
      await admin.post('/api/admin/corrections', {
        serviceIds: [svc.id],
        startsAt: new Date(Date.now() - 7_200_000).toISOString(),
        endsAt: new Date(Date.now() - 3_600_000).toISOString(),
        status: 'major_outage',
        reason: 'Missed outage',
      }),
    );
    const from = encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString());
    const to = encodeURIComponent(new Date().toISOString());
    const res = await admin.get(`/api/admin/services/${svc.id}/history?filter[from]=${from}&filter[to]=${to}`);
    expect(res.statusCode).toBe(200);
    const history = data<{ id: string; corrections: { id: string; services: { name: string }[] }[]; correctedUptime: number }>(res);
    expect(history.id).toBe(svc.id);
    expect(history.corrections.map((c) => c.id)).toEqual([correction.id]);
    expect(history.corrections[0]!.services).toEqual([{ id: svc.id, name: 'API' }]);
    expect(history.correctedUptime).toBeLessThan(100);
    expect((await admin.get(`/api/admin/services/${svc.id}/history?from=${from}&to=${to}`)).statusCode).toBe(400);
  });

  it('answers 406 for unsupported Accept parameters and 415 for plain JSON bodies', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/admin/incidents',
      headers: { accept: `${MEDIA}; ext="https://example.com/ext"` },
    });
    expect(res.statusCode).toBe(406);
    const plain = await t.app.inject({
      method: 'POST',
      url: '/api/admin/maintenances',
      headers: { 'content-type': 'application/json' },
      payload: { title: 'x' },
    });
    expect(plain.statusCode).toBe(415);
  });
});
