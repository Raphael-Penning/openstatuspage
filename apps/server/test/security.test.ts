import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@openstatuspage/shared';
import { adminClient, client, createTestApp, createUser, login, page, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Client;

beforeEach(async () => {
  t = await createTestApp();
  admin = await adminClient(t);
});
afterEach(async () => {
  await t.close();
});

describe('monitoring credentials', () => {
  it('cannot be redirected to another host with the secret mask', async () => {
    const icinga = {
      name: 'Icinga',
      type: 'icinga2',
      config: { baseUrl: 'https://monitoring.example.com:5665', username: 'statuspage', password: 'super-secret-password' },
    };
    const source = (await admin.post('/api/admin/monitor-sources', icinga)).json();
    const url = `/api/admin/monitor-sources/${source.id}`;

    const otherHost = await admin.put(url, {
      ...icinga,
      config: { ...icinga.config, baseUrl: 'https://attacker.example.net', password: SECRET_MASK },
    });
    expect(otherHost.statusCode).toBe(400);
    const otherUser = await admin.put(url, { ...icinga, config: { ...icinga.config, username: 'x', password: SECRET_MASK } });
    expect(otherUser.statusCode).toBe(400);

    // Re-entering the password allows the change.
    const ok = await admin.put(url, { ...icinga, config: { ...icinga.config, baseUrl: 'https://mon2.example.com' } });
    expect(ok.statusCode).toBe(200);
  });
});

describe('api tokens', () => {
  async function tokenOf(c: Client, role: 'admin' | 'editor') {
    return (await c.post('/api/admin/api-tokens', { name: `t-${role}`, role })).json().token as string;
  }

  it('are revoked when their creator is deleted or loses the admin role', async () => {
    await createUser(t.db, { email: 'second@example.com', role: 'admin' });
    const second = client(t.app, { cookie: await login(t.app, 'second@example.com') });
    const adminToken = await tokenOf(second, 'admin');
    const editorToken = await tokenOf(second, 'editor');
    const asToken = (token: string) => client(t.app, { token }).get('/api/admin/overview');
    expect((await asToken(adminToken)).statusCode).toBe(200);

    const users = (await admin.get('/api/admin/users')).json() as { id: string; email: string }[];
    const secondId = users.find((u) => u.email === 'second@example.com')!.id;

    await admin.put(`/api/admin/users/${secondId}`, { role: 'editor' });
    expect((await asToken(adminToken)).statusCode).toBe(401);
    expect((await asToken(editorToken)).statusCode).toBe(200);

    expect((await admin.delete(`/api/admin/users/${secondId}`)).statusCode).toBe(204);
    expect((await asToken(editorToken)).statusCode).toBe(401);
  });
});

describe('public endpoints', () => {
  it('history location filter ignores hidden services', async () => {
    const fra = (await admin.post('/api/admin/locations', { name: 'Frankfurt', region: 'europe' })).json().id;
    const hidden = (await admin.post('/api/admin/services', { name: 'Internal', isPublic: false, locationIds: [fra] })).json().id;
    await admin.post('/api/admin/incidents', {
      title: 'Only internal',
      message: 'x',
      affectedServices: [{ serviceId: hidden, status: 'major_outage' }],
    });
    expect(page(await t.app.inject({ url: '/api/public/history' })).total).toBe(1);
    expect(page(await t.app.inject({ url: `/api/public/history?filter[location]=${fra}` })).total).toBe(0);
  });

  it('hides locations when the page disables them', async () => {
    expect((await t.app.inject({ url: '/api/public/locations' })).statusCode).toBe(200);
    const settings = (await admin.get('/api/admin/settings')).json();
    await admin.put('/api/admin/settings', { ...settings, showLocations: false });
    expect((await t.app.inject({ url: '/api/public/locations' })).statusCode).toBe(404);
  });

  it('feeds use readable, localized labels', async () => {
    await admin.post('/api/admin/maintenances', {
      title: 'Router upgrade',
      scheduledStart: '2026-01-10T10:00:00.000Z',
      scheduledEnd: '2026-01-10T12:00:00.000Z',
    });
    const en = (await t.app.inject({ url: '/feed.rss' })).body;
    expect(en).toContain('Status: Completed');
    expect(en).toContain('10 Jan 2026, 10:00 UTC');
    expect(en).not.toContain('in_progress');

    const settings = (await admin.get('/api/admin/settings')).json();
    await admin.put('/api/admin/settings', { ...settings, defaultLocale: 'de' });
    const de = (await t.app.inject({ url: '/feed.atom' })).body;
    expect(de).toContain('Status: Abgeschlossen');
  });
});
