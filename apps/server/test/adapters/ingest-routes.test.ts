import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INGEST_RATE_LIMIT_PER_MINUTE } from '../../src/adapters/routes.js';
import { newId } from '../../src/lib/ids.js';
import { nowIso } from '../../src/lib/time.js';
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
    expect(res.json()).toEqual({ jsonapi: { version: '1.1' }, meta: { created: 1, updated: 0, removed: 0, stateChanges: 0 } });
    expect(await checks(id)).toEqual([
      { external_id: 'web01!https', name: 'HTTPS', host: 'web01', state: 'critical', output: 'down' },
    ]);

    const again = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { checks: [{ id: 'web01!https', state: 'ok' }] },
    });
    expect(again.json()).toEqual({ jsonapi: { version: '1.1' }, meta: { created: 0, updated: 1, removed: 0, stateChanges: 1 } });
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
    expect(wrong.json().errors[0]).toMatchObject({ code: 'unauthorized' });
    const basic = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}`,
      headers: { authorization: `Basic ${token}` },
      payload: genericBody,
    });
    expect(basic.statusCode).toBe(401);
    expect(await checks(id)).toEqual([]);
  });

  it('authenticates before the body is read or parsed', async () => {
    const { id, token } = await t.insertSource({ type: 'webhook' });
    const unparsable = '{"checks": ['.padEnd(2 * 1024 * 1024, ' ');
    for (const [url, headers] of [
      [`/api/ingest/${id}`, {}],
      [`/api/ingest/${id}`, { authorization: `Bearer ${token}x` }],
      [`/api/ingest/${id}/uptimekuma`, {}],
      ['/api/ingest/00000000-0000-0000-0000-000000000000', { authorization: `Bearer ${token}` }],
    ] as const) {
      const res = await t.app.inject({
        method: 'POST',
        url,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: unparsable,
      });
      // A parsed body would answer 400 (invalid JSON); the hook answers first.
      expect(res.statusCode, url).toBeOneOf([401, 404]);
    }
    // Authenticated, the same body reaches the parser (and up to 5 MiB are allowed).
    const parsed = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: unparsable,
    });
    expect(parsed.statusCode).toBe(400);
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
    // Native bodies are no JSON:API documents: the pointer refers to the body as sent.
    expect(res.headers['content-type']).toBe('application/vnd.api+json');
    expect(res.json().errors[0]).toMatchObject({ status: '400', source: { pointer: '/checks/0/state' } });
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
    expect(res.json().meta).toMatchObject({ removed: 1 });
    expect((await checks(id)).map((c) => c.external_id)).toEqual(['a']);
  });

  it('rejects full pushes for pull sources', async () => {
    const { id, token } = await t.insertSource({
      type: 'icinga2',
      config: { baseUrl: 'https://icinga.example.com:5665', username: 'u', password: 'p' },
    });
    const push = (payload: Record<string, unknown>) =>
      t.app.inject({ method: 'POST', url: `/api/ingest/${id}`, headers: { authorization: `Bearer ${token}` }, payload });
    await push({ checks: [{ id: 'a', state: 0 }, { id: 'b', state: 0 }] });
    const res = await push({ checks: [{ id: 'a', state: 2 }], full: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].detail).toContain('only supported for sources of type "webhook"');
    expect((await checks(id)).map((c) => [c.external_id, c.state])).toEqual([
      ['a', 'ok'],
      ['b', 'ok'],
    ]);
  });

  it('rejects a full push that would remove most checks linked to services', async () => {
    const { id, token } = await t.insertSource({ type: 'webhook' });
    const push = (payload: Record<string, unknown>) =>
      t.app.inject({ method: 'POST', url: `/api/ingest/${id}`, headers: { authorization: `Bearer ${token}` }, payload });
    await push({ checks: ['a', 'b', 'c', 'd'].map((c) => ({ id: c, state: 0 })) });
    const now = nowIso();
    const serviceId = newId();
    await t.ctx.db
      .insertInto('services')
      .values({
        id: serviceId,
        slug: 'web',
        name: 'Web',
        kind: 'service',
        sort_order: 0,
        is_public: 1,
        status_mode: 'auto',
        manual_status: 'operational',
        aggregation: 'worst',
        current_status: 'operational',
        monitor_status: 'operational',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const rows = await t.ctx.db.selectFrom('monitor_checks').select(['id', 'external_id']).where('source_id', '=', id).execute();
    const linkedIds = rows.filter((r) => ['a', 'b', 'c'].includes(r.external_id)).map((r) => r.id);
    await t.ctx.db
      .insertInto('service_checks')
      .values(linkedIds.map((checkId) => ({ service_id: serviceId, check_id: checkId })))
      .execute();
    const links = async () =>
      (
        await t.ctx.db
          .selectFrom('service_checks')
          .innerJoin('monitor_checks', 'monitor_checks.id', 'service_checks.check_id')
          .select('monitor_checks.external_id')
          .orderBy('monitor_checks.external_id')
          .execute()
      ).map((l) => l.external_id);

    // Would remove b and c (2 of 3 linked): rejected, nothing stored.
    const rejected = await push({ checks: [{ id: 'a', state: 2 }, { id: 'd', state: 2 }], full: true });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().errors[0].detail).toContain('remove 2 of 3 checks that are linked to services');
    expect((await checks(id)).map((c) => [c.external_id, c.state])).toEqual([
      ['a', 'ok'],
      ['b', 'ok'],
      ['c', 'ok'],
      ['d', 'ok'],
    ]);

    // Removing one of three linked checks (and any unlinked ones) is a normal sync.
    const res = await push({ checks: [{ id: 'a', state: 0 }, { id: 'b', state: 0 }, { id: 'x', state: 0 }], full: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta).toMatchObject({ created: 1, removed: 2 });
    expect(await links()).toEqual(['a', 'b']);

    const wipe = await push({ checks: [{ id: 'x', state: 0 }], full: true });
    expect(wipe.statusCode).toBe(409);
    expect(await links()).toEqual(['a', 'b']);
  });

  it('counts linked checks removed by earlier full pushes within 24 hours', async () => {
    const { id, token } = await t.insertSource({ type: 'webhook' });
    const push = (ids: string[], full = true) =>
      t.app.inject({
        method: 'POST',
        url: `/api/ingest/${id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { checks: ids.map((c) => ({ id: c, state: 0 })), full },
      });
    await push(['a', 'b', 'c', 'd'], false);
    const rows = await t.ctx.db.selectFrom('monitor_checks').select('id').where('source_id', '=', id).execute();
    const now = nowIso();
    const serviceId = newId();
    await t.ctx.db
      .insertInto('services')
      .values({
        id: serviceId,
        slug: 'api',
        name: 'API',
        kind: 'service',
        sort_order: 0,
        is_public: 1,
        status_mode: 'auto',
        manual_status: 'operational',
        aggregation: 'worst',
        current_status: 'operational',
        monitor_status: 'operational',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await t.ctx.db
      .insertInto('service_checks')
      .values(rows.map((r) => ({ service_id: serviceId, check_id: r.id })))
      .execute();

    // Half of the four linked checks: allowed.
    expect((await push(['a', 'b'])).statusCode).toBe(200);
    // One more of the remaining two would be three of four within the window.
    const next = await push(['a']);
    expect(next.statusCode).toBe(409);
    expect(next.json().errors[0].detail).toContain('2 more were removed by full pushes in the last 24 hours');
    expect((await checks(id)).map((c) => c.external_id)).toEqual(['a', 'b']);

    // After the window, the count starts again.
    await t.ctx.db
      .updateTable('monitor_sources')
      .set({ full_sync_window_at: new Date(Date.now() - 25 * 60 * 60_000).toISOString() })
      .where('id', '=', id)
      .execute();
    expect((await push(['a'])).statusCode).toBe(200);
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
    expect(limited.json().errors[0]).toMatchObject({ code: 'rate_limited' });
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
    expect(test.json()).toEqual({ jsonapi: { version: '1.1' }, meta: { created: 0, updated: 0, removed: 0, stateChanges: 0 } });
    const down = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${id}/uptimekuma?token=${token}`,
      payload: jsonFixture('uptimekuma-webhook-down.json'),
    });
    expect(down.json().meta).toMatchObject({ created: 1 });
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
    expect(res.json().errors[0].detail).toMatch(/state/);
  });
});

describe('admin routes', () => {
  it('are protected by requireRole("admin")', async () => {
    const { id } = await t.insertSource({ type: 'webhook' });
    for (const action of ['test', 'poll']) {
      const res = await t.app.inject({ method: 'POST', url: `/api/admin/monitor-sources/${id}/${action}` });
      expect(res.statusCode).toBe(401);
      expect(res.json().errors[0]).toMatchObject({ status: '401', code: 'unauthorized' });
    }
  });
});
