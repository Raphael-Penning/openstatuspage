/**
 * Email subscriptions with double opt-in.
 *
 * Tokens are never stored, not even in the mail outbox (queued mails hold
 * placeholders, see TOKEN_PLACEHOLDERS): every subscriber has a random `token_salt`, and
 *   confirmToken = base64url(HMAC-SHA256(SECRET_KEY, "subscription-confirm:<id>:<salt>"))
 *   manageToken  = base64url(HMAC-SHA256(SECRET_KEY, "subscription-manage:<id>:<salt>"))
 * Tokens are compared in constant time. Unknown ids and wrong tokens produce
 * the same 404, and subscribing always answers 202, so addresses cannot be
 * enumerated.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
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

export interface SubscriptionTokens {
  confirm: string;
  manage: string;
}

/**
 * Stand-ins for the real tokens in queued mails. The outbox only ever stores these;
 * NotificationService substitutes the derived tokens right before sending. They only
 * contain URL-safe characters, so they survive URL building and HTML escaping.
 */
export const TOKEN_PLACEHOLDERS: Readonly<SubscriptionTokens> = {
  confirm: '__OSP_CONFIRM_TOKEN__',
  manage: '__OSP_MANAGE_TOKEN__',
};

/** The real confirm and manage tokens of a subscriber. */
export function subscriberTokens(config: Config, sub: Pick<Subscriber, 'id' | 'token_salt'>): SubscriptionTokens {
  return {
    confirm: subscriptionToken(config.SECRET_KEY, 'confirm', sub.id, sub.token_salt),
    manage: subscriptionToken(config.SECRET_KEY, 'manage', sub.id, sub.token_salt),
  };
}

/** SHA-256 (hex) of a token, as stored in confirm_token_hash / manage_token_hash. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Fingerprint of SECRET_KEY stored next to the token hashes (one-way, reveals nothing about the key). */
export function tokenKeyFingerprint(secret: string): string {
  return createHmac('sha256', secret).update('subscription-token-key').digest('base64url').slice(0, 16);
}

export interface SubscriptionTokenHashes {
  confirm_token_hash: string;
  manage_token_hash: string;
  token_key: string;
}

/**
 * Hashes of a subscriber's tokens. They let the database verify a token without
 * SECRET_KEY (the functions of the restricted public role do, see 0007_public_role).
 */
export function subscriptionTokenHashes(
  secret: string,
  sub: Pick<Subscriber, 'id' | 'token_salt'>,
): SubscriptionTokenHashes {
  return {
    confirm_token_hash: tokenHash(subscriptionToken(secret, 'confirm', sub.id, sub.token_salt)),
    manage_token_hash: tokenHash(subscriptionToken(secret, 'manage', sub.id, sub.token_salt)),
    token_key: tokenKeyFingerprint(secret),
  };
}

/**
 * Stores the token hashes of subscribers that have none yet or whose hashes were
 * derived from another SECRET_KEY (rows from before 0006, a changed key). Runs on
 * the start of every instance that migrates; returns the number of updated rows.
 */
export async function syncSubscriptionTokenHashes(db: DB, secret: string, batch = 500): Promise<number> {
  const key = tokenKeyFingerprint(secret);
  let updated = 0;
  for (;;) {
    const rows = await db
      .selectFrom('subscribers')
      .select(['id', 'token_salt'])
      .where((eb) => eb.or([eb('token_key', 'is', null), eb('token_key', '!=', key)]))
      .limit(batch)
      .execute();
    for (const row of rows) {
      await db.updateTable('subscribers').set(subscriptionTokenHashes(secret, row)).where('id', '=', row.id).execute();
    }
    updated += rows.length;
    if (rows.length < batch) return updated;
  }
}

/** Replaces the token placeholders in a mail body or header value with real tokens. */
export function fillTokens(text: string, tokens: SubscriptionTokens): string {
  return text
    .replaceAll(TOKEN_PLACEHOLDERS.confirm, tokens.confirm)
    .replaceAll(TOKEN_PLACEHOLDERS.manage, tokens.manage);
}

export interface SubscriberLinkSet {
  /** Confirm page of the web client; the token is in the URL fragment. */
  confirmUrl: string;
  /** Manage page of the web client; the token is in the URL fragment. */
  manageUrl: string;
  /** Unsubscribe link for the mail body (manage page with unsubscribe=1). */
  unsubscribeUrl: string;
  /** RFC 8058 one-click endpoint for the List-Unsubscribe header (token in the query string). */
  oneClickUrl: string;
}

/**
 * Links of a subscriber. Web client links carry the token in the URL fragment
 * (`#token=`), so it never reaches the server, proxies or access logs. Mails that
 * go through the outbox are built with TOKEN_PLACEHOLDERS.
 */
export function subscriberLinks(config: Config, subscriberId: string, tokens: SubscriptionTokens): SubscriberLinkSet {
  const id = encodeURIComponent(subscriberId);
  const managePage = `${config.PUBLIC_BASE_URL}/subscription/manage?id=${id}`;
  return {
    confirmUrl: `${config.PUBLIC_BASE_URL}/subscription/confirm?id=${id}#token=${tokens.confirm}`,
    manageUrl: `${managePage}#token=${tokens.manage}`,
    unsubscribeUrl: `${managePage}&unsubscribe=1#token=${tokens.manage}`,
    oneClickUrl: `${config.PUBLIC_BASE_URL}/api/public/subscriptions/${id}/unsubscribe?token=${tokens.manage}`,
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

/** Email addresses in free text such as SMTP error messages. */
const EMAIL_IN_TEXT =
  /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;

/** Masks every email address in a text: "550 <jane@example.com> unknown" → "550 <j***@example.com> unknown". */
export function maskEmailsIn(text: string): string {
  return text.replace(EMAIL_IN_TEXT, (address) => maskEmail(address));
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
  const site = { siteName: settings.siteName, baseUrl: ctx.config.PUBLIC_BASE_URL, accentColor: settings.accentColor };
  // Placeholders only: the real token is filled in right before sending.
  const links = subscriberLinks(ctx.config, sub.id, TOKEN_PLACEHOLDERS);
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
 * POST /api/public/subscriptions. The caller answers 202 for valid input before
 * calling this, and has already checked `serviceIds` with assertPublicServices.
 * - new address: pending subscriber + confirmation mail
 * - pending: preferences unchanged, confirmation re-sent (throttled)
 * - confirmed: preferences unchanged, "manage your subscription" mail (throttled)
 * Preferences of an existing address only change with its manage token, so nobody
 * who merely knows an address can change what its owner subscribed to.
 */
export async function subscribe(ctx: AppContext, input: SubscribeInput, now = new Date()): Promise<void> {
  const { db } = ctx;
  const serviceIds = input.allServices ? [] : input.serviceIds;
  const email = normalizeEmail(input.email);
  const nowIso = now.toISOString();

  const existing = await db.selectFrom('subscribers').selectAll().where('email', '=', email).executeTakeFirst();
  if (!existing) {
    const id = newId();
    const tokenSalt = randomBytes(16).toString('base64url');
    const sub: Subscriber = {
      id,
      email,
      locale: input.locale,
      all_services: input.allServices ? 1 : 0,
      token_salt: tokenSalt,
      confirmed_at: null,
      confirmation_sent_at: null,
      created_at: nowIso,
      updated_at: nowIso,
      ...subscriptionTokenHashes(ctx.config.SECRET_KEY, { id, token_salt: tokenSalt }),
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

  // Existing address: never change preferences without the manage token. A pending
  // one gets the confirmation again (its owner can adjust the choice after confirming),
  // a confirmed one the manage link.
  if (!throttled(existing, now)) {
    await queueAccountMail(ctx, existing, existing.confirmed_at === null ? 'confirm' : 'manage', now);
  }
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
