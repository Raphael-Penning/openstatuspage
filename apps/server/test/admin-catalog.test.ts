import { SECRET_MASK } from '@openstatuspage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminClient, createTestApp, seedChecks, setCheckState, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Client;
beforeEach(async () => {
  t = await createTestApp();
  admin = await adminClient(t);
});
afterEach(async () => {
  await t.close();
});

describe('locations', () => {
  it('supports CRUD, slug generation and reordering', async () => {
    const a = await admin.post('/api/admin/locations', {
      name: 'Frankfurt',
      code: 'FRA-1',
      country: 'DE',
      region: 'europe',
      latitude: 50.1,
      longitude: 8.7,
    });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ slug: 'frankfurt', status: 'operational', serviceIds: [], isPublic: true });

    const b = await admin.post('/api/admin/locations', { name: 'Frankfurt', region: 'europe' });
    expect(b.json().slug).toBe('frankfurt-2');

    const dup = await admin.post('/api/admin/locations', { name: 'X', slug: 'frankfurt', region: 'europe' });
    expect(dup.statusCode).toBe(409);

    const invalid = await admin.post('/api/admin/locations', { name: 'X', region: 'mars' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('validation_error');

    const updated = await admin.put(`/api/admin/locations/${a.json().id}`, {
      name: 'Frankfurt am Main',
      region: 'europe',
      statusOverride: 'maintenance',
    });
    expect(updated.statusCode).toBe(200);
    // Slug is kept when not provided.
    expect(updated.json()).toMatchObject({ slug: 'frankfurt', name: 'Frankfurt am Main', status: 'maintenance' });

    expect((await admin.post('/api/admin/locations/reorder', { ids: [b.json().id, a.json().id] })).statusCode).toBe(204);
    const list = await admin.get('/api/admin/locations');
    expect(list.json().map((l: { id: string }) => l.id)).toEqual([b.json().id, a.json().id]);

    expect((await admin.delete(`/api/admin/locations/${a.json().id}`)).statusCode).toBe(204);
    expect((await admin.get(`/api/admin/locations/${a.json().id}`)).statusCode).toBe(404);

    const audit = await admin.get('/api/admin/audit-log?entityType=location');
    // Entries within the same millisecond have no defined order, so compare sorted.
    expect(audit.json().items.map((e: { action: string }) => e.action).sort()).toEqual([
      'location.create',
      'location.create',
      'location.delete',
      'location.reorder',
      'location.update',
    ]);
  });
});

describe('service groups', () => {
  it('deleting a group keeps its services (group_id becomes null)', async () => {
    const group = (await admin.post('/api/admin/service-groups', { name: 'Platform' })).json();
    expect(group).toMatchObject({ slug: 'platform', isPublic: true, collapsedByDefault: false });
    const svc = (await admin.post('/api/admin/services', { name: 'API', groupId: group.id })).json();
    expect(svc.groupId).toBe(group.id);

    const renamed = await admin.put(`/api/admin/service-groups/${group.id}`, { name: 'Core', collapsedByDefault: true });
    expect(renamed.json()).toMatchObject({ name: 'Core', slug: 'platform', collapsedByDefault: true });

    expect((await admin.delete(`/api/admin/service-groups/${group.id}`)).statusCode).toBe(204);
    const after = (await admin.get(`/api/admin/services/${svc.id}`)).json();
    expect(after.groupId).toBeNull();
  });
});

describe('services', () => {
  it('builds services from checks and recomputes status', async () => {
    const { sourceId, checkIds } = await seedChecks(t, [
      { externalId: 'web1!https', name: 'HTTPS', host: 'web1.internal.example.com', state: 'ok' },
      { externalId: 'web2!https', name: 'HTTPS', host: 'web2.internal.example.com', state: 'ok' },
    ]);
    const loc = (await admin.post('/api/admin/locations', { name: 'Amsterdam', region: 'europe' })).json();

    const created = await admin.post('/api/admin/services', {
      name: 'Web App',
      kind: 'site',
      url: 'https://app.example.com',
      aggregation: 'quorum',
      locationIds: [loc.id],
      checks: [{ checkId: checkIds['web1!https'] }, { checkId: checkIds['web2!https'], criticalStatus: 'major_outage' }],
    });
    expect(created.statusCode).toBe(201);
    const svc = created.json();
    expect(svc).toMatchObject({ slug: 'web-app', status: 'operational', monitorStatus: 'operational', locationIds: [loc.id] });
    expect(svc.checks).toHaveLength(2);
    expect(svc.checks[0]).toMatchObject({ warningStatus: 'degraded', criticalStatus: 'major_outage', unknownStatus: null });
    expect(svc.checks[0].check).toMatchObject({ sourceName: 'Internal monitoring', serviceCount: 1 });

    // One of two redundant checks fails → quorum caps at partial outage.
    await setCheckState(t, sourceId, { externalId: 'web1!https', name: 'HTTPS', host: 'web1.internal.example.com' }, 'critical');
    let current = (await admin.get(`/api/admin/services/${svc.id}`)).json();
    expect(current.status).toBe('partial_outage');

    const preview = await admin.get(`/api/admin/services/${svc.id}/preview`);
    expect(preview.json()).toEqual({ monitorStatus: 'partial_outage', status: 'partial_outage' });

    // Preview of an unsaved config with "worst" aggregation.
    const unsaved = await admin.post('/api/admin/services/preview', {
      name: 'Web App',
      aggregation: 'worst',
      checks: [{ checkId: checkIds['web1!https'] }],
    });
    expect(unsaved.json()).toEqual({ monitorStatus: 'major_outage' });

    // Switching to manual mode overrides the checks.
    const manual = await admin.put(`/api/admin/services/${svc.id}`, {
      name: 'Web App',
      statusMode: 'manual',
      manualStatus: 'degraded',
      checks: [{ checkId: checkIds['web1!https'] }],
    });
    expect(manual.statusCode).toBe(200);
    expect(manual.json()).toMatchObject({ status: 'degraded', monitorStatus: 'major_outage', locationIds: [] });

    // Checks: filters and deletion.
    const unlinked = await admin.get('/api/admin/checks?unlinked=true');
    expect(unlinked.json().map((c: { externalId: string }) => c.externalId)).toEqual(['web2!https']);
    const search = await admin.get('/api/admin/checks?q=WEB1.internal');
    expect(search.json()).toHaveLength(1);
    const critical = await admin.get(`/api/admin/checks?state=critical&sourceId=${sourceId}`);
    expect(critical.json()).toHaveLength(1);

    await admin.put(`/api/admin/services/${svc.id}`, { name: 'Web App', checks: [{ checkId: checkIds['web1!https'] }] });
    current = (await admin.get(`/api/admin/services/${svc.id}`)).json();
    expect(current.status).toBe('major_outage');
    expect((await admin.delete(`/api/admin/checks/${checkIds['web1!https']}`)).statusCode).toBe(204);
    current = (await admin.get(`/api/admin/services/${svc.id}`)).json();
    expect(current).toMatchObject({ status: 'operational', checks: [] });
  });

  it('validates references and supports reorder within a group', async () => {
    const bad = await admin.post('/api/admin/services', { name: 'X', checks: [{ checkId: 'missing' }] });
    expect(bad.statusCode).toBe(400);
    const badGroup = await admin.post('/api/admin/services', { name: 'X', groupId: 'missing' });
    expect(badGroup.statusCode).toBe(400);

    const g1 = (await admin.post('/api/admin/service-groups', { name: 'One' })).json();
    const g2 = (await admin.post('/api/admin/service-groups', { name: 'Two' })).json();
    const a = (await admin.post('/api/admin/services', { name: 'A', groupId: g1.id })).json();
    const b = (await admin.post('/api/admin/services', { name: 'B', groupId: g1.id })).json();
    const c = (await admin.post('/api/admin/services', { name: 'C', groupId: g2.id })).json();
    expect((await admin.post('/api/admin/services/reorder', { ids: [a.id, c.id] })).statusCode).toBe(400);
    expect((await admin.post('/api/admin/services/reorder', { ids: [b.id, a.id] })).statusCode).toBe(204);
    const list = (await admin.get('/api/admin/services')).json() as { id: string }[];
    expect(list.map((s) => s.id)).toEqual([b.id, a.id, c.id]);

    expect((await admin.delete(`/api/admin/services/${a.id}`)).statusCode).toBe(204);
    expect((await admin.get(`/api/admin/services/${a.id}`)).statusCode).toBe(404);
  });

  it('reports an overview', async () => {
    await seedChecks(t, [{ externalId: 'a', name: 'A', host: 'h', state: 'critical' }]);
    await admin.post('/api/admin/services', { name: 'Fine' });
    const res = await admin.get('/api/admin/overview');
    expect(res.statusCode).toBe(200);
    expect(res.json().counts).toEqual({
      services: 1,
      incidentsActive: 0,
      maintenancesActive: 0,
      maintenancesUpcoming: 0,
      sources: 1,
      sourcesFailing: 0,
      checks: 1,
      checksFailing: 1,
    });
    expect(res.json().recentAudit.map((e: { action: string }) => e.action)).toContain('service.create');
  });
});

describe('settings', () => {
  it('validates and stores settings', async () => {
    const res = await admin.put('/api/admin/settings', { siteName: 'Example Status', uptimeDays: 30 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ siteName: 'Example Status', uptimeDays: 30, showUptime: true });
    expect((await admin.put('/api/admin/settings', { siteName: '' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/public/settings' })).json().siteName).toBe('Example Status');
  });
});

describe('monitoring sources', () => {
  const icinga = {
    name: 'Icinga',
    type: 'icinga2',
    config: {
      baseUrl: 'https://monitoring.example.com:5665',
      username: 'statuspage',
      password: 'super-secret-password',
    },
  };

  it('encrypts and masks secrets, keeps them when the mask is sent back', async () => {
    const created = await admin.post('/api/admin/monitor-sources', icinga);
    expect(created.statusCode).toBe(201);
    const source = created.json();
    expect(source.ingestToken).toEqual(expect.any(String));
    expect(source.config.password).toBe(SECRET_MASK);
    expect(source.config.username).toBe('statuspage');
    expect(source.ingestUrl).toBe(`https://status.example.com/api/ingest/${source.id}`);
    expect(created.body).not.toContain('super-secret-password');

    const row = await t.db.selectFrom('monitor_sources').selectAll().where('id', '=', source.id).executeTakeFirstOrThrow();
    expect(row.config_encrypted).not.toContain('super-secret-password');
    expect(row.ingest_token_hash).not.toBe(source.ingestToken);

    const list = await admin.get('/api/admin/monitor-sources');
    expect(list.body).not.toContain('super-secret-password');
    expect(list.body).not.toContain(source.ingestToken);

    // Update with the mask keeps the stored password.
    const updated = await admin.put(`/api/admin/monitor-sources/${source.id}`, {
      ...icinga,
      name: 'Icinga (primary)',
      config: { ...icinga.config, password: SECRET_MASK, includeHosts: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: 'Icinga (primary)', config: { password: SECRET_MASK, includeHosts: false } });
    const stored = t.app.ctx.secrets.decryptJson<Record<string, unknown>>(
      (await t.db.selectFrom('monitor_sources').select('config_encrypted').where('id', '=', source.id).executeTakeFirstOrThrow())
        .config_encrypted,
    );
    expect(stored.password).toBe('super-secret-password');

    // Changing the type requires new credentials.
    const typeChange = await admin.put(`/api/admin/monitor-sources/${source.id}`, {
      name: 'Kuma',
      type: 'uptimekuma',
      config: { baseUrl: 'https://kuma.example.com', apiKey: SECRET_MASK },
    });
    expect(typeChange.statusCode).toBe(400);

    // The mask is not accepted as a real secret on create.
    const masked = await admin.post('/api/admin/monitor-sources', {
      ...icinga,
      config: { ...icinga.config, password: SECRET_MASK },
    });
    expect(masked.statusCode).toBe(400);

    const rotated = await admin.post(`/api/admin/monitor-sources/${source.id}/rotate-token`);
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().ingestToken).not.toBe(source.ingestToken);

    const audit = await admin.get('/api/admin/audit-log?entityType=monitor_source');
    expect(audit.body).not.toContain('super-secret-password');
    expect(audit.body).not.toContain(rotated.json().ingestToken);

    expect((await admin.delete(`/api/admin/monitor-sources/${source.id}`)).statusCode).toBe(204);
    expect((await admin.get(`/api/admin/monitor-sources/${source.id}`)).statusCode).toBe(404);
  });

  it('disabling a source removes the influence of its checks', async () => {
    const created = (await admin.post('/api/admin/monitor-sources', { name: 'Hook', type: 'webhook', config: {} })).json();
    await t.app.ctx.ingest.ingest(created.id, [{ externalId: 'x', name: 'X', host: 'h', state: 'critical' }], { full: false });
    const check = (await admin.get(`/api/admin/checks?sourceId=${created.id}`)).json()[0];
    const svc = (await admin.post('/api/admin/services', { name: 'S', checks: [{ checkId: check.id }] })).json();
    expect(svc.status).toBe('major_outage');

    await admin.put(`/api/admin/monitor-sources/${created.id}`, { name: 'Hook', type: 'webhook', config: {}, enabled: false });
    expect((await admin.get(`/api/admin/services/${svc.id}`)).json().status).toBe('operational');

    await admin.put(`/api/admin/monitor-sources/${created.id}`, { name: 'Hook', type: 'webhook', config: {}, enabled: true });
    expect((await admin.get(`/api/admin/services/${svc.id}`)).json().status).toBe('major_outage');

    await admin.delete(`/api/admin/monitor-sources/${created.id}`);
    expect((await admin.get(`/api/admin/services/${svc.id}`)).json()).toMatchObject({ status: 'operational', checks: [] });
  });
});
