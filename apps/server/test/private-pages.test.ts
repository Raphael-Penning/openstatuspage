/**
 * Private status pages (/p/<token>): the admin API (token shown once, stored as
 * a hash, regeneration), the private page API (token in a header, only the
 * page's services, also hidden ones), the 404s that never tell why, headers,
 * rate limits and log redaction. Server rendering: private-pages-ssr.test.ts.
 */
import { request } from 'node:http';
import { deserializeDocument, PRIVATE_PAGE_TOKEN_HEADER, shiftUptimeDay, uptimeDayOf } from '@openstatuspage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactPrivatePagePath, serializeRequest } from '../src/app.js';
import { newId } from '../src/lib/ids.js';
import { privatePageTokenHash } from '../src/services/private-page-store.js';
import { newPrivatePageToken } from '../src/services/private-pages.js';
import { adminClient, BASE_URL, createTestApp, data, type Client, type TestApp } from './helpers.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let t: TestApp;
let admin: Client;
let ids: { publicService: string; hidden: string; otherHidden: string; hiddenSlug: string };

const api = (url: string, token?: string) =>
  t.app.inject({ method: 'GET', url, headers: token === undefined ? {} : { [PRIVATE_PAGE_TOKEN_HEADER]: token } });

async function createPage(body: Record<string, unknown>): Promise<Any> {
  const res = await admin.post('/api/admin/private-pages', body);
  expect(res.statusCode, res.body).toBe(201);
  return data<Any>(res);
}

beforeEach(async () => {
  t = await createTestApp();
  admin = await adminClient(t);
  await admin.patch('/api/admin/settings', { siteName: 'Example Status', uptimeDays: 7 });
  const publicService = data<Any>(await admin.post('/api/admin/services', { name: 'Public API' })).id;
  const hiddenService = data<Any>(await admin.post('/api/admin/services', { name: 'Partner backend', isPublic: false }));
  const otherHidden = data<Any>(await admin.post('/api/admin/services', { name: 'Other secret', isPublic: false })).id;
  ids = { publicService, hidden: hiddenService.id, otherHidden, hiddenSlug: hiddenService.slug };
});
afterEach(async () => {
  await t.close();
});

describe('admin API', () => {
  it('creates a page and shows its token and link only once', async () => {
    const page = await createPage({ name: 'Partner', description: 'For ACME', serviceIds: [ids.hidden, ids.publicService] });
    expect(page.token).toMatch(/^[a-z2-7]{32}$/);
    expect(page.url).toBe(`${BASE_URL}/p/${page.token}`);
    expect(page).toMatchObject({ name: 'Partner', description: 'For ACME', serviceIds: [ids.hidden, ids.publicService], enabled: true, expired: false });

    // Stored as its hash only.
    const row = await t.db.selectFrom('private_pages').selectAll().where('id', '=', page.id).executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(privatePageTokenHash(page.token));
    expect(JSON.stringify(row)).not.toContain(page.token);

    for (const res of [await admin.get(`/api/admin/private-pages/${page.id}`), await admin.get('/api/admin/private-pages')]) {
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(page.token);
      expect(res.body).not.toContain(row.token_hash);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('updates, regenerates the link and deletes, with audit entries that never hold the token', async () => {
    const page = await createPage({ name: 'Partner', serviceIds: [ids.hidden] });
    const patched = await admin.patch(`/api/admin/private-pages/${page.id}`, { name: 'Partner B', serviceIds: [ids.otherHidden, ids.hidden] });
    expect(patched.statusCode).toBe(200);
    expect(data<Any>(patched)).toMatchObject({ name: 'Partner B', serviceIds: [ids.otherHidden, ids.hidden] });
    expect(data<Any>(patched).token).toBeUndefined();
    // The link stays the same on an update.
    expect((await api('/api/public/private-page', page.token)).statusCode).toBe(200);

    const regenerated = await admin.post(`/api/admin/private-pages/${page.id}/regenerate-token`);
    expect(regenerated.statusCode).toBe(200);
    const fresh = data<Any>(regenerated);
    expect(fresh.token).toMatch(/^[a-z2-7]{32}$/);
    expect(fresh.token).not.toBe(page.token);
    expect(fresh.url).toBe(`${BASE_URL}/p/${fresh.token}`);
    expect((await api('/api/public/private-page', page.token)).statusCode).toBe(404);
    expect((await api('/api/public/private-page', fresh.token)).statusCode).toBe(200);

    expect((await admin.delete(`/api/admin/private-pages/${page.id}`)).statusCode).toBe(204);
    expect((await admin.get(`/api/admin/private-pages/${page.id}`)).statusCode).toBe(404);
    expect((await api('/api/public/private-page', fresh.token)).statusCode).toBe(404);
    expect(await t.db.selectFrom('private_page_services').selectAll().execute()).toEqual([]);

    const audit = await t.db.selectFrom('audit_log').select(['action', 'details']).where('entity_type', '=', 'private_page').orderBy('created_at').execute();
    expect(audit.map((a) => a.action)).toEqual([
      'private_page.create',
      'private_page.update',
      'private_page.regenerate_token',
      'private_page.delete',
    ]);
    for (const a of audit) {
      expect(a.details ?? '').not.toContain(page.token);
      expect(a.details ?? '').not.toContain(fresh.token);
    }
  });

  it('rejects unknown services and bad input, and is for admins only', async () => {
    expect((await admin.post('/api/admin/private-pages', { name: 'X', serviceIds: ['missing'] })).statusCode).toBe(400);
    expect((await admin.post('/api/admin/private-pages', { name: '' })).statusCode).toBe(400);
    expect((await admin.post('/api/admin/private-pages', { name: 'X', expiresAt: 'soon' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/private-pages' })).statusCode).toBe(401);
  });

  it('marks expired pages', async () => {
    const page = await createPage({ name: 'Old', expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(page.expired).toBe(true);
  });
});

describe('private page API', () => {
  it('shows exactly the page’s services, hidden ones too, with private headers', async () => {
    const page = await createPage({ name: 'Partner', description: 'Only for ACME', serviceIds: [ids.hidden, ids.publicService] });
    const res = await api('/api/public/private-page', page.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.body).not.toContain(page.token);
    const { data: view } = deserializeDocument<Any>(res.json());
    expect(view).toMatchObject({ id: page.id, name: 'Partner', description: 'Only for ACME', overall: 'operational' });
    expect(view.services.map((s: Any) => s.id)).toEqual([ids.hidden, ids.publicService]);
    expect(view.services[0].uptime).toHaveLength(7);
    expect(res.body).not.toContain(ids.otherHidden);
    expect(res.json().data.links.self).toBe('/api/public/private-page');
  });

  it('keeps hidden services off the main page, its API and the discovery files', async () => {
    await createPage({ name: 'Partner', serviceIds: [ids.hidden] });
    for (const url of ['/api/public/services', '/api/public/summary', '/api/public/status', `/api/public/services/${ids.hidden}`]) {
      const res = await api(url);
      expect(res.body, url).not.toContain(ids.hidden);
      expect(res.body, url).not.toContain('Partner backend');
    }
  });

  it('answers a wrong, disabled, expired or missing token with the same 404', async () => {
    const page = await createPage({ name: 'Partner', serviceIds: [ids.hidden] });
    const disabled = await createPage({ name: 'Off', serviceIds: [ids.hidden], enabled: false });
    const expired = await createPage({ name: 'Old', serviceIds: [ids.hidden], expiresAt: new Date(Date.now() - 1000).toISOString() });
    const answers = [
      await api('/api/public/private-page'),
      await api('/api/public/private-page', ''),
      await api('/api/public/private-page', newPrivatePageToken()),
      await api('/api/public/private-page', 'x'.repeat(500)),
      await api('/api/public/private-page', disabled.token),
      await api('/api/public/private-page', expired.token),
    ];
    for (const res of answers) {
      expect(res.statusCode).toBe(404);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.body).toBe(answers[0]!.body);
    }
    // The token is never read from the URL.
    expect((await api(`/api/public/private-page?token=${page.token}`)).statusCode).toBe(404);
    // Base32 is case-insensitive: the token in upper case is the same token.
    expect((await api('/api/public/private-page', page.token.toUpperCase())).statusCode).toBe(200);
  });

  it('serves the service and day of a page’s hidden service, nothing of other services', async () => {
    const page = await createPage({ name: 'Partner', serviceIds: [ids.hidden] });
    const now = Date.now();
    const yesterday = shiftUptimeDay(uptimeDayOf(now), -1);
    const at = (h: number) => new Date(Date.parse(`${yesterday}T00:00:00.000Z`) + h * 3_600_000).toISOString();
    await t.db.deleteFrom('service_status_history').where('service_id', '=', ids.hidden).execute();
    for (const r of [
      { status: 'operational' as const, started_at: new Date(now - 5 * 86_400_000).toISOString(), ended_at: at(10) },
      { status: 'major_outage' as const, started_at: at(10), ended_at: at(11) },
      { status: 'operational' as const, started_at: at(11), ended_at: null },
    ]) {
      await t.db.insertInto('service_status_history').values({ id: newId(), service_id: ids.hidden, ...r }).execute();
    }
    const incident = await admin.post('/api/admin/incidents', {
      title: 'Backend outage',
      message: 'We are on it.',
      startedAt: at(10),
      affectedServices: [{ serviceId: ids.hidden, status: 'major_outage' }],
    });
    expect(incident.statusCode, incident.body).toBe(201);

    const service = await api(`/api/public/private-page/services/${ids.hiddenSlug}`, page.token);
    expect(service.statusCode).toBe(200);
    const detail = deserializeDocument<Any>(service.json()).data;
    expect(detail).toMatchObject({ id: ids.hidden, name: 'Partner backend' });
    expect(detail.incidents.map((i: Any) => i.title)).toEqual(['Backend outage']);
    expect(service.json().data.links.self).toBe(`/api/public/private-page/services/${ids.hiddenSlug}`);

    const day = await api(`/api/public/private-page/services/${ids.hiddenSlug}/days/${yesterday}`, page.token);
    expect(day.statusCode).toBe(200);
    const d = deserializeDocument<Any>(day.json()).data;
    expect(d).toMatchObject({ date: yesterday, status: 'major_outage', id: `${ids.hidden}:${yesterday}` });
    expect(d.segments.map((s: Any) => s.status)).toEqual(['operational', 'major_outage', 'operational']);
    expect(d.incidents.map((i: Any) => i.title)).toEqual(['Backend outage']);

    expect((await api(`/api/public/private-page/services/${ids.otherHidden}`, page.token)).statusCode).toBe(404);
    expect((await api(`/api/public/private-page/services/${ids.hiddenSlug}/days/2020-13-01`, page.token)).statusCode).toBe(400);
    expect((await api(`/api/public/private-page/services/${ids.hiddenSlug}/days/2001-01-01`, page.token)).statusCode).toBe(404);
    expect((await api(`/api/public/private-page/services/${ids.hiddenSlug}/days/${yesterday}`, newPrivatePageToken())).statusCode).toBe(404);
    // The main page still knows nothing about it.
    expect((await api(`/api/public/services/${ids.hiddenSlug}/days/${yesterday}`)).statusCode).toBe(404);
  });

  it('serves the page’s incidents and maintenance windows with only its own services', async () => {
    const page = await createPage({ name: 'Partner', serviceIds: [ids.hidden] });
    const other = await createPage({ name: 'Other', serviceIds: [ids.otherHidden] });
    const incident = data<Any>(
      await admin.post('/api/admin/incidents', {
        title: 'Backend outage',
        message: 'We are on it.',
        affectedServices: [
          { serviceId: ids.hidden, status: 'major_outage' },
          { serviceId: ids.publicService, status: 'partial_outage' },
        ],
      }),
    );
    const start = new Date(Date.now() + 86_400_000).toISOString();
    const end = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const maintenance = data<Any>(
      await admin.post('/api/admin/maintenances', {
        title: 'Backend upgrade',
        description: 'Planned.',
        scheduledStart: start,
        scheduledEnd: end,
        serviceIds: [ids.hidden],
      }),
    );

    const res = await api(`/api/public/private-page/incidents/${incident.id}`, page.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.json().data.links.self).toBe(`/api/public/private-page/incidents/${incident.id}`);
    const i = deserializeDocument<Any>(res.json()).data;
    expect(i).toMatchObject({ title: 'Backend outage' });
    expect(i.affectedServices.map((s: Any) => s.id)).toEqual([ids.hidden]);
    expect(i.updates.map((u: Any) => u.message)).toEqual(['We are on it.']);

    const m = await api(`/api/public/private-page/maintenances/${maintenance.id}`, page.token);
    expect(m.statusCode).toBe(200);
    expect(deserializeDocument<Any>(m.json()).data).toMatchObject({ title: 'Backend upgrade', affectedServices: [{ id: ids.hidden }] });

    // Not for another page, a wrong token or an unknown id: the same 404.
    const answers = [
      await api(`/api/public/private-page/incidents/${incident.id}`, other.token),
      await api(`/api/public/private-page/incidents/${incident.id}`, newPrivatePageToken()),
      await api(`/api/public/private-page/incidents/${incident.id}`),
      await api('/api/public/private-page/incidents/missing', page.token),
      await api(`/api/public/private-page/maintenances/${maintenance.id}`, other.token),
    ];
    for (const a of answers) {
      expect(a.statusCode).toBe(404);
      expect(a.body).toBe(answers[0]!.body);
    }
  });

  it('is rate limited per client', async () => {
    const token = newPrivatePageToken();
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await api('/api/public/private-page', token)).statusCode;
    expect(last).toBe(429);
  });
});

describe('log redaction', () => {
  it('replaces the token of private page paths in any spelling', () => {
    expect(redactPrivatePagePath('/p/abc/services/web?lang=de')).toBe('/p/[REDACTED]/services/web?lang=de');
    expect(redactPrivatePagePath('/P//abc')).toBe('/p/[REDACTED]');
    expect(redactPrivatePagePath('/%70/abc')).toBe('/p/[REDACTED]');
    // Encoded slashes and backslashes: the renderer's URL parser reads them as separators.
    expect(redactPrivatePagePath('/%2Fp/abc')).toBe('/p/[REDACTED]');
    expect(redactPrivatePagePath('/p%2Fabc?lang=de')).toBe('/p/[REDACTED]?lang=de');
    expect(redactPrivatePagePath('/%70%2Fabc/services/web')).toBe('/p/[REDACTED]/services/web');
    expect(redactPrivatePagePath('/p\\abc')).toBe('/p/[REDACTED]');
    expect(redactPrivatePagePath('/p%5Cabc')).toBe('/p/[REDACTED]');
    expect(redactPrivatePagePath('/p/%2F/abc')).toBe('/p/[REDACTED]');
    expect(redactPrivatePagePath('/p%2Fabc%E0')).toBe('/p/[REDACTED]');
    expect(redactPrivatePagePath('/p')).toBe('/p');
    expect(redactPrivatePagePath('/pages/abc')).toBe('/pages/abc');
    expect(redactPrivatePagePath('/history?return=/p/abc')).toBe('/history?return=/p/abc');
    expect(redactPrivatePagePath('/./p/abc?lang=de')).toBe('/p/[REDACTED]?lang=de');
    expect(redactPrivatePagePath('/a/../P/abc/services/web')).toBe('/p/[REDACTED]/services/web');
    expect(redactPrivatePagePath('/%2e/p/abc')).toBe('/p/[REDACTED]');
    expect(serializeRequest({ method: 'GET', url: '/p/abcdefghijklmnopqrstuvwxyz234567/services/x?token=1' }).url).toBe(
      '/p/[REDACTED]/services/x?token=[REDACTED]',
    );
  });

  it('never writes the token of a requested private page to the log', async () => {
    const lines: string[] = [];
    const app = await createTestAppWithLog(lines);
    const token = newPrivatePageToken();
    await app.app.inject({ method: 'GET', url: `/p/${token}/services/web` });
    // Paths as-is, with dot segments (inject() would resolve them).
    const { port } = new URL(await app.app.listen({ host: '127.0.0.1', port: 0 }));
    for (const path of [`/x/../p/${token}`, `/./p/${token}`, `/%2e/p/${token}`, `/p\\${token}`, `/p%2F${token}`, `/%2Fp/${token}`]) {
      await new Promise<void>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path }, (res) => res.resume().on('end', resolve));
        req.on('error', reject).end();
      });
    }
    await app.close();
    expect(lines.join('\n')).toContain('/p/[REDACTED]/services/web');
    expect(lines.join('\n')).not.toContain(token);
  });
});

async function createTestAppWithLog(lines: string[]): Promise<TestApp> {
  const { buildApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  const { createDb, migrateToLatest } = await import('../src/db/index.js');
  const config = loadConfig(
    { NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', SECRET_KEY: 'test-secret-key-that-is-long-enough-1234567890', BASE_URL, LOG_LEVEL: 'info' },
    { allowSqliteForAnyRole: true },
  );
  const db = await createDb(config);
  await migrateToLatest(db);
  const app = await buildApp({ config, db, serveWeb: false, logStream: { write: (line) => lines.push(line) } });
  await app.ready();
  return {
    app,
    db,
    config,
    async close() {
      await app.close();
      await db.destroy();
    },
  };
}
