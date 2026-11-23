/**
 * Webhook and SMS subscriptions of visitors (POST /api/public/channel-subscriptions
 * and the forms of /subscribe/webhook and /subscribe/sms).
 *
 * Flow: the visitor enters a webhook URL or a phone number. The answer is always
 * the same (202 and a `reference`); afterwards the server queues a confirmation
 * message with a 6-digit code to that destination. The subscription becomes
 * active once the visitor enters the code together with the reference
 * (`confirm`). Every message carries the manage/unsubscribe link.
 *
 * Secrets, all derived from SUBSCRIPTION_TOKEN_KEY (the key every instance has):
 * - The target (URL, number) is stored encrypted (SecretBox of a derived key);
 *   `target_hash` = HMAC of the normalized target finds it again and is the
 *   reference of the code form (it reveals nothing the visitor did not type).
 * - code       = 6 digits of HMAC("channel-code:<salt>"), stored as SHA-256("<salt>:<code>").
 *   Valid 24 hours, MAX_CODE_ATTEMPTS wrong entries end it; subscribing again
 *   sends a new code under a new salt (MAX_CODE_SENDS per sign-up, throttled).
 * - manageToken = HMAC("channel-manage:<id>:<salt>") (22 characters, short enough
 *   for the SMS link), stored as SHA-256.
 * - signing secret of a generic webhook = HMAC("channel-signing:<id>:<salt>").
 *
 * Two variants like the email subscriptions (subscription-flow.ts): direct table
 * access, or the SECURITY DEFINER functions of osp_public (0015) on a restricted
 * PostgreSQL public role. Both answer the same; unknown ids and wrong tokens are
 * the same 404.
 */
import { createHmac, randomBytes } from 'node:crypto';
import {
  checkWebhookUrl,
  maskPhone,
  normalizePhone,
  phoneAllowed,
  webhookHint,
  type ChannelOptions,
  type ChannelPreferencesInput,
  type ChannelSubscribeInput,
  type PublicChannelSubscription,
  type SubscriptionLocale,
  type WebhookKind,
} from '@openstatuspage/shared';
import { sql } from 'kysely';
import type { Config } from '../../config.js';
import type { AppContext } from '../../context.js';
import type { DB } from '../../db/index.js';
import { MAX_CODE_ATTEMPTS, MAX_CODE_SENDS } from '../../db/migrations/0015_notification_channels.js';
import type { ChannelSubscriber } from '../../db/types.js';
import { safeEqual, SecretBox, sha256 } from '../../lib/crypto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { unique } from '../../lib/http.js';
import { databaseInputError, usesDatabaseFunctions } from '../subscription-flow.js';
import { tokenKeyFingerprint } from '../subscriptions.js';
import { computeChannelOptions, getChannelSettings, subscriberWebhookKinds } from './settings.js';

export { MAX_CODE_ATTEMPTS, MAX_CODE_SENDS };

/** A confirmation code is valid this long. */
export const CODE_TTL_MS = 24 * 3600_000;
/** One message per target within this time (subscribing again). */
export const WEBHOOK_THROTTLE_MS = 10 * 60_000;
export const SMS_THROTTLE_MS = 60 * 60_000;
/** Unconfirmed subscriptions are deleted after this time (counted from the sign-up). */
export const PENDING_TTL_MS = 7 * 86400_000;

const hmac = (key: string, data: string) => createHmac('sha256', key).update(data).digest();

/** The box of subscriber targets (a key derived from SUBSCRIPTION_TOKEN_KEY, not SECRET_KEY). */
export function targetBox(config: Pick<Config, 'SUBSCRIPTION_TOKEN_KEY'>): SecretBox {
  return new SecretBox(`channel-targets:${config.SUBSCRIPTION_TOKEN_KEY}`);
}

export function targetHash(key: string, channel: 'webhook' | 'sms', target: string): string {
  return hmac(key, `channel-target:${channel}:${target}`).toString('base64url');
}

export function channelCode(key: string, salt: string): string {
  return String(hmac(key, `channel-code:${salt}`).readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

export function codeHash(salt: string, code: string): string {
  return sha256(`${salt}:${code}`);
}

export function channelManageToken(key: string, id: string, salt: string): string {
  return hmac(key, `channel-manage:${id}:${salt}`).toString('base64url').slice(0, 22);
}

export function channelSigningSecret(key: string, id: string, salt: string): string {
  return `whsec_${hmac(key, `channel-signing:${id}:${salt}`).toString('base64url')}`;
}

/** Short manage link of a subscriber (SMS and every webhook message): /s/<id>/<token>. */
export function channelManageUrl(config: Pick<Config, 'PUBLIC_BASE_URL'>, id: string, token: string): string {
  return `${config.PUBLIC_BASE_URL}/s/${encodeURIComponent(id)}/${encodeURIComponent(token)}`;
}

/** The manage page of the web client (the short link redirects there). */
export function channelManagePage(config: Pick<Config, 'PUBLIC_BASE_URL'>, id: string, token: string, flags = ''): string {
  return `/subscription/channel?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}${flags}`;
}

/** A fresh subscription id: 12 URL-safe characters (short SMS links). */
export function newChannelId(): string {
  return randomBytes(9).toString('base64url');
}

/** A 400 for one field; `code` tells the pages which message to show (webhook_host, webhook_insecure, phone_format, phone_country, invalid_value). */
const fieldIssue = (path: string, message: string, code = 'invalid_value') => badRequest(message, [{ path: [path], code, message }]);

/** The normalized target of a subscribe request, checked against the options; 400/404 otherwise. */
export interface CheckedTarget {
  channel: 'webhook' | 'sms';
  webhookKind: WebhookKind | null;
  /** Normalized URL or E.164 number. */
  target: string;
  hint: string;
}

/** 404 when the channel is not offered, 400 for an invalid target. Does not look at subscribers. */
export function checkTarget(input: ChannelSubscribeInput, options: ChannelOptions): CheckedTarget {
  if (input.channel === 'webhook') {
    const kind = input.webhookKind!;
    if (!options.webhookKinds.includes(kind)) throw notFound('Webhook subscriptions');
    const checked = checkWebhookUrl(kind, input.url ?? '', { subscriber: true });
    if (!checked.ok) {
      throw fieldIssue(
        'url',
        checked.problem === 'host'
          ? `Enter a ${kind === 'teams' ? 'Microsoft Teams Workflows' : kind === 'slack' ? 'Slack' : 'Discord'} webhook URL`
          : checked.problem === 'insecure'
            ? 'The webhook URL must start with https://'
            : 'Enter a valid webhook URL',
        checked.problem === 'host' ? 'webhook_host' : checked.problem === 'insecure' ? 'webhook_insecure' : 'invalid_value',
      );
    }
    return { channel: 'webhook', webhookKind: kind, target: checked.url, hint: webhookHint(checked.url) };
  }
  if (!options.sms) throw notFound('SMS subscriptions');
  const phone = normalizePhone(input.phone ?? '');
  if (!phone) throw fieldIssue('phone', 'Enter the number in international format, e.g. +49 151 2345678', 'phone_format');
  if (!phoneAllowed(phone, options.smsCallingCodes)) throw fieldIssue('phone', 'Numbers of this country cannot subscribe', 'phone_country');
  return { channel: 'sms', webhookKind: null, target: phone, hint: maskPhone(phone) };
}

/** Checks a stored subscriber target again right before sending (the database only stores ciphertext). */
export async function targetStillAllowed(db: DB, sub: Pick<ChannelSubscriber, 'channel' | 'webhook_kind'>, target: string): Promise<boolean> {
  const settings = await getChannelSettings(db);
  if (sub.channel === 'webhook') {
    const kind = sub.webhook_kind;
    if (!kind || !subscriberWebhookKinds(settings).includes(kind)) return false;
    return checkWebhookUrl(kind, target, { subscriber: true }).ok;
  }
  return normalizePhone(target) === target && phoneAllowed(target, settings.smsCallingCodes);
}

interface NewSubscriber {
  id: string;
  salt: string;
  codeHash: string;
  manageHash: string;
  tokenKey: string;
  targetEnc: string;
  targetHash: string;
}

function newSubscriber(config: Config, checked: CheckedTarget): NewSubscriber {
  const key = config.SUBSCRIPTION_TOKEN_KEY;
  const id = newChannelId();
  const salt = randomBytes(16).toString('base64url');
  return {
    id,
    salt,
    codeHash: codeHash(salt, channelCode(key, salt)),
    manageHash: sha256(channelManageToken(key, id, salt)),
    tokenKey: tokenKeyFingerprint(key),
    targetEnc: targetBox(config).encrypt(checked.target),
    targetHash: targetHash(key, checked.channel, checked.target),
  };
}

/** The reference a subscribe request answers with (also for the honeypot: then random). */
export function referenceOf(config: Config, checked: CheckedTarget | null): string {
  return checked ? targetHash(config.SUBSCRIPTION_TOKEN_KEY, checked.channel, checked.target) : randomBytes(32).toString('base64url');
}

// --- Direct variant (SQLite, admin/worker/all) ------------------------------------------

async function messageAllowed(db: DB, channel: 'webhook' | 'sms', now: Date): Promise<boolean> {
  if (channel !== 'sms') return true;
  const settings = await getChannelSettings(db);
  const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
  const row = await db
    .selectFrom('channel_outbox')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('channel', '=', 'sms')
    .where('recipient_type', '=', 'subscriber')
    .where('event', 'in', ['subscription.confirm', 'subscription.manage'])
    .where('created_at', '>=', hourAgo)
    .executeTakeFirst();
  if (Number(row?.n ?? 0) >= settings.smsConfirmationsPerHour) return false;
  return (await computeChannelOptions(db, now)).sms;
}

async function queueMessage(ctx: AppContext, channel: 'webhook' | 'sms', subscriberId: string, event: string, nowIso: string) {
  await ctx.channels.enqueue([{ channel, recipientType: 'subscriber', recipientId: subscriberId, event, payload: '' }], new Date(nowIso));
}

async function replaceServices(db: DB, subscriberId: string, serviceIds: string[]): Promise<void> {
  await db.deleteFrom('channel_subscriber_services').where('subscriber_id', '=', subscriberId).execute();
  if (serviceIds.length > 0) {
    await db
      .insertInto('channel_subscriber_services')
      .values(serviceIds.map((service_id) => ({ subscriber_id: subscriberId, service_id })))
      .execute();
  }
}

/** Same steps as osp_public.channel_subscribe (0015). */
async function subscribeDirect(ctx: AppContext, input: ChannelSubscribeInput, checked: CheckedTarget, now: Date): Promise<void> {
  const { db, config } = ctx;
  const nowIso = now.toISOString();
  const serviceIds = input.allServices ? [] : unique(input.serviceIds);
  const hash = targetHash(config.SUBSCRIPTION_TOKEN_KEY, checked.channel, checked.target);
  let sends = 0;
  let createdAt = nowIso;
  const existing = await db.selectFrom('channel_subscribers').selectAll().where('target_hash', '=', hash).executeTakeFirst();
  if (existing) {
    const throttle = existing.channel === 'sms' ? SMS_THROTTLE_MS : WEBHOOK_THROTTLE_MS;
    if (existing.code_sent_at && existing.code_sent_at >= new Date(now.getTime() - throttle).toISOString()) return;
    if (existing.confirmed_at) {
      if (!(await messageAllowed(db, existing.channel, now))) return;
      const claimed = await db
        .updateTable('channel_subscribers')
        .set({ code_sent_at: nowIso })
        .where('id', '=', existing.id)
        .where((eb) => (existing.code_sent_at ? eb('code_sent_at', '=', existing.code_sent_at) : eb('code_sent_at', 'is', null)))
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) > 0) await queueMessage(ctx, existing.channel, existing.id, 'subscription.manage', nowIso);
      return;
    }
    if (existing.code_sends >= MAX_CODE_SENDS) return;
    sends = existing.code_sends;
    createdAt = existing.created_at;
    const removed = await db.deleteFrom('channel_subscribers').where('id', '=', existing.id).where('updated_at', '=', existing.updated_at).executeTakeFirst();
    // A concurrent request replaced it: that one sends the code.
    if (Number(removed.numDeletedRows) === 0) return;
    await db
      .deleteFrom('channel_outbox')
      .where('recipient_type', '=', 'subscriber')
      .where('recipient_id', '=', existing.id)
      .where('status', '=', 'pending')
      .execute();
  }
  if (!(await messageAllowed(db, checked.channel, now))) return;
  const fresh = newSubscriber(config, checked);
  try {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('channel_subscribers')
        .values({
          id: fresh.id,
          channel: checked.channel,
          webhook_kind: checked.webhookKind,
          target_enc: fresh.targetEnc,
          target_hash: fresh.targetHash,
          target_hint: checked.hint,
          locale: input.locale,
          all_services: input.allServices ? 1 : 0,
          token_salt: fresh.salt,
          code_hash: fresh.codeHash,
          code_attempts: 0,
          code_sends: sends + 1,
          code_sent_at: nowIso,
          confirmed_at: null,
          manage_token_hash: fresh.manageHash,
          token_key: fresh.tokenKey,
          created_at: createdAt,
          updated_at: nowIso,
        })
        .execute();
      await replaceServices(trx, fresh.id, serviceIds);
    });
  } catch (err) {
    // Concurrent request for the same target: that one queues the message.
    if (await db.selectFrom('channel_subscribers').select('id').where('target_hash', '=', fresh.targetHash).executeTakeFirst()) return;
    throw err;
  }
  await queueMessage(ctx, checked.channel, fresh.id, 'subscription.confirm', nowIso);
}

// --- Both variants ------------------------------------------------------------------------

interface ChannelRow {
  id: string;
  channel: 'webhook' | 'sms';
  webhook_kind: WebhookKind | null;
  target_hint: string;
  locale: SubscriptionLocale;
  all_services: number;
  confirmed: boolean;
  service_ids: string[];
  token_salt: string | null;
}

function toPublic(config: Config, row: ChannelRow): PublicChannelSubscription {
  const allServices = row.all_services === 1;
  return {
    id: row.id,
    channel: row.channel,
    webhookKind: row.webhook_kind,
    target: row.target_hint,
    locale: row.locale,
    allServices,
    serviceIds: allServices ? [] : row.service_ids,
    confirmed: row.confirmed,
    ...(row.webhook_kind === 'generic' && row.token_salt
      ? { signingSecret: channelSigningSecret(config.SUBSCRIPTION_TOKEN_KEY, row.id, row.token_salt) }
      : {}),
  };
}

async function rowOf(db: DB, sub: ChannelSubscriber): Promise<ChannelRow> {
  const serviceIds =
    sub.all_services === 1
      ? []
      : (
          await db
            .selectFrom('channel_subscriber_services')
            .innerJoin('services', 'services.id', 'channel_subscriber_services.service_id')
            .select('services.id')
            .where('channel_subscriber_services.subscriber_id', '=', sub.id)
            .where('services.is_public', '=', 1)
            .orderBy('services.sort_order')
            .orderBy('services.name')
            .execute()
        ).map((r) => r.id);
  return {
    id: sub.id,
    channel: sub.channel,
    webhook_kind: sub.webhook_kind,
    target_hint: sub.target_hint,
    locale: sub.locale,
    all_services: sub.all_services,
    confirmed: sub.confirmed_at !== null,
    service_ids: serviceIds,
    token_salt: sub.token_salt,
  };
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === '55000') throw notFound('Subscriptions');
    const message = (err as { message?: unknown }).message;
    if ((err as { code?: unknown } | null)?.code === '22023' && (message === 'Invalid phone' || message === 'Country not allowed')) {
      throw message === 'Invalid phone'
        ? fieldIssue('phone', 'Enter the number in international format', 'phone_format')
        : fieldIssue('phone', 'Numbers of this country cannot subscribe', 'phone_country');
    }
    throw databaseInputError(err) ?? err;
  }
}

/** Starts a subscription (after the answer; target and services already checked). */
export async function startChannelSubscription(
  ctx: AppContext,
  input: ChannelSubscribeInput,
  checked: CheckedTarget,
  now = new Date(),
): Promise<void> {
  if (!usesDatabaseFunctions(ctx.config)) return subscribeDirect(ctx, input, checked, now);
  const fresh = newSubscriber(ctx.config, checked);
  const serviceIds = input.allServices ? [] : unique(input.serviceIds);
  await call(() =>
    sql`select osp_public.channel_subscribe(${fresh.id}, ${checked.channel}, ${checked.webhookKind}, ${checked.channel === 'sms' ? checked.target : null},
      ${fresh.targetEnc}, ${fresh.targetHash}, ${checked.hint}, ${input.locale}, ${input.allServices}, ${serviceIds}::text[],
      ${fresh.salt}, ${fresh.codeHash}, ${fresh.manageHash}, ${fresh.tokenKey})`.execute(ctx.db),
  );
}

export interface ChannelConfirmResult {
  subscription: PublicChannelSubscription;
  manageToken: string;
}

/** Confirms with the code; 404 for a wrong, used up or expired code (every case the same). */
export async function confirmChannel(ctx: AppContext, reference: string, code: string, now = new Date()): Promise<ChannelConfirmResult> {
  const key = ctx.config.SUBSCRIPTION_TOKEN_KEY;
  let row: ChannelRow | undefined;
  if (usesDatabaseFunctions(ctx.config)) {
    const { rows } = await call(() => sql<ChannelRow>`select * from osp_public.channel_confirm(${reference}, ${code})`.execute(ctx.db));
    row = rows[0];
  } else {
    const sub = await ctx.db.selectFrom('channel_subscribers').selectAll().where('target_hash', '=', reference).executeTakeFirst();
    const expired = !sub?.code_sent_at || sub.code_sent_at < new Date(now.getTime() - CODE_TTL_MS).toISOString();
    if (sub && sub.confirmed_at === null && sub.code_attempts < MAX_CODE_ATTEMPTS && !expired) {
      if (/^\d{6}$/.test(code) && safeEqual(codeHash(sub.token_salt, code), sub.code_hash)) {
        const nowIso = now.toISOString();
        const result = await ctx.db
          .updateTable('channel_subscribers')
          .set({ confirmed_at: nowIso, updated_at: nowIso })
          .where('id', '=', sub.id)
          .where('confirmed_at', 'is', null)
          .executeTakeFirst();
        if (Number(result.numUpdatedRows) > 0) row = await rowOf(ctx.db, { ...sub, confirmed_at: nowIso });
      } else {
        await ctx.db
          .updateTable('channel_subscribers')
          .set((eb) => ({ code_attempts: eb('code_attempts', '+', 1) }))
          .where('id', '=', sub.id)
          .execute();
      }
    }
  }
  if (!row?.token_salt) throw notFound('Subscription');
  return { subscription: toPublic(ctx.config, row), manageToken: channelManageToken(key, row.id, row.token_salt) };
}

async function findByToken(ctx: AppContext, id: string, token: string | undefined): Promise<ChannelSubscriber> {
  const sub = await ctx.db.selectFrom('channel_subscribers').selectAll().where('id', '=', id).executeTakeFirst();
  // Compute an HMAC even for unknown ids so both paths take similar time.
  const expected = channelManageToken(ctx.config.SUBSCRIPTION_TOKEN_KEY, id, sub?.token_salt ?? 'unknown');
  const valid = token !== undefined && token.length > 0 && safeEqual(expected, token);
  if (!sub || !valid) throw notFound('Subscription');
  return sub;
}

export async function getChannelSubscription(ctx: AppContext, id: string, token: string | undefined): Promise<PublicChannelSubscription> {
  if (!usesDatabaseFunctions(ctx.config)) return toPublic(ctx.config, await rowOf(ctx.db, await findByToken(ctx, id, token)));
  const { rows } = await call(() => sql<ChannelRow>`select * from osp_public.channel_subscription_get(${id}, ${token ?? ''})`.execute(ctx.db));
  if (!rows[0]) throw notFound('Subscription');
  return toPublic(ctx.config, rows[0]);
}

/** Replaces locale and scope (serviceIds already checked by the caller); 404 for a wrong token. */
export async function updateChannelSubscription(
  ctx: AppContext,
  id: string,
  token: string | undefined,
  input: ChannelPreferencesInput,
): Promise<PublicChannelSubscription> {
  const serviceIds = input.allServices ? [] : unique(input.serviceIds);
  if (!usesDatabaseFunctions(ctx.config)) {
    const sub = await findByToken(ctx, id, token);
    const nowIso = new Date().toISOString();
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('channel_subscribers')
        .set({ locale: input.locale, all_services: input.allServices ? 1 : 0, updated_at: nowIso })
        .where('id', '=', sub.id)
        .execute();
      await replaceServices(trx, sub.id, serviceIds);
    });
    const updated = await ctx.db.selectFrom('channel_subscribers').selectAll().where('id', '=', sub.id).executeTakeFirstOrThrow();
    return toPublic(ctx.config, await rowOf(ctx.db, updated));
  }
  const { rows } = await call(() =>
    sql<ChannelRow>`select * from osp_public.channel_subscription_update(${id}, ${token ?? ''}, ${input.locale},
      ${input.allServices}, ${serviceIds}::text[])`.execute(ctx.db),
  );
  if (!rows[0]) throw notFound('Subscription');
  return toPublic(ctx.config, rows[0]);
}

/** Removes a subscriber and its pending messages. */
export async function deleteChannelSubscriber(db: DB, id: string): Promise<boolean> {
  const result = await db.deleteFrom('channel_subscribers').where('id', '=', id).executeTakeFirst();
  await db
    .deleteFrom('channel_outbox')
    .where('recipient_type', '=', 'subscriber')
    .where('recipient_id', '=', id)
    .where('status', '=', 'pending')
    .execute();
  return Number(result.numDeletedRows ?? 0) > 0;
}

export async function unsubscribeChannel(ctx: AppContext, id: string, token: string | undefined): Promise<void> {
  if (!usesDatabaseFunctions(ctx.config)) {
    const sub = await findByToken(ctx, id, token);
    await deleteChannelSubscriber(ctx.db, sub.id);
    return;
  }
  const { rows } = await call(() =>
    sql<{ deleted: boolean }>`select osp_public.channel_subscription_delete(${id}, ${token ?? ''}) as deleted`.execute(ctx.db),
  );
  if (!rows[0]?.deleted) throw notFound('Subscription');
}

/** Deletes webhook/SMS subscriptions not confirmed within PENDING_TTL_MS of the sign-up. */
export async function purgeUnconfirmedChannels(db: DB, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PENDING_TTL_MS).toISOString();
  const result = await db
    .deleteFrom('channel_subscribers')
    .where('confirmed_at', 'is', null)
    .where('created_at', '<', cutoff)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}

