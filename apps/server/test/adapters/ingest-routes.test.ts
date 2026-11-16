import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INGEST_RATE_LIMIT_PER_MINUTE } from '../../src/adapters/routes.js';
import { createTestApp, jsonFixture, type TestApp } from './helpers.js';

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});

afterEach(async () => {
  await t.close();
});

const genericBody = { checks: [{ id: 'web01!https', name: 'HTTPS', host: 'web01', state: 2, output: 'down' }] };

async function checks(sourceId: string) {
  return t.ctx.db
    .selectFrom('monitor_checks')
    .select(['external_id', 'name', 'host', 'state', 'output'])
    .where('source_id', '=', sourceId)
    .orderBy('external_id')
    .execute();
}

describe('POST /api/ingest/:sourceId', () => {
  it('accepts a bearer token and stores checks', async () => {
    const { id, token } = await t.insertSource({ type: 'webhook' });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: genericBody,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, created: 1, updated: 0, removed: 0, stateChanges: 0 });
    expect(await checks(id)).toEqual([
      { external_id: 'web01!https', name: 'HTTPS', host: 'web01', state: 'critical', output: 'down' },
    ]);

    const again = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { checks: [{ id: 'web01!https', state: 'ok' }] },
    });
    expect(again.json()).toEqual({ ok: true, created: 0, updated: 1, removed: 0, stateChanges: 1 });
  });

  it('accepts the token as query parameter', async () => {
    const { id, token } = await t.insertSource({ type: 'webhook' });
    const res = await t.app.inject({ method: 'POST', url: `/api/ingest/${id}?token=${token}`, payload: genericBody });
    expect(res.statusCode).toBe(200);
  });

  it('accepts generic pushes for every source type', async () => {
    const { id, token } = await t.insertSource({
      type: 'icinga2',
      config: { baseUrl: 'https://icinga.example.com:5665', username: 'u', password: 'p' },
    });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: genericBody,
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects missing and wrong tokens with 401', async () => {
    const { id, token } = await t.insertSource({ type: 'webhook' });
    const missing = await t.app.inject({ method: 'POST', url: `/api/ingest/${id}`, payload: genericBody });
    expect(missing.statusCode).toBe(401);
    const wrong = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}`,
      headers: { authorization: `Bearer ${token}x` },
      payload: genericBody,
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: 'unauthorized' });
    const basic = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}`,
      headers: { authorization: `Basic ${token}` },
      payload: genericBody,
    });
    expect(basic.statusCode).toBe(401);
    expect(await checks(id)).toEqual([]);
  });

  it('returns 404 for unknown sources and formats', async () => {
    const { id, token } = await t.insertSource({ type: 'webhook' });
    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/ingest/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${token}` },
      payload: genericBody,
    });
    expect(unknown.statusCode).toBe(404);
    const format = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}/nagios`,
      headers: { authorization: `Bearer ${token}` },
      payload: genericBody,
    });
    expect(format.statusCode).toBe(404);
  });

  it('returns 409 for disabled sources', async () => {
    const { id, token } = await t.insertSource({ type: 'webhook', enabled: false });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: genericBody,
    });
    expect(res.statusCode).toBe(409);
  });

  it('validates the payload', async () => {
    const { id, token } = await t.insertSource({ type: 'webhook' });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { checks: [{ id: 'x', state: 'broken' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_error' });
  });

  it('accepts JSON sent as text/plain', async () => {
    const { id, token } = await t.insertSource({ type: 'webhook' });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
      payload: JSON.stringify(genericBody),
    });
    expect(res.statusCode).toBe(200);
    const bad = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
      payload: 'not json',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('removes missing checks only for full pushes', async () => {
    const { id, token } = await t.insertSource({ type: 'webhook' });
    const push = (payload: Record<string, unknown>) =>
      t.app.inject({ method: 'POST', url: `/api/ingest/${id}`, headers: { authorization: `Bearer ${token}` }, payload });
    await push({ checks: [{ id: 'a', state: 0 }, { id: 'b', state: 0 }] });
    await push({ checks: [{ id: 'a', state: 1 }] });
    expect((await checks(id)).map((c) => c.external_id)).toEqual(['a', 'b']);
    const res = await push({ checks: [{ id: 'a', state: 1 }], full: true });
    expect(res.json()).toMatchObject({ removed: 1 });
    expect((await checks(id)).map((c) => c.external_id)).toEqual(['a']);
  });

  it(`rate limits to ${INGEST_RATE_LIMIT_PER_MINUTE} requests per minute and source`, async () => {
    const a = await t.insertSource({ type: 'webhook' });
    const b = await t.insertSource({ type: 'webhook' });
    const push = (s: { id: string; token: string }) =>
      t.app.inject({
        method: 'POST',
        url: `/api/ingest/${s.id}`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { checks: [{ id: 'x', state: 0 }] },
      });
    for (let i = 0; i < INGEST_RATE_LIMIT_PER_MINUTE; i++) {
      const res = await push(a);
      expect(res.statusCode).toBe(200);
    }
    const limited = await push(a);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect(limited.json()).toMatchObject({ error: 'rate_limited' });
    expect((await push(b)).statusCode).toBe(200);
  });
});

describe('native push endpoints', () => {
  it('accepts Uptime Kuma webhooks, including test notifications', async () => {
    const { id, token } = await t.insertSource({
      type: 'uptimekuma',
      config: { baseUrl: 'https://kuma.example.com', apiKey: 'k' },
    });
    const test = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}/uptimekuma?token=${token}`,
      payload: jsonFixture('uptimekuma-webhook-test.json'),
    });
    expect(test.json()).toEqual({ ok: true, created: 0, updated: 0, removed: 0, stateChanges: 0 });
    const down = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}/uptimekuma?token=${token}`,
      payload: jsonFixture('uptimekuma-webhook-down.json'),
    });
    expect(down.json()).toMatchObject({ ok: true, created: 1 });
    expect(await checks(id)).toEqual([
      { external_id: 'Mail server', name: 'Mail server', host: 'mail.example.com', state: 'critical', output: 'connect ECONNREFUSED' },
    ]);
  });

  it('accepts native payloads on webhook sources, but not on sources of another type', async () => {
    const webhook = await t.insertSource({ type: 'webhook' });
    const icinga = await t.insertSource({
      type: 'icinga2',
      config: { baseUrl: 'https://icinga.example.com:5665', username: 'u', password: 'p' },
    });
    const body = { type: 'service', host: 'web01', service: 'http', state: 'OK' };
    const ok = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${webhook.id}/icinga2`,
      headers: { authorization: `Bearer ${webhook.token}` },
      payload: body,
    });
    expect(ok.statusCode).toBe(200);
    const okIcinga = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${icinga.id}/icinga2`,
      headers: { authorization: `Bearer ${icinga.token}` },
      payload: body,
    });
    expect(okIcinga.statusCode).toBe(200);
    const mismatch = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${icinga.id}/openitcockpit`,
      headers: { authorization: `Bearer ${icinga.token}` },
      payload: { host: 'x', stateId: 0 },
    });
    expect(mismatch.statusCode).toBe(400);
  });

  it('returns 400 for invalid native payloads', async () => {
    const { id, token } = await t.insertSource({ type: 'webhook' });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}/icinga2`,
      headers: { authorization: `Bearer ${token}` },
      payload: { host: 'web01', service: 'http' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/state/);
  });
});

describe('admin routes', () => {
  it('are protected by requireRole("admin")', async () => {
    const { id } = await t.insertSource({ type: 'webhook' });
    for (const action of ['test', 'poll']) {
      const res = await t.app.inject({ method: 'POST', url: `/api/admin/monitor-sources/${id}/${action}` });
      expect(res.statusCode).toBe(401);
    }
  });
});
