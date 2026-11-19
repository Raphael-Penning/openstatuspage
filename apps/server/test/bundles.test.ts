import type { AdminCheckBundle, CheckState } from '@openstatuspage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUNDLE_SOURCE_ID, BUNDLE_TASK } from '../src/services/bundles.js';
import { newId } from '../src/lib/ids.js';
import { nowIso } from '../src/lib/time.js';
import { sha256 } from '../src/lib/crypto.js';
import { adminClient, client, createTestApp, createUser, data, login, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Client;

beforeEach(async () => {
  t = await createTestApp();
  admin = await adminClient(t);
});

afterEach(async () => {
  await t.close();
});

/** An Uptime Kuma node (pull source) with one check "Website". */
async function kumaNode(name: string, state: CheckState = 'ok'): Promise<{ sourceId: string; checkId: string }> {
  const sourceId = newId();
  const now = nowIso();
  await t.db
    .insertInto('monitor_sources')
    .values({
      id: sourceId,
      name,
      type: 'uptimekuma',
      enabled: 1,
      config_encrypted: t.app.ctx.secrets.encryptJson({ baseUrl: 'https://kuma.example.com', apiKey: 'secret-key' }),
      poll_interval_seconds: 60,
      ingest_token_hash: sha256(`token-${name}`),
      last_poll_at: now,
      last_poll_ok: 1,
      last_error: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await t.app.ctx.ingest.ingest(sourceId, [{ externalId: 'Website', name: 'Website', host: 'www.example.com', state }], {
    full: false,
  });
  const check = await t.db.selectFrom('monitor_checks').select('id').where('source_id', '=', sourceId).executeTakeFirstOrThrow();
  return { sourceId, checkId: check.id };
}

const push = (sourceId: string, state: CheckState) =>
  t.app.ctx.ingest.ingest(sourceId, [{ externalId: 'Website', state }], { full: false });

async function bundleCheck(bundle: AdminCheckBundle) {
  return t.db.selectFrom('monitor_checks').selectAll().where('id', '=', bundle.checkId).executeTakeFirstOrThrow();
}

async function serviceStatus(id: string): Promise<string> {
  return (await t.db.selectFrom('services').select('current_status').where('id', '=', id).executeTakeFirstOrThrow()).current_status;
}

describe('check bundles', () => {
  it('votes with weights and drives linked services like any check', async () => {
    const a = await kumaNode('Kuma FRA');
    const b = await kumaNode('Kuma AMS');
    const c = await kumaNode('Kuma NYC');

    const res = await admin.post('/api/admin/check-bundles', {
      name: 'Website',
      description: 'Website seen from three places',
      members: [
        { checkId: a.checkId, votes: 2 },
        { checkId: b.checkId },
        { checkId: c.checkId, votes: 1 },
      ],
    });
    expect(res.statusCode).toBe(201);
    const bundle = res.json<AdminCheckBundle>();
    expect(bundle.vote).toMatchObject({ state: 'ok', totalVotes: 4, reportingVotes: 4 });
    expect(bundle.members).toHaveLength(3);
    expect(bundle.members.every((m) => m.reporting && m.reason === 'reporting')).toBe(true);
    expect(bundle.members.find((m) => m.checkId === b.checkId)!.votes).toBe(1);

    // The bundle is a check of the virtual source and can be linked to a service.
    const check = await bundleCheck(bundle);
    expect(check).toMatchObject({ source_id: BUNDLE_SOURCE_ID, name: 'Website', state: 'ok' });
    const svc = data<{ id: string }>(await admin.post('/api/admin/services', { name: 'Website', checks: [{ checkId: bundle.checkId }] }));
    expect(await serviceStatus(svc.id)).toBe('operational');

    // 2 of 4 votes down (the heavy node): exactly half, no majority.
    await push(a.sourceId, 'critical');
    expect((await bundleCheck(bundle)).state).toBe('ok');
    expect(await serviceStatus(svc.id)).toBe('operational');

    // 3 of 4 votes down.
    await push(b.sourceId, 'critical');
    expect((await bundleCheck(bundle)).state).toBe('critical');
    expect((await bundleCheck(bundle)).output).toBe('critical: 3 of 4 reporting votes down, 0 warning');
    expect(await serviceStatus(svc.id)).toBe('major_outage');

    // Recovery of one light node: 2 of 4 again.
    await push(b.sourceId, 'ok');
    expect(await serviceStatus(svc.id)).toBe('operational');

    // Pending (warning) + critical together have the majority: degraded.
    await push(b.sourceId, 'warning');
    expect((await bundleCheck(bundle)).state).toBe('warning');
    expect(await serviceStatus(svc.id)).toBe('degraded');
  });

  it('drops nodes that do not report from the base', async () => {
    const a = await kumaNode('Kuma FRA');
    const b = await kumaNode('Kuma AMS');
    const c = await kumaNode('Kuma NYC');
    const bundle = (
      await admin.post('/api/admin/check-bundles', {
        name: 'Website',
        members: [{ checkId: a.checkId }, { checkId: b.checkId }, { checkId: c.checkId }],
      })
    ).json<AdminCheckBundle>();
    await push(a.sourceId, 'critical');
    expect((await bundleCheck(bundle)).state).toBe('ok');

    // Node B's poll fails: 1 of 2 reporting votes down, still no majority.
    await t.app.ctx.ingest.recordPoll(b.sourceId, false, 'timeout');
    let view = (await admin.get(`/api/admin/check-bundles/${bundle.id}`)).json<AdminCheckBundle>();
    expect(view.vote).toMatchObject({ state: 'ok', reportingVotes: 2, criticalVotes: 1 });
    expect(view.members.find((m) => m.checkId === b.checkId)).toMatchObject({ reporting: false, reason: 'poll_failed' });

    // Node C goes silent: neither a recent poll nor a recent result (the worker
    // re-evaluates periodically): 1 of 1 down.
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    await t.db.updateTable('monitor_checks').set({ last_check_at: old }).where('id', '=', c.checkId).execute();
    await t.db.updateTable('monitor_sources').set({ last_poll_at: old }).where('id', '=', c.sourceId).execute();
    await t.app.ctx.worker.schedule(BUNDLE_TASK, 60_000, async () => t.app.ctx.bundles.recompute());
    await t.app.ctx.worker.runNow(BUNDLE_TASK);
    t.app.ctx.worker.unschedule(BUNDLE_TASK);
    view = (await admin.get(`/api/admin/check-bundles/${bundle.id}`)).json<AdminCheckBundle>();
    expect(view.members.find((m) => m.checkId === c.checkId)).toMatchObject({ reporting: false, reason: 'stale' });
    expect((await bundleCheck(bundle)).state).toBe('critical');

    // A fresh poll result brings C back.
    await push(c.sourceId, 'ok');
    expect((await bundleCheck(bundle)).state).toBe('ok');

    // Disabling a source through the admin API takes it out of the vote.
    const src = (await admin.get(`/api/admin/monitor-sources/${c.sourceId}`)).json();
    const put = await admin.put(`/api/admin/monitor-sources/${c.sourceId}`, {
      name: src.name,
      type: 'uptimekuma',
      enabled: false,
      pollIntervalSeconds: 60,
      config: { ...src.config },
    });
    expect(put.statusCode).toBe(200);
    expect((await bundleCheck(bundle)).state).toBe('critical');
  });

  it('keeps pull members with an old check run but a fresh successful poll in the vote', async () => {
    // Icinga 2 style: heavy node A is fine, its check last ran 6 minutes ago (5-minute
    // check interval), but the source polled successfully a moment ago.
    const a = await kumaNode('Icinga FRA');
    const b = await kumaNode('Kuma AMS', 'critical');
    const c = await kumaNode('Kuma NYC', 'critical');
    const bundle = (
      await admin.post('/api/admin/check-bundles', {
        name: 'Website',
        members: [{ checkId: a.checkId, votes: 2 }, { checkId: b.checkId }, { checkId: c.checkId }],
      })
    ).json<AdminCheckBundle>();
    expect(bundle.vote).toMatchObject({ state: 'ok', reportingVotes: 4 });

    const ranAt = new Date(Date.now() - 6 * 60_000).toISOString();
    await t.db.updateTable('monitor_checks').set({ last_check_at: ranAt }).where('id', '=', a.checkId).execute();
    await t.app.ctx.bundles.recompute();
    const view = (await admin.get(`/api/admin/check-bundles/${bundle.id}`)).json<AdminCheckBundle>();
    expect(view.members.find((m) => m.checkId === a.checkId)).toMatchObject({ reporting: true, reason: 'reporting' });
    expect((await bundleCheck(bundle)).state).toBe('ok');
  });

  it('re-evaluates once per poll: ingest on the poll path defers to recordPoll', async () => {
    const a = await kumaNode('Kuma FRA');
    const bundle = (await admin.post('/api/admin/check-bundles', { name: 'Web', members: [{ checkId: a.checkId }] })).json<AdminCheckBundle>();
    await t.app.ctx.ingest.ingest(a.sourceId, [{ externalId: 'Website', state: 'critical' }], {
      full: true,
      deferBundleRecompute: true,
    });
    expect((await bundleCheck(bundle)).state).toBe('ok');
    await t.app.ctx.ingest.recordPoll(a.sourceId, true);
    expect((await bundleCheck(bundle)).state).toBe('critical');
  });

  it('serialises concurrent re-evaluations and skips writes when nothing changed', async () => {
    const a = await kumaNode('Kuma FRA');
    const bundle = (await admin.post('/api/admin/check-bundles', { name: 'Web', members: [{ checkId: a.checkId }] })).json<AdminCheckBundle>();
    const before = await bundleCheck(bundle);
    await Promise.all([t.app.ctx.bundles.recompute(), t.app.ctx.bundles.recompute(), push(a.sourceId, 'critical')]);
    const after = await bundleCheck(bundle);
    expect(after.state).toBe('critical');
    await t.app.ctx.bundles.recompute();
    // Unchanged: only the evaluation time moves.
    const again = await bundleCheck(bundle);
    expect(again.updated_at).toBe(after.updated_at);
    expect(again.last_state_change_at).toBe(after.last_state_change_at);
    expect(before.state).toBe('ok');
  });

  it('is unknown when no member reports', async () => {
    const a = await kumaNode('Kuma FRA', 'unknown');
    const bundle = (await admin.post('/api/admin/check-bundles', { name: 'X', members: [{ checkId: a.checkId }] })).json<AdminCheckBundle>();
    expect(bundle.vote.state).toBe('unknown');
    expect((await bundleCheck(bundle)).state).toBe('unknown');
    const empty = (await admin.post('/api/admin/check-bundles', { name: 'Empty' })).json<AdminCheckBundle>();
    expect(empty.vote).toMatchObject({ state: 'unknown', totalVotes: 0 });
  });

  it('updates members and votes, renames the bundle check and recomputes', async () => {
    const a = await kumaNode('Kuma FRA', 'critical');
    const b = await kumaNode('Kuma AMS');
    const bundle = (
      await admin.post('/api/admin/check-bundles', { name: 'Old', members: [{ checkId: a.checkId }, { checkId: b.checkId }] })
    ).json<AdminCheckBundle>();
    expect(bundle.vote.state).toBe('ok');

    const res = await admin.put(`/api/admin/check-bundles/${bundle.id}`, {
      name: 'New',
      members: [{ checkId: a.checkId, votes: 2 }, { checkId: b.checkId }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<AdminCheckBundle>()).toMatchObject({ name: 'New', vote: { state: 'critical', totalVotes: 3 } });
    expect(await bundleCheck(bundle)).toMatchObject({ name: 'New', state: 'critical' });

    // Removing a member check (full sync) removes the membership and re-evaluates.
    await t.db.updateTable('monitor_sources').set({ type: 'webhook' }).where('id', '=', a.sourceId).execute();
    await t.app.ctx.ingest.ingest(a.sourceId, [{ externalId: 'Other', state: 'ok' }], { full: true });
    const after = (await admin.get(`/api/admin/check-bundles/${bundle.id}`)).json<AdminCheckBundle>();
    expect(after.members.map((m) => m.checkId)).toEqual([b.checkId]);
    expect((await bundleCheck(bundle)).state).toBe('ok');
  });

  it('a check may belong to several bundles', async () => {
    const a = await kumaNode('Kuma FRA');
    const b = await kumaNode('Kuma AMS');
    const one = (await admin.post('/api/admin/check-bundles', { name: 'One', members: [{ checkId: a.checkId }] })).json<AdminCheckBundle>();
    const two = (
      await admin.post('/api/admin/check-bundles', { name: 'Two', members: [{ checkId: a.checkId }, { checkId: b.checkId, votes: 3 }] })
    ).json<AdminCheckBundle>();
    await push(a.sourceId, 'critical');
    expect((await bundleCheck(one)).state).toBe('critical');
    expect((await bundleCheck(two)).state).toBe('ok');
    expect((await admin.get('/api/admin/check-bundles')).json<AdminCheckBundle[]>().map((x) => x.name)).toEqual(['One', 'Two']);
  });

  it('validates input', async () => {
    const a = await kumaNode('Kuma FRA');
    expect((await admin.post('/api/admin/check-bundles', { name: '' })).statusCode).toBe(400);
    expect((await admin.post('/api/admin/check-bundles', { name: 'X', members: [{ checkId: a.checkId, votes: 0 }] })).statusCode).toBe(400);
    expect((await admin.post('/api/admin/check-bundles', { name: 'X', members: [{ checkId: a.checkId, votes: 1.5 }] })).statusCode).toBe(400);
    expect(
      (await admin.post('/api/admin/check-bundles', { name: 'X', members: [{ checkId: a.checkId }, { checkId: a.checkId }] })).statusCode,
    ).toBe(400);
    expect((await admin.post('/api/admin/check-bundles', { name: 'X', members: [{ checkId: 'missing' }] })).statusCode).toBe(400);
    // No nesting: the check of a bundle cannot be a member.
    const inner = (await admin.post('/api/admin/check-bundles', { name: 'Inner', members: [{ checkId: a.checkId }] })).json<AdminCheckBundle>();
    const nested = await admin.post('/api/admin/check-bundles', { name: 'Outer', members: [{ checkId: inner.checkId }] });
    expect(nested.statusCode).toBe(400);
    expect((await admin.put('/api/admin/check-bundles/missing', { name: 'X' })).statusCode).toBe(404);
    expect((await admin.get('/api/admin/check-bundles/missing')).statusCode).toBe(404);
  });

  it('deletes bundles with their check and service links, and audits every change', async () => {
    const a = await kumaNode('Kuma FRA', 'critical');
    const bundle = (await admin.post('/api/admin/check-bundles', { name: 'Web', members: [{ checkId: a.checkId }] })).json<AdminCheckBundle>();
    const svc = data<{ id: string }>(await admin.post('/api/admin/services', { name: 'Web', checks: [{ checkId: bundle.checkId }] }));
    expect(await serviceStatus(svc.id)).toBe('major_outage');
    await admin.put(`/api/admin/check-bundles/${bundle.id}`, { name: 'Web', members: [{ checkId: a.checkId, votes: 2 }] });

    expect((await admin.delete(`/api/admin/check-bundles/${bundle.id}`)).statusCode).toBe(204);
    expect(await t.db.selectFrom('monitor_checks').select('id').where('id', '=', bundle.checkId).executeTakeFirst()).toBeUndefined();
    expect(await t.db.selectFrom('check_bundle_members').selectAll().execute()).toEqual([]);
    expect(await serviceStatus(svc.id)).toBe('operational');
    expect((await admin.delete(`/api/admin/check-bundles/${bundle.id}`)).statusCode).toBe(404);

    const actions = (
      await t.db.selectFrom('audit_log').select('action').where('entity_type', '=', 'check_bundle').orderBy('created_at').execute()
    ).map((r) => r.action);
    expect(actions).toEqual(['check_bundle.create', 'check_bundle.update', 'check_bundle.delete']);
  });

  it('lists candidate checks grouped by source, without the bundle source', async () => {
    const a = await kumaNode('Kuma FRA');
    await admin.post('/api/admin/check-bundles', { name: 'Web', members: [{ checkId: a.checkId }] });
    const all = (await admin.get('/api/admin/check-bundles/candidates')).json();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: a.sourceId, name: 'Kuma FRA', type: 'uptimekuma', enabled: true });
    expect(all[0].checks).toEqual([
      expect.objectContaining({ id: a.checkId, name: 'Website', host: 'www.example.com', state: 'ok' }),
    ]);
    expect((await admin.get('/api/admin/check-bundles/candidates?type=icinga2')).json()).toEqual([]);
    expect((await admin.get('/api/admin/check-bundles/candidates?type=bundle')).statusCode).toBe(400);
  });

  it('is admin only', async () => {
    await createUser(t.db, { email: 'editor@example.com', role: 'editor' });
    const editor = client(t.app, { cookie: await login(t.app, 'editor@example.com') });
    expect((await editor.get('/api/admin/check-bundles')).statusCode).toBe(403);
    expect((await editor.get('/api/admin/check-bundles/candidates')).statusCode).toBe(403);
    expect((await editor.post('/api/admin/check-bundles', { name: 'X' })).statusCode).toBe(403);
    const anonymous = client(t.app, {});
    expect((await anonymous.get('/api/admin/check-bundles')).statusCode).toBe(401);
  });
});

describe('bundles and other views', () => {
  it('rejects a full push that would remove most bundle member checks', async () => {
    const a = await kumaNode('Kuma FRA');
    await t.db.updateTable('monitor_sources').set({ type: 'webhook' }).where('id', '=', a.sourceId).execute();
    await t.app.ctx.ingest.ingest(a.sourceId, [{ externalId: 'Shop', state: 'ok' }], { full: false });
    await admin.post('/api/admin/check-bundles', { name: 'Web', members: [{ checkId: a.checkId }] });
    await expect(
      t.app.ctx.ingest.ingest(a.sourceId, [{ externalId: 'Shop', state: 'ok' }], { full: true, guardLinkedChecks: true }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await t.db.selectFrom('check_bundle_members').select('check_id').execute()).toEqual([{ check_id: a.checkId }]);
  });

  it('leaves the bundle source and its checks out of the overview counts', async () => {
    const a = await kumaNode('Kuma FRA', 'critical');
    await admin.post('/api/admin/check-bundles', { name: 'Web', members: [{ checkId: a.checkId }] });
    const counts = data<{ counts: Record<string, number> }>(await admin.get('/api/admin/overview')).counts;
    expect(counts).toMatchObject({ sources: 1, checks: 1, checksFailing: 1 });
  });

  it('marks bundle checks in the check list', async () => {
    const a = await kumaNode('Kuma FRA');
    const bundle = (await admin.post('/api/admin/check-bundles', { name: 'Web', members: [{ checkId: a.checkId }] })).json<AdminCheckBundle>();
    const checks = (await admin.get('/api/admin/checks')).json();
    expect(checks.find((c: { id: string }) => c.id === bundle.checkId)).toMatchObject({ sourceType: 'bundle' });
    expect(checks.find((c: { id: string }) => c.id === a.checkId)).toMatchObject({ sourceType: 'uptimekuma' });
  });
});

describe('virtual bundle source', () => {
  it('cannot be edited, pushed to, polled or deleted while bundles exist', async () => {
    const a = await kumaNode('Kuma FRA');
    const bundle = (await admin.post('/api/admin/check-bundles', { name: 'Web', members: [{ checkId: a.checkId }] })).json<AdminCheckBundle>();

    const sources = (await admin.get('/api/admin/monitor-sources')).json();
    expect(sources.find((s: { id: string }) => s.id === BUNDLE_SOURCE_ID)).toMatchObject({ type: 'bundle', checkCount: 1 });

    const put = await admin.put(`/api/admin/monitor-sources/${BUNDLE_SOURCE_ID}`, { name: 'Hijack', type: 'webhook', config: {} });
    expect(put.statusCode).toBe(409);
    expect((await admin.post(`/api/admin/monitor-sources/${BUNDLE_SOURCE_ID}/rotate-token`)).statusCode).toBe(409);
    expect((await admin.post(`/api/admin/monitor-sources/${BUNDLE_SOURCE_ID}/test`)).statusCode).toBe(400);
    expect((await admin.post(`/api/admin/monitor-sources/${BUNDLE_SOURCE_ID}/poll`)).statusCode).toBe(400);
    expect((await admin.delete(`/api/admin/checks/${bundle.checkId}`)).statusCode).toBe(409);
    expect((await admin.delete(`/api/admin/monitor-sources/${BUNDLE_SOURCE_ID}`)).statusCode).toBe(409);

    // Ingest is rejected (even if someone had a valid token).
    await t.db.updateTable('monitor_sources').set({ ingest_token_hash: sha256('known') }).where('id', '=', BUNDLE_SOURCE_ID).execute();
    const ingest = await t.app.inject({
      method: 'POST',
      url: `/api/ingest/${BUNDLE_SOURCE_ID}`,
      headers: { authorization: 'Bearer known' },
      payload: { checks: [{ id: bundle.id, state: 'critical' }] },
    });
    expect(ingest.statusCode).toBe(409);
    expect((await bundleCheck(bundle)).state).toBe('ok');

    // Without bundles the source may go (it is created again on demand).
    await admin.delete(`/api/admin/check-bundles/${bundle.id}`);
    expect((await admin.delete(`/api/admin/monitor-sources/${BUNDLE_SOURCE_ID}`)).statusCode).toBe(204);
    const again = await admin.post('/api/admin/check-bundles', { name: 'Again', members: [{ checkId: a.checkId }] });
    expect(again.statusCode).toBe(201);
  });

  it('removes memberships when a member source is deleted', async () => {
    const a = await kumaNode('Kuma FRA', 'critical');
    const b = await kumaNode('Kuma AMS');
    const bundle = (
      await admin.post('/api/admin/check-bundles', { name: 'Web', members: [{ checkId: a.checkId, votes: 2 }, { checkId: b.checkId }] })
    ).json<AdminCheckBundle>();
    expect((await bundleCheck(bundle)).state).toBe('critical');
    expect((await admin.delete(`/api/admin/monitor-sources/${a.sourceId}`)).statusCode).toBe(204);
    expect((await bundleCheck(bundle)).state).toBe('ok');
  });

  it('never exposes bundles on public endpoints', async () => {
    const a = await kumaNode('Kuma FRA', 'critical');
    const bundle = (await admin.post('/api/admin/check-bundles', { name: 'Secret bundle', members: [{ checkId: a.checkId }] })).json<AdminCheckBundle>();
    await admin.post('/api/admin/services', { name: 'Web', checks: [{ checkId: bundle.checkId }] });
    const res = await t.app.inject({ method: 'GET', url: '/api/public/summary' });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toContain('major_outage');
    expect(body).not.toContain('Secret bundle');
    expect(body).not.toContain('Kuma FRA');
    expect(body).not.toContain('votes');
  });
});
