/**
 * Email subscriptions with double opt-in.
 *
 * Tokens are never stored: every subscriber has a random `token_salt`, and
 *   confirmToken = base64url(HMAC-SHA256(SECRET_KEY, "subscription-confirm:<id>:<salt>"))
 *   manageToken  = base64url(HMAC-SHA256(SECRET_KEY, "subscription-manage:<id>:<salt>"))
 * Tokens are compared in constant time. Unknown ids and wrong tokens produce
 * the same 404, and subscribing always answers 202, so addresses cannot be
 * enumerated.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type {
  PublicSubscription,
  SubscribeInput,
  SubscriptionLocale,
  SubscriptionPreferencesInput,
} from '@openstatuspage/shared';
import type { Config } from '../config.js';
import type { AppContext } from '../context.js';
import type { DB } from '../db/index.js';
import type { Subscriber } from '../db/types.js';
import { safeEqual } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { unique } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { mailerConfigured } from '../mail/mailer.js';
import { confirmationMail, manageMail } from '../mail/templates.js';
import { getSettings } from './settings.js';

/** At most one confirmation / "manage" mail per address within this interval. */
export const CONFIRMATION_THROTTLE_MS = 10 * 60_000;
/** Unconfirmed subscriptions are deleted after this time. */
export const PENDING_TTL_MS = 7 * 86400_000;

export type SubscriptionTokenKind = 'confirm' | 'manage';

export function subscriptionToken(secret: string, kind: SubscriptionTokenKind, id: string, salt: string): string {
  return createHmac('sha256', secret).update(`subscription-${kind}:${id}:${salt}`).digest('base64url');
}

export function verifySubscriptionToken(
  secret: string,
  kind: SubscriptionTokenKind,
  sub: Pick<Subscriber, 'id' | 'token_salt'>,
  token: string,
): boolean {
  return safeEqual(subscriptionToken(secret, kind, sub.id, sub.token_salt), token);
}

export interface SubscriberLinkSet {
  confirmUrl: string;
  manageUrl: string;
  /** Unsubscribe link for the mail body (manage page of the web client). */
  unsubscribeUrl: string;
  /** RFC 8058 one-click endpoint for the List-Unsubscribe header. */
  oneClickUrl: string;
  manageToken: string;
}

export function subscriberLinks(config: Config, sub: Pick<Subscriber, 'id' | 'token_salt'>): SubscriberLinkSet {
  const id = encodeURIComponent(sub.id);
  const confirmToken = subscriptionToken(config.SECRET_KEY, 'confirm', sub.id, sub.token_salt);
  const manageToken = subscriptionToken(config.SECRET_KEY, 'manage', sub.id, sub.token_salt);
  const manageUrl = `${config.BASE_URL}/subscription/manage?id=${id}&token=${manageToken}`;
  return {
    confirmUrl: `${config.BASE_URL}/subscription/confirm?id=${id}&token=${confirmToken}`,
    manageUrl,
    unsubscribeUrl: `${manageUrl}&unsubscribe=1`,
    oneClickUrl: `${config.BASE_URL}/api/public/subscriptions/${id}/unsubscribe?token=${manageToken}`,
    manageToken,
  };
}

/** Headers of every notification mail: RFC 8058 one-click unsubscribe. */
export function unsubscribeHeaders(links: SubscriberLinkSet): Record<string, string> {
  return {
    'List-Unsubscribe': `<${links.oneClickUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/** Subscriptions are offered: enabled in the settings and a mail transport is configured. */
export async function subscriptionsAvailable(ctx: Pick<AppContext, 'db' | 'mailer'>): Promise<boolean> {
  if (!mailerConfigured(ctx.mailer)) return false;
  return (await getSettings(ctx.db)).emailSubscriptionsEnabled;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** "jane@example.com" → "j***@example.com", for audit entries and logs. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** Validates that every id is an existing PUBLIC service (400 otherwise). Returns the de-duplicated ids. */
export async function assertPublicServices(db: DB, ids: string[]): Promise<string[]> {
  const list = unique(ids);
  if (list.length === 0) return list;
  const rows = await db
    .selectFrom('services')
    .select('id')
    .where('id', 'in', list)
    .where('is_public', '=', 1)
    .execute();
  // Same message for unknown and hidden services: hidden services must stay secret.
  if (rows.length !== list.length) throw badRequest('Unknown service');
  return list;
}

/** Selected PUBLIC services of a subscriber (hidden or deleted services are never revealed). */
async function publicServiceIdsOf(db: DB, subscriberId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('subscriber_services')
    .innerJoin('services', 'services.id', 'subscriber_services.service_id')
    .select('services.id')
    .where('subscriber_services.subscriber_id', '=', subscriberId)
    .where('services.is_public', '=', 1)
    .orderBy('services.sort_order')
    .orderBy('services.name')
    .execute();
  return rows.map((r) => r.id);
}

async function replaceServices(db: DB, subscriberId: string, serviceIds: string[]): Promise<void> {
  await db.deleteFrom('subscriber_services').where('subscriber_id', '=', subscriberId).execute();
  if (serviceIds.length > 0) {
    await db
      .insertInto('subscriber_services')
      .values(serviceIds.map((service_id) => ({ subscriber_id: subscriberId, service_id })))
      .execute();
  }
}

export async function toPublicSubscription(db: DB, sub: Subscriber): Promise<PublicSubscription> {
  const allServices = sub.all_services === 1;
  return {
    id: sub.id,
    email: sub.email,
    locale: sub.locale,
    allServices,
    serviceIds: allServices ? [] : await publicServiceIdsOf(db, sub.id),
    confirmed: sub.confirmed_at !== null,
  };
}

function throttled(sub: Subscriber, now: Date): boolean {
  return (
    sub.confirmation_sent_at !== null &&
    now.getTime() - new Date(sub.confirmation_sent_at).getTime() < CONFIRMATION_THROTTLE_MS
  );
}

async function queueAccountMail(ctx: AppContext, sub: Subscriber, kind: 'confirm' | 'manage', now: Date): Promise<void> {
  const settings = await getSettings(ctx.db);
  const site = { siteName: settings.siteName, baseUrl: ctx.config.BASE_URL, accentColor: settings.accentColor };
  const links = subscriberLinks(ctx.config, sub);
  const mail =
    kind === 'confirm'
      ? confirmationMail(site, sub.locale, links.confirmUrl)
      : manageMail(site, sub.locale, links.manageUrl);
  await ctx.db
    .updateTable('subscribers')
    .set({ confirmation_sent_at: now.toISOString() })
    .where('id', '=', sub.id)
    .execute();
  await ctx.notifications.enqueue([{ subscriberId: sub.id, recipient: sub.email, kind, ...mail }]);
}

/**
 * POST /api/public/subscriptions. The caller always answers 202 for valid input.
 * - new address: pending subscriber + confirmation mail
 * - pending: preferences updated, confirmation re-sent (throttled)
 * - confirmed: preferences unchanged, "manage your subscription" mail (throttled)
 */
export async function subscribe(ctx: AppContext, input: SubscribeInput, now = new Date()): Promise<void> {
  const { db } = ctx;
  const serviceIds = input.allServices ? [] : await assertPublicServices(db, input.serviceIds);
  const email = normalizeEmail(input.email);
  const nowIso = now.toISOString();

  const existing = await db.selectFrom('subscribers').selectAll().where('email', '=', email).executeTakeFirst();
  if (!existing) {
    const sub: Subscriber = {
      id: newId(),
      email,
      locale: input.locale,
      all_services: input.allServices ? 1 : 0,
      token_salt: randomBytes(16).toString('base64url'),
      confirmed_at: null,
      confirmation_sent_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    try {
      await db.transaction().execute(async (trx) => {
        await trx.insertInto('subscribers').values(sub).execute();
        await replaceServices(trx, sub.id, serviceIds);
      });
    } catch (err) {
      // Concurrent request for the same address: the other one sends the mail.
      if (await db.selectFrom('subscribers').select('id').where('email', '=', email).executeTakeFirst()) return;
      throw err;
    }
    await queueAccountMail(ctx, sub, 'confirm', now);
    return;
  }

  if (existing.confirmed_at === null) {
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('subscribers')
        .set({ locale: input.locale, all_services: input.allServices ? 1 : 0, updated_at: nowIso })
        .where('id', '=', existing.id)
        .execute();
      await replaceServices(trx, existing.id, serviceIds);
    });
    if (!throttled(existing, now)) await queueAccountMail(ctx, { ...existing, locale: input.locale }, 'confirm', now);
    return;
  }

  // Confirmed: never change preferences without the manage token; send the manage link instead.
  if (!throttled(existing, now)) await queueAccountMail(ctx, existing, 'manage', now);
}

/** Loads a subscriber when `token` is valid for it; 404 otherwise (same response for both cases). */
export async function findByToken(
  ctx: Pick<AppContext, 'db' | 'config'>,
  id: string,
  kind: SubscriptionTokenKind,
  token: string | undefined,
): Promise<Subscriber> {
  const sub = await ctx.db.selectFrom('subscribers').selectAll().where('id', '=', id).executeTakeFirst();
  // Compute an HMAC even for unknown ids so both paths take similar time.
  const valid = verifySubscriptionToken(
    ctx.config.SECRET_KEY,
    kind,
    sub ?? { id, token_salt: 'unknown' },
    token ?? '',
  );
  if (!sub || !valid) throw notFound('Subscription');
  return sub;
}

/** Confirms a subscription (idempotent) and returns it together with the manage token. */
export async function confirmSubscription(
  ctx: AppContext,
  id: string,
  token: string,
  now = new Date(),
): Promise<{ subscription: PublicSubscription; manageToken: string }> {
  let sub = await findByToken(ctx, id, 'confirm', token);
  if (sub.confirmed_at === null) {
    const nowIso = now.toISOString();
    await ctx.db
      .updateTable('subscribers')
      .set({ confirmed_at: nowIso, updated_at: nowIso })
      .where('id', '=', sub.id)
      .execute();
    sub = { ...sub, confirmed_at: nowIso, updated_at: nowIso };
  }
  return {
    subscription: await toPublicSubscription(ctx.db, sub),
    manageToken: subscriptionToken(ctx.config.SECRET_KEY, 'manage', sub.id, sub.token_salt),
  };
}

export async function updatePreferences(
  ctx: AppContext,
  sub: Subscriber,
  input: SubscriptionPreferencesInput,
): Promise<PublicSubscription> {
  const serviceIds = input.allServices ? [] : await assertPublicServices(ctx.db, input.serviceIds);
  const now = new Date().toISOString();
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('subscribers')
      .set({ locale: input.locale as SubscriptionLocale, all_services: input.allServices ? 1 : 0, updated_at: now })
      .where('id', '=', sub.id)
      .execute();
    await replaceServices(trx, sub.id, serviceIds);
  });
  const updated = await ctx.db.selectFrom('subscribers').selectAll().where('id', '=', sub.id).executeTakeFirstOrThrow();
  return toPublicSubscription(ctx.db, updated);
}

/** Removes a subscriber completely (services and queued mails cascade). */
export async function deleteSubscriber(db: DB, id: string): Promise<boolean> {
  const result = await db.deleteFrom('subscribers').where('id', '=', id).executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}

/**
 * Deletes subscriptions that were not confirmed within PENDING_TTL_MS (counted from
 * the sign-up and from the latest confirmation mail, so a re-sent link stays valid).
 */
export async function purgeUnconfirmed(db: DB, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PENDING_TTL_MS).toISOString();
  const result = await db
    .deleteFrom('subscribers')
    .where('confirmed_at', 'is', null)
    .where('created_at', '<', cutoff)
    .where((eb) => eb.or([eb('confirmation_sent_at', 'is', null), eb('confirmation_sent_at', '<', cutoff)]))
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
