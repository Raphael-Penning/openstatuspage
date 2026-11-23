/**
 * Webhook and SMS notifications: fan-out and delivery through channel_outbox.
 *
 * Fan-out: a status event (the same events and conditions as the subscriber
 * mails, see notifications.ts) queues one row per recipient: enabled admin
 * webhooks, enabled on-call SMS recipients and confirmed subscribers whose
 * scope covers the event (all services, or one of the affected public services).
 * Rows hold the public event data only; recipients are looked up again, and the
 * message is rendered, right before sending (targets and tokens never sit in
 * the outbox).
 *
 * Delivery: a worker task sends due rows in batches, through the SSRF guard
 * (lib/safe-http.ts), and retries failures with backoff (1 min, 5 min, 15 min,
 * 1 h; MAX_ATTEMPTS). 4xx answers other than 408/425/429 are not retried.
 * Rate limits (ChannelSettings): per destination and minute (webhookHostPerMinute),
 * all subscriber webhooks per minute, all subscriber SMS per minute; a row over a
 * limit waits a minute without losing an attempt. The destination bucket is the
 * webhook itself for admin webhooks and for subscriber webhooks on the official
 * hosts (Discord, Slack and Teams limit per webhook), and the host for generic
 * subscriber webhooks. Admin webhooks never share a bucket with visitors, and
 * on-call SMS are never postponed (they still count toward the SMS per minute).
 * The limits are counted in memory by the instance that holds the delivery
 * task's lease (one at a time).
 *
 * Failures: an admin webhook is disabled after AUTO_DISABLE_FAILURES failed
 * requests in a row, and the admins get a notice (mail to every admin when a
 * mail transport is configured, the audit log and the server log). A subscriber
 * whose last SUBSCRIBER_FAILURE_LIMIT messages were all refused by the
 * destination itself is removed (a deleted webhook, a number the provider
 * rejects); see checkSubscriber. Failures with a cause on this side (budget,
 * settings, provider configuration, network, 5xx) never count.
 *
 * SMS budget: once the SMS of this month reach ChannelSettings.smsMonthlyBudget,
 * subscriber SMS are not queued or sent (public SMS pauses, also for new
 * sign-ups) and the admins get one notice per month; on-call SMS still go out.
 * Two counts on purpose: the sign-up page and publish() count sent plus pending
 * SMS (smsUsedThisMonth: what is already promised), the worker right before a
 * send counts only sent ones (smsSentThisMonth: the row being sent is pending
 * itself, and rows queued before the budget ran out may still go out up to it).
 *
 * The delivery log of admin webhooks is their outbox rows (event, status, status
 * code, a short error without URL or secrets). Sent rows lose their payload; all
 * rows are purged after CHANNEL_RETENTION_MS (longer than a month, the budget
 * counts the rows of the current month).
 */
import { normalizePhone, type SubscriptionLocale, type WebhookKind } from '@openstatuspage/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config.js';
import type { DB } from '../../db/index.js';
import type { ChannelOutboxRow, ChannelRecipientType, NotificationWebhook } from '../../db/types.js';
import type { SecretBox } from '../../lib/crypto.js';
import { newId } from '../../lib/ids.js';
import { describeAnswer, safeRequest, type SafeRequestOptions } from '../../lib/safe-http.js';
import { escapeHtml } from '../../mail/templates.js';
import { mailerConfigured } from '../../mail/mailer.js';
import type { Worker } from '../../worker.js';
import { audit } from '../audit.js';
import type { NotificationService } from '../notifications.js';
import { getSettings } from '../settings.js';
import {
  confirmMessage,
  eventMessage,
  manageMessage,
  signGeneric,
  smsText,
  testMessage,
  webhookBody,
  type ChannelEvent,
  type ChannelMessage,
  type RenderContext,
} from './messages.js';
import {
  claimBudgetNotice,
  getChannelSettings,
  getSmsProvider,
  monthStart,
  readCredentials,
  smsUsedThisMonth,
  subscriberWebhookKinds,
} from './settings.js';
import { retryableStatus, sendSms } from './sms.js';
import {
  channelCode,
  channelManageToken,
  channelManageUrl,
  channelSigningSecret,
  deleteChannelSubscriber,
  purgeUnconfirmedChannels,
  targetBox,
  targetStillAllowed,
} from './subscriptions.js';

export const CHANNEL_DELIVERY_TASK = 'channel-delivery';
export const CHANNEL_DELIVERY_INTERVAL_MS = 10_000;
export const CHANNEL_DELIVERY_BATCH = 50;
export const MAX_ATTEMPTS = 5;
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** An admin webhook is disabled after this many failed requests in a row. */
export const AUTO_DISABLE_FAILURES = 10;
/** A subscriber is removed when its last this many messages all failed. */
export const SUBSCRIBER_FAILURE_LIMIT = 5;
export const CHANNEL_RETENTION_MS = 40 * 86400_000;
/** A row over a rate limit waits this long (no attempt is counted). */
const RATE_LIMIT_WAIT_MS = 60_000;
const CLAIM_MS = 10 * 60_000;
const INSERT_CHUNK = 100;
/** Headers an admin's extra headers never set. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'content-type', 'te', 'upgrade', 'keep-alive', 'proxy-authorization', 'expect']);

export interface QueuedMessage {
  channel: 'webhook' | 'sms';
  recipientType: ChannelRecipientType;
  recipientId: string | null;
  event: string;
  /** JSON of a ChannelEvent; '' for subscription and test messages. */
  payload: string;
}

export interface ChannelDeliveryResult {
  sent: number;
  retried: number;
  failed: number;
  postponed: number;
}

export interface SendResult {
  ok: boolean;
  statusCode: number | null;
  message: string;
  retry: boolean;
}

/** Sliding one-minute window per key, in memory. */
class MinuteLimiter {
  private readonly hits = new Map<string, number[]>();
  take(key: string, limit: number, now: number): boolean {
    const since = now - 60_000;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= limit) {
      this.hits.set(key, list);
      return false;
    }
    this.record(key, now, list);
    return true;
  }
  /** Counts a hit without checking the limit (traffic that is never postponed). */
  record(key: string, now: number, list = (this.hits.get(key) ?? []).filter((t) => t > now - 60_000)): void {
    const since = now - 60_000;
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.every((t) => t <= since)) this.hits.delete(k);
    }
  }
}

/** A prepared delivery: what to send, or why not. */
type Prepared =
  | { kind: 'drop' }
  | { kind: 'fail'; message: string }
  | {
      kind: 'webhook';
      url: string;
      allowHttp: boolean;
      headers: Record<string, string>;
      body: string;
      /** Rate-limit bucket of the destination (see the module comment). */
      limitKey: string;
      subscriber: boolean;
    }
  | { kind: 'sms'; to: string; text: string; subscriber: boolean };

interface Site {
  siteName: string;
  locale: SubscriptionLocale;
}

const isSubscriptionMessage = (event: string) => event === 'subscription.confirm' || event === 'subscription.manage';

/** Webhook answers that are not the destination's verdict on itself (timeouts, rate limits). */
const TRANSIENT_4XX = [408, 425, 429];
/**
 * SMS provider answers that reject the number (invalid, unreachable, opted out):
 * 400 Bad Request (Twilio), 410 Gone, 422 Unprocessable (Vonage, MessageBird).
 * 401, 403 and 404 point at the provider settings and never count.
 */
const SMS_NUMBER_REJECTED = [400, 410, 422];

/** Whether a failed delivery was the destination's fault (see checkSubscriber). */
export function destinationFault(channel: 'webhook' | 'sms', statusCode: number | null): boolean {
  if (statusCode === null) return false;
  if (channel === 'sms') return SMS_NUMBER_REJECTED.includes(statusCode);
  return statusCode >= 400 && statusCode < 500 && !TRANSIENT_4XX.includes(statusCode);
}

export class ChannelService {
  /** Current time; replaced in tests. */
  clock: () => Date = () => new Date();
  /** Options of every outbound request (tests replace DNS and the address check). */
  requestOptions: SafeRequestOptions = {};
  /** The outbound request (tests replace it). */
  request: typeof safeRequest = safeRequest;
  /** Set by createContext: admin notices go out as mails. */
  notifications?: NotificationService;
  private readonly destinationLimiter = new MinuteLimiter();
  private readonly globalLimiter = new MinuteLimiter();

  constructor(
    private readonly db: DB,
    private readonly config: Config,
    private readonly secrets: SecretBox,
    private readonly log: FastifyBaseLogger,
    private readonly worker?: Worker,
  ) {}

  async enqueue(messages: QueuedMessage[], now = this.clock()): Promise<void> {
    if (messages.length === 0) return;
    const nowIso = now.toISOString();
    for (let i = 0; i < messages.length; i += INSERT_CHUNK) {
      await this.db
        .insertInto('channel_outbox')
        .values(
          messages.slice(i, i + INSERT_CHUNK).map((m) => ({
            id: newId(),
            channel: m.channel,
            recipient_type: m.recipientType,
            recipient_id: m.recipientId,
            event: m.event,
            payload: m.payload,
            status: 'pending' as const,
            attempts: 0,
            next_attempt_at: nowIso,
            status_code: null,
            last_error: null,
            last_attempt_at: null,
            created_at: nowIso,
            sent_at: null,
          })),
        )
        .execute();
    }
    if (this.worker?.has(CHANNEL_DELIVERY_TASK)) void this.worker.runNow(CHANNEL_DELIVERY_TASK);
  }

  /** Queues a status event for every channel recipient of its scope. Returns the number of rows. */
  async publish(event: ChannelEvent, publicServiceIds: string[]): Promise<number> {
    const [settings, provider] = await Promise.all([getChannelSettings(this.db), getSmsProvider(this.db)]);
    const ids = publicServiceIds;
    const webhooks = await this.db
      .selectFrom('notification_webhooks')
      .select('id')
      .where('enabled', '=', 1)
      .where((eb) =>
        ids.length === 0
          ? eb('all_services', '=', 1)
          : eb.or([
              eb('all_services', '=', 1),
              eb.exists(
                eb
                  .selectFrom('notification_webhook_services')
                  .select('notification_webhook_services.webhook_id')
                  .whereRef('notification_webhook_services.webhook_id', '=', 'notification_webhooks.id')
                  .where('notification_webhook_services.service_id', 'in', ids),
              ),
            ]),
      )
      .execute();
    const recipients = provider.enabled
      ? await this.db
          .selectFrom('sms_recipients')
          .select('id')
          .where('enabled', '=', 1)
          .where((eb) =>
            ids.length === 0
              ? eb('all_services', '=', 1)
              : eb.or([
                  eb('all_services', '=', 1),
                  eb.exists(
                    eb
                      .selectFrom('sms_recipient_services')
                      .select('sms_recipient_services.recipient_id')
                      .whereRef('sms_recipient_services.recipient_id', '=', 'sms_recipients.id')
                      .where('sms_recipient_services.service_id', 'in', ids),
                  ),
                ]),
          )
          .execute()
      : [];
    const kinds = subscriberWebhookKinds(settings);
    // Subscriber SMS are not queued once the budget is used up (they would only fail).
    const smsConfigured = provider.enabled && settings.smsCallingCodes.length > 0;
    const smsOpen = smsConfigured && (await smsUsedThisMonth(this.db, this.clock())) < settings.smsMonthlyBudget;
    const subscribers = await this.db
      .selectFrom('channel_subscribers')
      .select(['id', 'channel', 'webhook_kind'])
      .where('confirmed_at', 'is not', null)
      .where((eb) =>
        ids.length === 0
          ? eb('all_services', '=', 1)
          : eb.or([
              eb('all_services', '=', 1),
              eb.exists(
                eb
                  .selectFrom('channel_subscriber_services')
                  .select('channel_subscriber_services.subscriber_id')
                  .whereRef('channel_subscriber_services.subscriber_id', '=', 'channel_subscribers.id')
                  .where('channel_subscriber_services.service_id', 'in', ids),
              ),
            ]),
      )
      .orderBy('created_at')
      .execute();
    const payload = JSON.stringify(event);
    const rows: QueuedMessage[] = [
      ...webhooks.map((w) => ({ channel: 'webhook' as const, recipientType: 'admin_webhook' as const, recipientId: w.id, event: event.type, payload })),
      ...recipients.map((r) => ({ channel: 'sms' as const, recipientType: 'sms_recipient' as const, recipientId: r.id, event: event.type, payload })),
      ...subscribers
        .filter((s) => (s.channel === 'webhook' ? s.webhook_kind !== null && kinds.includes(s.webhook_kind) : smsOpen))
        .map((s) => ({ channel: s.channel, recipientType: 'subscriber' as const, recipientId: s.id, event: event.type, payload })),
    ];
    if (smsConfigured && !smsOpen && subscribers.some((s) => s.channel === 'sms')) await this.budgetNotice(settings.smsMonthlyBudget);
    await this.enqueue(rows);
    if (rows.length > 0) this.log.info({ event: event.type, recipients: rows.length }, 'webhook and SMS notifications queued');
    return rows.length;
  }

  /**
   * Whether any channel recipient could get a status event: an enabled admin
   * webhook, an enabled on-call number (with the SMS provider on) or a confirmed
   * subscriber. Maintenance reminders are claimed only when someone gets them.
   */
  async hasRecipients(): Promise<boolean> {
    const webhook = await this.db.selectFrom('notification_webhooks').select('id').where('enabled', '=', 1).limit(1).executeTakeFirst();
    if (webhook) return true;
    const subscriber = await this.db.selectFrom('channel_subscribers').select('id').where('confirmed_at', 'is not', null).limit(1).executeTakeFirst();
    if (subscriber) return true;
    if (!(await getSmsProvider(this.db)).enabled) return false;
    return !!(await this.db.selectFrom('sms_recipients').select('id').where('enabled', '=', 1).limit(1).executeTakeFirst());
  }

  private async site(): Promise<Site> {
    const settings = await getSettings(this.db);
    return { siteName: settings.siteName, locale: settings.defaultLocale };
  }

  private message(row: Pick<ChannelOutboxRow, 'event' | 'payload'>, ctx: RenderContext, code?: string): ChannelMessage | null {
    const now = this.clock().toISOString();
    if (row.event === 'subscription.confirm') return code ? confirmMessage(ctx, code, now) : null;
    if (row.event === 'subscription.manage') return manageMessage(ctx, now);
    if (row.event === 'test') return testMessage(ctx, now);
    if (!row.payload) return null;
    try {
      return eventMessage(JSON.parse(row.payload) as ChannelEvent, ctx);
    } catch {
      return null;
    }
  }

  private webhookRequest(
    kind: WebhookKind,
    message: ChannelMessage,
    ctx: RenderContext,
    signingSecret: string | null,
    extraHeaders: { name: string; value: string }[],
  ): { headers: Record<string, string>; body: string } {
    const body = webhookBody(kind, message, ctx);
    const headers: Record<string, string> = {};
    for (const h of extraHeaders) {
      const name = h.name.toLowerCase();
      // Hop-by-hop and framing headers are the transport's; X-OSP-* and Content-Type are set below.
      if (!RESERVED_HEADERS.has(name) && !name.startsWith('x-osp-')) headers[name] = h.value;
    }
    headers['content-type'] = 'application/json';
    if (kind === 'generic') {
      headers['x-osp-event'] = message.type;
      headers['x-osp-delivery'] = ctx.deliveryId;
      if (signingSecret) Object.assign(headers, signGeneric(signingSecret, body, Math.floor(this.clock().getTime() / 1000)));
    }
    return { headers, body };
  }

  private decryptHeaders(wh: NotificationWebhook): { name: string; value: string }[] {
    if (!wh.headers_enc) return [];
    try {
      return this.secrets.decryptJson<{ name: string; value: string }[]>(wh.headers_enc);
    } catch {
      return [];
    }
  }

  /** What to send for an admin webhook (also the test button). */
  private prepareAdminWebhook(wh: NotificationWebhook, row: Pick<ChannelOutboxRow, 'id' | 'event' | 'payload'>, site: Site): Prepared {
    let url: string;
    let secret: string | null = null;
    try {
      url = this.secrets.decrypt(wh.url_enc);
      if (wh.secret_enc) secret = this.secrets.decrypt(wh.secret_enc);
    } catch {
      return { kind: 'fail', message: 'The stored URL cannot be decrypted (SECRET_KEY changed): enter it again' };
    }
    const ctx: RenderContext = { siteName: site.siteName, baseUrl: this.config.PUBLIC_BASE_URL, locale: site.locale, manageUrl: null, deliveryId: row.id };
    const message = this.message(row, ctx);
    if (!message) return { kind: 'drop' };
    const { headers, body } = this.webhookRequest(wh.kind, message, ctx, secret, this.decryptHeaders(wh));
    return { kind: 'webhook', url, allowHttp: wh.allow_http === 1, headers, body, limitKey: `webhook:${wh.id}`, subscriber: false };
  }

  private async prepare(row: ChannelOutboxRow): Promise<Prepared> {
    const site = await this.site();
    if (row.recipient_type === 'admin_webhook' && row.recipient_id) {
      const wh = await this.db.selectFrom('notification_webhooks').selectAll().where('id', '=', row.recipient_id).executeTakeFirst();
      if (!wh) return { kind: 'drop' };
      if (wh.enabled !== 1) return { kind: 'fail', message: 'Webhook is disabled' };
      return this.prepareAdminWebhook(wh, row, site);
    }
    if (row.recipient_type === 'sms_recipient' && row.recipient_id) {
      const r = await this.db.selectFrom('sms_recipients').selectAll().where('id', '=', row.recipient_id).executeTakeFirst();
      if (!r || r.enabled !== 1) return { kind: 'drop' };
      const ctx: RenderContext = { siteName: site.siteName, baseUrl: this.config.PUBLIC_BASE_URL, locale: site.locale, manageUrl: null, deliveryId: row.id };
      const message = this.message(row, ctx);
      if (!message) return { kind: 'drop' };
      return { kind: 'sms', to: r.phone, text: smsText(message, { ...ctx, shortUrl: null }), subscriber: false };
    }
    if (row.recipient_type === 'subscriber' && row.recipient_id) {
      const sub = await this.db.selectFrom('channel_subscribers').selectAll().where('id', '=', row.recipient_id).executeTakeFirst();
      if (!sub) return { kind: 'drop' };
      if (!sub.confirmed_at && !isSubscriptionMessage(row.event)) return { kind: 'drop' };
      let target: string;
      try {
        target = targetBox(this.config).decrypt(sub.target_enc);
      } catch {
        return { kind: 'fail', message: 'The stored destination cannot be decrypted (SUBSCRIPTION_TOKEN_KEY changed)' };
      }
      if (!(await targetStillAllowed(this.db, sub, target))) return { kind: 'fail', message: 'Destination no longer allowed by the channel settings' };
      const key = this.config.SUBSCRIPTION_TOKEN_KEY;
      const manageUrl = channelManageUrl(this.config, sub.id, channelManageToken(key, sub.id, sub.token_salt));
      const ctx: RenderContext = { siteName: site.siteName, baseUrl: this.config.PUBLIC_BASE_URL, locale: sub.locale, manageUrl, deliveryId: row.id };
      const message = this.message(row, ctx, channelCode(key, sub.token_salt));
      if (!message) return { kind: 'drop' };
      if (sub.channel === 'sms') return { kind: 'sms', to: target, text: smsText(message, { ...ctx, shortUrl: manageUrl }), subscriber: true };
      const kind = sub.webhook_kind ?? 'generic';
      const secret = kind === 'generic' ? channelSigningSecret(key, sub.id, sub.token_salt) : null;
      const { headers, body } = this.webhookRequest(kind, message, ctx, secret, []);
      // Discord, Slack and Teams limit per webhook; a generic URL shares its host's bucket.
      const limitKey = kind === 'generic' ? `host:${new URL(target).hostname.toLowerCase()}` : `subscriber:${sub.id}`;
      return { kind: 'webhook', url: target, allowHttp: false, headers, body, limitKey, subscriber: true };
    }
    return { kind: 'drop' };
  }

  /** Sends a prepared webhook or SMS (never throws). */
  private async send(prepared: Extract<Prepared, { kind: 'webhook' | 'sms' }>): Promise<SendResult> {
    if (prepared.kind === 'webhook') {
      try {
        const res = await this.request(
          prepared.url,
          { method: 'POST', headers: prepared.headers, body: prepared.body },
          { ...this.requestOptions, allowHttp: prepared.allowHttp },
        );
        const ok = res.status >= 200 && res.status < 300;
        return { ok, statusCode: res.status, message: ok ? `HTTP ${res.status}` : describeAnswer(res), retry: !ok && retryableStatus(res.status) };
      } catch (err) {
        const code = (err as { code?: string }).code;
        return {
          ok: false,
          statusCode: null,
          message: err instanceof Error ? err.message : 'request failed',
          retry: code !== 'scheme' && code !== 'address',
        };
      }
    }
    const provider = await getSmsProvider(this.db);
    if (!provider.enabled) return { ok: false, statusCode: null, message: 'The SMS provider is disabled', retry: false };
    const result = await sendSms(provider, readCredentials(this.secrets, provider), prepared.to, prepared.text, this.requestOptions, this.request);
    return { ok: result.ok, statusCode: result.status, message: result.message, retry: result.retry };
  }

  /** Sends due rows (see the module comment). */
  async deliverDue(now = this.clock(), limit = CHANNEL_DELIVERY_BATCH): Promise<ChannelDeliveryResult> {
    const result: ChannelDeliveryResult = { sent: 0, retried: 0, failed: 0, postponed: 0 };
    const rows = await this.db
      .selectFrom('channel_outbox')
      .selectAll()
      .where('status', '=', 'pending')
      .where('next_attempt_at', '<=', now.toISOString())
      .orderBy('next_attempt_at')
      .orderBy('created_at')
      .limit(limit)
      .execute();
    for (const row of rows) {
      const claimedAt = this.clock();
      const claimed = await this.db
        .updateTable('channel_outbox')
        .set({ next_attempt_at: new Date(claimedAt.getTime() + CLAIM_MS).toISOString() })
        .where('id', '=', row.id)
        .where('status', '=', 'pending')
        .where('next_attempt_at', '=', row.next_attempt_at)
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) === 0) continue;
      await this.deliverOne(row, result);
    }
    if (result.sent + result.retried + result.failed + result.postponed > 0) this.log.debug({ ...result }, 'channel outbox processed');
    return result;
  }

  private async postpone(row: ChannelOutboxRow, result: ChannelDeliveryResult): Promise<void> {
    const at = new Date(this.clock().getTime() + RATE_LIMIT_WAIT_MS).toISOString();
    await this.db.updateTable('channel_outbox').set({ next_attempt_at: at }).where('id', '=', row.id).execute();
    result.postponed++;
  }

  private async deliverOne(row: ChannelOutboxRow, result: ChannelDeliveryResult): Promise<void> {
    const attempts = row.attempts + 1;
    const prepared = await this.prepare(row);
    if (prepared.kind === 'drop') {
      await this.db.deleteFrom('channel_outbox').where('id', '=', row.id).execute();
      return;
    }
    if (prepared.kind === 'fail') {
      await this.finish(row, attempts, { ok: false, statusCode: null, message: prepared.message, retry: false });
      result.failed++;
      return;
    }
    const settings = await getChannelSettings(this.db);
    const nowMs = this.clock().getTime();
    if (prepared.kind === 'webhook') {
      if (prepared.subscriber && !this.globalLimiter.take('subscriber-webhooks', settings.subscriberWebhooksPerMinute, nowMs)) {
        return this.postpone(row, result);
      }
      if (!this.destinationLimiter.take(prepared.limitKey, settings.webhookHostPerMinute, nowMs)) return this.postpone(row, result);
    } else {
      if (prepared.subscriber && (await this.smsSentThisMonth()) >= settings.smsMonthlyBudget) {
        await this.finish(row, attempts, { ok: false, statusCode: null, message: 'Monthly SMS budget used up', retry: false });
        await this.budgetNotice(settings.smsMonthlyBudget);
        result.failed++;
        return;
      }
      // On-call SMS are never postponed; they still use up the minute's SMS for subscribers.
      if (!prepared.subscriber) this.globalLimiter.record('sms', nowMs);
      else if (!this.globalLimiter.take('sms', settings.smsPerMinute, nowMs)) return this.postpone(row, result);
    }
    const sent = await this.send(prepared);
    await this.finish(row, attempts, sent);
    if (sent.ok) result.sent++;
    else if (!sent.retry || attempts >= MAX_ATTEMPTS) result.failed++;
    else result.retried++;
  }

  /** SMS accepted by the provider this month. */
  private async smsSentThisMonth(): Promise<number> {
    const row = await this.db
      .selectFrom('channel_outbox')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('channel', '=', 'sms')
      .where('status', '=', 'sent')
      .where('created_at', '>=', monthStart(this.clock()))
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  /** Stores the outcome of an attempt and its consequences for the recipient. */
  private async finish(row: ChannelOutboxRow, attempts: number, sent: SendResult): Promise<void> {
    const at = this.clock();
    const atIso = at.toISOString();
    if (sent.ok) {
      await this.db
        .updateTable('channel_outbox')
        .set({ status: 'sent', attempts, status_code: sent.statusCode, last_error: null, last_attempt_at: atIso, sent_at: atIso, payload: '' })
        .where('id', '=', row.id)
        .execute();
    } else {
      const failed = !sent.retry || attempts >= MAX_ATTEMPTS;
      const backoff = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1]!;
      await this.db
        .updateTable('channel_outbox')
        .set({
          status: failed ? 'failed' : 'pending',
          attempts,
          status_code: sent.statusCode,
          last_error: sent.message.slice(0, 500),
          last_attempt_at: atIso,
          next_attempt_at: failed ? atIso : new Date(at.getTime() + backoff).toISOString(),
        })
        .where('id', '=', row.id)
        .execute();
      this.log.warn(
        { outboxId: row.id, channel: row.channel, recipient: row.recipient_type, event: row.event, attempts, failed, error: sent.message },
        'channel delivery failed',
      );
      if (failed && row.recipient_type === 'subscriber' && row.recipient_id && destinationFault(row.channel, sent.statusCode)) {
        await this.checkSubscriber(row.recipient_id, row.channel);
      }
    }
    if (row.recipient_type === 'admin_webhook' && row.recipient_id) await this.trackWebhook(row.recipient_id, sent, atIso);
  }

  private async trackWebhook(id: string, sent: SendResult, atIso: string): Promise<void> {
    if (sent.ok) {
      await this.db
        .updateTable('notification_webhooks')
        .set({ consecutive_failures: 0, last_delivery_at: atIso, last_status_code: sent.statusCode })
        .where('id', '=', id)
        .execute();
      return;
    }
    await this.db
      .updateTable('notification_webhooks')
      .set((eb) => ({ consecutive_failures: eb('consecutive_failures', '+', 1), last_delivery_at: atIso, last_status_code: sent.statusCode }))
      .where('id', '=', id)
      .execute();
    const wh = await this.db.selectFrom('notification_webhooks').selectAll().where('id', '=', id).executeTakeFirst();
    if (!wh || wh.enabled !== 1 || wh.consecutive_failures < AUTO_DISABLE_FAILURES) return;
    const reason = `Disabled after ${wh.consecutive_failures} failed deliveries in a row (last: ${sent.message.slice(0, 200)})`;
    const disabled = await this.db
      .updateTable('notification_webhooks')
      .set({ enabled: 0, disabled_reason: reason, disabled_at: atIso, updated_at: atIso })
      .where('id', '=', id)
      .where('enabled', '=', 1)
      .executeTakeFirst();
    if (Number(disabled.numUpdatedRows) === 0) return;
    await this.db
      .updateTable('channel_outbox')
      .set({ status: 'failed', last_error: 'Webhook disabled', last_attempt_at: atIso })
      .where('recipient_type', '=', 'admin_webhook')
      .where('recipient_id', '=', id)
      .where('status', '=', 'pending')
      .execute();
    await audit(this.db, { userId: null, action: 'webhook.auto_disable', entityType: 'webhook', entityId: id, details: { name: wh.name, failures: wh.consecutive_failures } });
    await this.notifyAdmins(
      `Webhook "${wh.name}" was disabled`,
      `The notification webhook "${wh.name}" (${wh.host}) failed ${wh.consecutive_failures} times in a row and was disabled. ` +
        `Check it in the admin portal under Notifications > Webhooks, then enable it again.`,
    );
  }

  /**
   * Removes a subscriber whose last SUBSCRIBER_FAILURE_LIMIT deliveries the
   * destination refused (destinationFault: a 4xx of the webhook, a provider
   * answer rejecting the number). Sent rows count against removal; failures
   * caused on this side (no status code: budget, settings, decryption, refused
   * or unreachable address, network; 5xx; provider configuration errors) are
   * ignored. For SMS the provider must also have accepted another SMS since the
   * first of these failures, so a broken provider template never removes anyone.
   */
  private async checkSubscriber(id: string, channel: 'webhook' | 'sms'): Promise<void> {
    const last = await this.db
      .selectFrom('channel_outbox')
      .select(['status', 'status_code', 'last_attempt_at'])
      .where('recipient_type', '=', 'subscriber')
      .where('recipient_id', '=', id)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'sent'),
          eb.and([
            eb('status', '=', 'failed'),
            channel === 'sms'
              ? eb('status_code', 'in', SMS_NUMBER_REJECTED)
              : eb.and([eb('status_code', '>=', 400), eb('status_code', '<', 500), eb('status_code', 'not in', TRANSIENT_4XX)]),
          ]),
        ]),
      )
      .orderBy('created_at', 'desc')
      .limit(SUBSCRIBER_FAILURE_LIMIT)
      .execute();
    if (last.length < SUBSCRIBER_FAILURE_LIMIT || last.some((r) => r.status !== 'failed')) return;
    if (channel === 'sms') {
      const since = last.map((r) => r.last_attempt_at ?? '').sort()[0] ?? '';
      const providerWorks = await this.db
        .selectFrom('channel_outbox')
        .select('id')
        .where('channel', '=', 'sms')
        .where('status', '=', 'sent')
        .where('sent_at', '>=', since)
        .limit(1)
        .executeTakeFirst();
      if (!providerWorks) return;
    }
    if (await deleteChannelSubscriber(this.db, id)) this.log.info({ subscriberId: id }, 'subscriber removed after repeated refused deliveries');
  }

  private async budgetNotice(budget: number): Promise<void> {
    if (!(await claimBudgetNotice(this.db, this.clock()))) return;
    this.log.warn({ budget }, 'monthly SMS budget used up: public SMS paused');
    await audit(this.db, { userId: null, action: 'sms.budget_exhausted', entityType: 'sms', entityId: null, details: { budget } });
    await this.notifyAdmins(
      'Monthly SMS budget used up',
      `The ${budget} SMS of this month's budget are used up. SMS to subscribers and new SMS subscriptions are paused until next month ` +
        '(on-call SMS still go out). Raise the budget in the admin portal under Notifications > SMS if needed.',
    );
  }

  /** A notice mail to every admin (when a mail transport is configured). */
  async notifyAdmins(subject: string, text: string): Promise<void> {
    const notifications = this.notifications;
    if (!notifications || !mailerConfigured(notifications.mailer)) return;
    const admins = await this.db.selectFrom('users').select('email').where('role', '=', 'admin').execute();
    await notifications.enqueue(
      admins.map((a) => ({
        subscriberId: null,
        recipient: a.email,
        kind: 'admin_notice',
        subject,
        text,
        html: `<p>${escapeHtml(text)}</p>`,
      })),
    );
  }

  /** Test button of an admin webhook: sends a test message now and logs it as a delivery. */
  async testWebhook(id: string): Promise<SendResult | null> {
    const wh = await this.db.selectFrom('notification_webhooks').selectAll().where('id', '=', id).executeTakeFirst();
    if (!wh) return null;
    const rowId = newId();
    const prepared = this.prepareAdminWebhook(wh, { id: rowId, event: 'test', payload: '' }, await this.site());
    const sent: SendResult =
      prepared.kind === 'webhook'
        ? await this.send(prepared)
        : { ok: false, statusCode: null, message: prepared.kind === 'fail' ? prepared.message : 'Nothing to send', retry: false };
    await this.logDirect(rowId, 'webhook', 'admin_webhook', id, sent);
    await this.db
      .updateTable('notification_webhooks')
      .set({ last_delivery_at: this.clock().toISOString(), last_status_code: sent.statusCode })
      .where('id', '=', id)
      .execute();
    return sent;
  }

  /** Test SMS to a number (counts toward the budget when sent). */
  async testSms(to: string): Promise<SendResult> {
    const phone = normalizePhone(to);
    if (!phone) return { ok: false, statusCode: null, message: 'Enter the number in international format (+49 ...)', retry: false };
    const provider = await getSmsProvider(this.db);
    const site = await this.site();
    const rowId = newId();
    const text = smsText(testMessage({ siteName: site.siteName, locale: site.locale }, this.clock().toISOString()), {
      ...site,
      shortUrl: null,
    });
    const result = await sendSms(provider, readCredentials(this.secrets, provider), phone, text, this.requestOptions, this.request);
    const sent: SendResult = { ok: result.ok, statusCode: result.status, message: result.message, retry: false };
    await this.logDirect(rowId, 'sms', 'test', null, sent);
    return sent;
  }

  private async logDirect(id: string, channel: 'webhook' | 'sms', type: ChannelRecipientType, recipientId: string | null, sent: SendResult) {
    const at = this.clock().toISOString();
    await this.db
      .insertInto('channel_outbox')
      .values({
        id,
        channel,
        recipient_type: type,
        recipient_id: recipientId,
        event: 'test',
        payload: '',
        status: sent.ok ? 'sent' : 'failed',
        attempts: 1,
        next_attempt_at: at,
        status_code: sent.statusCode,
        last_error: sent.ok ? null : sent.message.slice(0, 500),
        last_attempt_at: at,
        created_at: at,
        sent_at: sent.ok ? at : null,
      })
      .execute();
  }

  /** Deletes old rows and expired unconfirmed subscriptions. */
  async purge(now = this.clock()): Promise<{ rows: number; subscribers: number }> {
    const cutoff = new Date(now.getTime() - CHANNEL_RETENTION_MS).toISOString();
    const rows = await this.db
      .deleteFrom('channel_outbox')
      .where('status', 'in', ['sent', 'failed'])
      .where('created_at', '<', cutoff)
      .executeTakeFirst();
    const subscribers = await purgeUnconfirmedChannels(this.db, now);
    return { rows: Number(rows.numDeletedRows ?? 0), subscribers };
  }

  /** Puts failed deliveries of admin webhooks back into the queue. */
  async retryFailedWebhook(id: string): Promise<number> {
    const result = await this.db
      .updateTable('channel_outbox')
      .set({ status: 'pending', attempts: 0, next_attempt_at: this.clock().toISOString() })
      .where('recipient_type', '=', 'admin_webhook')
      .where('recipient_id', '=', id)
      .where('status', '=', 'failed')
      .where('event', '!=', 'test')
      .where('payload', '!=', '')
      .executeTakeFirst();
    const n = Number(result.numUpdatedRows ?? 0);
    if (n > 0 && this.worker?.has(CHANNEL_DELIVERY_TASK)) void this.worker.runNow(CHANNEL_DELIVERY_TASK);
    return n;
  }
}

/** Background tasks of the channels (with WORKER_ENABLED; registered with the mail tasks). */
export function registerChannelTasks(ctx: { worker: Worker; channels: ChannelService; log: FastifyBaseLogger }): void {
  const { worker, channels, log } = ctx;
  worker.schedule(CHANNEL_DELIVERY_TASK, CHANNEL_DELIVERY_INTERVAL_MS, async () => {
    for (let i = 0; i < 10; i++) {
      const r = await channels.deliverDue();
      if (r.sent + r.retried + r.failed + r.postponed < CHANNEL_DELIVERY_BATCH) break;
    }
  });
  worker.schedule('channel-cleanup', 3600_000, async () => {
    const r = await channels.purge();
    if (r.rows + r.subscribers > 0) log.info(r, 'old channel deliveries and unconfirmed channel subscriptions removed');
  });
}
