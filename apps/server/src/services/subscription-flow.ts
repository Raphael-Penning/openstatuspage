/**
 * The subscription steps of the public API (routes/subscriptions.ts), in two variants:
 *
 * - Direct (APP_ROLE all/admin, and every role on SQLite): services/subscriptions.ts
 *   reads and writes the subscriber tables.
 * - Database functions (APP_ROLE=public on PostgreSQL): the restricted public role
 *   can neither read nor write the subscriber tables. It calls the SECURITY DEFINER
 *   functions of the osp_public schema (migration 0007_public_role), which check the
 *   token against its stored hash and validate every input themselves. Mails are
 *   queued without content and rendered by the worker.
 *
 * Both variants answer the same: unknown ids and wrong tokens are the same 404.
 */
import { randomBytes } from 'node:crypto';
import type { PublicSubscription, SubscribeInput, SubscriptionLocale, SubscriptionPreferencesInput } from '@openstatuspage/shared';
import { sql } from 'kysely';
import type { Config } from '../config.js';
import type { AppContext } from '../context.js';
import { badRequest, notFound, type HttpError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import {
  confirmSubscription,
  type ConfirmResult,
  deleteSubscriber,
  findByToken,
  normalizeEmail,
  subscribe,
  subscriptionToken,
  subscriptionTokenHashes,
  toPublicSubscription,
  updatePreferences,
} from './subscriptions.js';

/** True when this instance must use the database functions (restricted public role). */
export function usesDatabaseFunctions(config: Pick<Config, 'APP_ROLE' | 'database'>): boolean {
  return config.APP_ROLE === 'public' && config.database.dialect === 'postgres';
}

interface SubscriptionRow {
  id: string;
  email: string;
  locale: SubscriptionLocale;
  all_services: number;
  confirmed: boolean;
  service_ids: string[];
}

function fromRow(row: SubscriptionRow): PublicSubscription {
  const allServices = row.all_services === 1;
  return {
    id: row.id,
    email: row.email,
    locale: row.locale,
    allServices,
    serviceIds: allServices ? [] : row.service_ids,
    confirmed: row.confirmed,
  };
}

/**
 * Messages the osp_public functions raise for invalid input (SQLSTATE 22023, migrations
 * 0007 and 0010). Only these reach the client; PostgreSQL's own errors with that code
 * (which may quote values or internals) become a generic 400.
 */
const INPUT_ERRORS = new Set([
  'Invalid id',
  'Invalid email',
  'Invalid locale',
  'Invalid allServices',
  'Select at least one service',
  'Too many services',
  'Unknown service',
  'Invalid token salt',
  'Invalid token hash',
  'Invalid token key',
]);

/** The 400 for an input error of the database functions (SQLSTATE 22023); null for any other error. */
export function databaseInputError(err: unknown): HttpError | null {
  if ((err as { code?: unknown } | null)?.code !== '22023') return null;
  const message = (err as { message?: unknown }).message;
  return badRequest(typeof message === 'string' && INPUT_ERRORS.has(message) ? message : 'Invalid input');
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw databaseInputError(err) ?? err;
  }
}

/** POST /api/public/subscriptions (after the answer; serviceIds are already checked). */
export async function startSubscription(ctx: AppContext, input: SubscribeInput): Promise<void> {
  if (!usesDatabaseFunctions(ctx.config)) return subscribe(ctx, input);
  const id = newId();
  const tokenSalt = randomBytes(16).toString('base64url');
  const hashes = subscriptionTokenHashes(ctx.config.SUBSCRIPTION_TOKEN_KEY, { id, token_salt: tokenSalt });
  const serviceIds = input.allServices ? [] : input.serviceIds;
  // id, salt and hashes are only used when the address is new.
  await call(() =>
    sql`select osp_public.subscribe(${id}, ${normalizeEmail(input.email)}, ${input.locale}, ${input.allServices},
      ${serviceIds}::text[], ${tokenSalt}, ${hashes.confirm_token_hash}, ${hashes.manage_token_hash}, ${hashes.token_key})`.execute(
      ctx.db,
    ),
  );
}

/**
 * Confirms a subscription (idempotent) and returns it; the manage token only for the
 * request that confirmed it (null afterwards). 404 for a wrong token.
 */
export async function confirm(ctx: AppContext, id: string, token: string): Promise<ConfirmResult> {
  if (!usesDatabaseFunctions(ctx.config)) return confirmSubscription(ctx, id, token);
  const { rows } = await call(() =>
    sql<SubscriptionRow & { token_salt: string | null }>`select * from osp_public.subscription_confirm(${id}, ${token})`.execute(
      ctx.db,
    ),
  );
  const row = rows[0];
  if (!row) throw notFound('Subscription');
  // The function returns the salt only to the request that confirmed the subscription.
  return {
    subscription: fromRow(row),
    manageToken: row.token_salt ? subscriptionToken(ctx.config.SUBSCRIPTION_TOKEN_KEY, 'manage', row.id, row.token_salt) : null,
  };
}

/** The subscription for a valid manage token; 404 otherwise. */
export async function getManaged(ctx: AppContext, id: string, token: string | undefined): Promise<PublicSubscription> {
  if (!usesDatabaseFunctions(ctx.config)) return toPublicSubscription(ctx.db, await findByToken(ctx, id, 'manage', token));
  const { rows } = await call(() =>
    sql<SubscriptionRow>`select * from osp_public.subscription_get(${id}, ${token ?? ''})`.execute(ctx.db),
  );
  if (!rows[0]) throw notFound('Subscription');
  return fromRow(rows[0]);
}

/** Replaces the preferences (serviceIds already checked by the caller); 404 for a wrong token. */
export async function updateManaged(
  ctx: AppContext,
  id: string,
  token: string | undefined,
  input: SubscriptionPreferencesInput,
): Promise<PublicSubscription> {
  if (!usesDatabaseFunctions(ctx.config)) {
    return updatePreferences(ctx, await findByToken(ctx, id, 'manage', token), input);
  }
  const serviceIds = input.allServices ? [] : input.serviceIds;
  const { rows } = await call(() =>
    sql<SubscriptionRow>`select * from osp_public.subscription_update(${id}, ${token ?? ''}, ${input.locale},
      ${input.allServices}, ${serviceIds}::text[])`.execute(ctx.db),
  );
  if (!rows[0]) throw notFound('Subscription');
  return fromRow(rows[0]);
}

/** Deletes the subscription for a valid manage token; 404 otherwise. */
export async function unsubscribe(ctx: AppContext, id: string, token: string | undefined): Promise<void> {
  if (!usesDatabaseFunctions(ctx.config)) {
    const sub = await findByToken(ctx, id, 'manage', token);
    await deleteSubscriber(ctx.db, sub.id);
    return;
  }
  const { rows } = await call(() =>
    sql<{ deleted: boolean }>`select osp_public.subscription_delete(${id}, ${token ?? ''}) as deleted`.execute(ctx.db),
  );
  if (!rows[0]?.deleted) throw notFound('Subscription');
}
