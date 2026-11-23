/**
 * Webhook and SMS subscriptions on PostgreSQL with the restricted public role
 * (migration 0015): the public role reads none of the new tables and writes only
 * through the osp_public functions, which enforce the admin's channel options.
 */
import { JSONAPI_MEDIA_TYPE, toRequestDocument } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { DB } from '../src/db/index.js';
import type { SafeResponse } from '../src/lib/safe-http.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { channelCode, targetBox } from '../src/services/channels/subscriptions.js';
import { prepareDatabase } from '../src/startup.js';
import { createTestDatabase, type PgTestDatabase } from './setup.js';

const NOW = new Date().toISOString();
const log = { info: () => undefined, warn: () => undefined };

let pgdb: PgTestDatabase;
let owner: DB;
let pub: DB;
let publicApp: FastifyInstance;
let workerApp: FastifyInstance;
const sent: { url: string; body: string }[] = [];
let ip = 0;

async function setSetting(key: string, value: unknown) {
  await sql`insert into settings (key, value, updated_at) values (${key}, ${JSON.stringify(value)}, ${NOW})
    on conflict (key) do update set value = excluded.value`.execute(owner);
}

beforeAll(async () => {
  pgdb = await createTestDatabase();
  owner = await pgdb.connect('admin');
  await prepareDatabase(owner, pgdb.config('admin'), log);
  await owner
    .insertInto('services')
    .values([
      {
        id: 'svc-public',
        slug: 'api',
        name: 'Public API',
        description: null,
        kind: 'service',
        url: null,
        group_id: null,
        sort_order: 0,
        is_public: 1,
        status_mode: 'auto',
        manual_status: 'operational',
        aggregation: 'worst',
        current_status: 'operational',
        monitor_status: 'operational',
        status_changed_at: null,
        created_at: NOW,
        updated_at: NOW,
      },
    ] as never)
    .execute();
  await setSetting('page', { siteName: 'Example Status' });
  pub = await pgdb.connect('public');
  publicApp = await buildApp({ config: pgdb.config('public'), db: pub, serveWeb: false });
  await publicApp.ready();
  workerApp = await buildApp({ config: pgdb.config('worker'), db: owner, serveWeb: false, mailer: new MemoryMailer() });
  await workerApp.ready();
  workerApp.ctx.channels!.request = async (url, init = {}): Promise<SafeResponse> => {
    sent.push({ url, body: init.body ?? '' });
    return { status: 204, body: '', address: '203.0.113.1' };
  };
}, 60_000);

afterAll(async () => {
  await publicApp?.close();
  await workerApp?.close();
  await pub?.destroy();
  await owner?.destroy();
  await pgdb?.drop();
});

const JSONAPI = { 'content-type': JSONAPI_MEDIA_TYPE };

async function subscribe(values: Record<string, unknown>) {
  const res = await publicApp.inject({
    method: 'POST',
    url: '/api/public/channel-subscriptions',
    headers: JSONAPI,
    remoteAddress: `198.51.100.${++ip}`,
    payload: JSON.stringify(toRequestDocument('channel-subscriptions', values, { relationships: { serviceIds: 'services' } })),
  });
  await publicApp.ctx.worker.idle();
  return res;
}

function confirm(reference: string, code: string) {
  return publicApp.inject({
    method: 'POST',
    url: '/api/public/channel-subscriptions/confirm',
    headers: JSONAPI,
    remoteAddress: `198.51.100.${++ip}`,
    payload: JSON.stringify(toRequestDocument('channel-subscriptions', { reference, code })),
  });
}

describe('public role and the channel tables', () => {
  it('reads none of them, nor the channel settings', async () => {
    await setSetting('channels', { webhookSubscriptions: true });
    for (const table of ['channel_subscribers', 'channel_outbox', 'notification_webhooks', 'sms_recipients', 'channel_subscriber_services']) {
      await expect(sql.raw(`select * from public.${table}`).execute(pub), table).rejects.toThrow(/permission denied/);
    }
    const { rows } = await sql<{ key: string }>`select key from settings`.execute(pub);
    expect(rows.map((r) => r.key)).toEqual(['page']);
  });

  it('cannot call the helpers of the functions', async () => {
    await expect(sql`select * from public.osp_channel_options()`.execute(pub)).rejects.toThrow(/permission denied/);
    await expect(sql`select public.osp_queue_channel_message('webhook', 'x', 'test', 'x')`.execute(pub)).rejects.toThrow(/permission denied/);
  });

  it('gets the options through osp_public.channel_options', async () => {
    await setSetting('channels', { webhookSubscriptions: false });
    const off = await publicApp.inject('/api/public/summary');
    expect(off.json().data.attributes.channelSubscriptions).toEqual({ webhookKinds: [], sms: false, smsCallingCodes: [] });
    await setSetting('channels', { webhookSubscriptions: true, smsCallingCodes: ['49'] });
    const on = await publicApp.inject('/api/public/summary');
    // SMS stays off without an enabled provider.
    expect(on.json().data.attributes.channelSubscriptions).toEqual({ webhookKinds: ['discord', 'slack', 'teams'], sms: false, smsCallingCodes: ['49'] });
  });
});

describe('webhook subscription through the functions', () => {
  it('subscribes, confirms with the code, manages and unsubscribes', async () => {
    await setSetting('channels', { webhookSubscriptions: true });
    const url = 'https://discord.com/api/webhooks/42/pg-token';
    const res = await subscribe({ channel: 'webhook', webhookKind: 'discord', url, allServices: false, serviceIds: ['svc-public'] });
    expect(res.statusCode, res.body).toBe(202);
    const { reference } = res.json().meta as { reference: string };
    const row = await owner.selectFrom('channel_subscribers').selectAll().where('target_hash', '=', reference).executeTakeFirstOrThrow();
    // Stored encrypted, readable by the worker.
    expect(row.target_enc).not.toContain('pg-token');
    expect(targetBox(workerApp.ctx.config).decrypt(row.target_enc)).toBe(url);
    // The function queued the confirmation without content; the worker renders it.
    await workerApp.ctx.channels!.deliverDue();
    const code = channelCode(workerApp.ctx.config.SUBSCRIPTION_TOKEN_KEY, row.token_salt);
    expect(sent.at(-1)!.url).toBe(url);
    expect(sent.at(-1)!.body).toContain(code);

    expect((await confirm(reference, code === '000000' ? '111111' : '000000')).statusCode).toBe(404);
    const ok = await confirm(reference, code);
    expect(ok.statusCode, ok.body).toBe(200);
    const sub = ok.json().data as { id: string; attributes: { manageToken: string; confirmed: boolean } };
    expect(sub.attributes.confirmed).toBe(true);
    expect((await confirm(reference, code)).statusCode).toBe(404);
    const attempts = await owner.selectFrom('channel_subscribers').select('code_attempts').where('id', '=', sub.id).executeTakeFirstOrThrow();
    expect(attempts.code_attempts).toBe(1);

    const headers = { 'x-subscription-token': sub.attributes.manageToken };
    expect((await publicApp.inject({ url: `/api/public/channel-subscriptions/${sub.id}`, headers })).statusCode).toBe(200);
    expect((await publicApp.inject({ url: `/api/public/channel-subscriptions/${sub.id}`, headers: { 'x-subscription-token': 'w'.repeat(22) } })).statusCode).toBe(404);
    const patched = await publicApp.inject({
      method: 'PATCH',
      url: `/api/public/channel-subscriptions/${sub.id}`,
      headers: { ...headers, ...JSONAPI },
      payload: JSON.stringify(toRequestDocument('channel-subscriptions', { locale: 'de', allServices: true }, { id: sub.id })),
    });
    expect(patched.json().data.attributes).toMatchObject({ locale: 'de', allServices: true });
    expect((await publicApp.inject({ method: 'DELETE', url: `/api/public/channel-subscriptions/${sub.id}`, headers })).statusCode).toBe(204);
    expect(await owner.selectFrom('channel_subscribers').select('id').where('id', '=', sub.id).execute()).toEqual([]);
  });

  it('refuses a kind the admin did not enable', async () => {
    await setSetting('channels', { webhookSubscriptions: true });
    // The function itself refuses, whatever the caller checked before.
    await expect(
      sql`select osp_public.channel_subscribe('abcdefghijkl', 'webhook', 'generic', null, 'v1.a.b.c', ${'a'.repeat(43)}, 'x', 'en', true,
        ARRAY[]::text[], ${'s'.repeat(22)}, ${'0'.repeat(64)}, ${'1'.repeat(64)}, 'key')`.execute(pub),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('validates its input', async () => {
    await setSetting('channels', { webhookSubscriptions: true });
    await expect(
      sql`select osp_public.channel_subscribe('bad id!', 'webhook', 'discord', null, 'v1.a.b.c', ${'a'.repeat(43)}, 'x', 'en', true,
        ARRAY[]::text[], ${'s'.repeat(22)}, ${'0'.repeat(64)}, ${'1'.repeat(64)}, 'key')`.execute(pub),
    ).rejects.toMatchObject({ code: '22023', message: 'Invalid id' });
    await expect(
      sql`select osp_public.channel_subscribe('abcdefghijkl', 'webhook', 'discord', null, 'plain-url', ${'a'.repeat(43)}, 'x', 'en', true,
        ARRAY[]::text[], ${'s'.repeat(22)}, ${'0'.repeat(64)}, ${'1'.repeat(64)}, 'key')`.execute(pub),
    ).rejects.toMatchObject({ code: '22023', message: 'Invalid target' });
  });
});

describe('SMS subscription through the functions', () => {
  it('enforces the country allowlist and the monthly budget', async () => {
    await setSetting('sms_provider', { enabled: true, url: 'https://sms.example.com/send', successStatuses: [200] });
    await setSetting('channels', { smsCallingCodes: ['49'], smsMonthlyBudget: 1 });
    const other = await subscribe({ channel: 'sms', phone: '+447700900123' });
    expect(other.statusCode).toBe(400);
    // The function refuses another country even when the caller does not check.
    await expect(
      sql`select osp_public.channel_subscribe('abcdefghijkm', 'sms', null, '+447700900123', 'v1.a.b.c', ${'b'.repeat(43)}, 'x', 'en', true,
        ARRAY[]::text[], ${'s'.repeat(22)}, ${'0'.repeat(64)}, ${'1'.repeat(64)}, 'key')`.execute(pub),
    ).rejects.toMatchObject({ message: 'Country not allowed' });

    const ok = await subscribe({ channel: 'sms', phone: '+491512345678' });
    expect(ok.statusCode, ok.body).toBe(202);
    const queued = await owner.selectFrom('channel_outbox').selectAll().where('channel', '=', 'sms').execute();
    expect(queued.map((q) => [q.event, q.payload, q.status])).toEqual([['subscription.confirm', '', 'pending']]);
    // That pending SMS uses the budget of 1: SMS subscriptions pause.
    const summary = await publicApp.inject('/api/public/summary');
    expect(summary.json().data.attributes.channelSubscriptions.sms).toBe(false);
    expect((await subscribe({ channel: 'sms', phone: '+491512345679' })).statusCode).toBe(404);
  });
});
