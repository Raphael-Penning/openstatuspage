/**
 * Settings of the webhook and SMS channels, stored as rows of `settings` (never
 * visible to the public role, which only reads the row `page`):
 *
 * - `channels`: what visitors may subscribe with, and the rate limits (ChannelSettings).
 * - `sms_provider`: the request template of the SMS provider; the credentials
 *   are one SecretBox ciphertext (SECRET_KEY) and never leave the server.
 * - `channel_notices`: which admin notices were sent (one per month for the budget).
 *
 * channelOptions() is what the public pages offer. On a restricted PostgreSQL
 * public role it comes from osp_public.channel_options() (0015), elsewhere it is
 * computed here the same way.
 */
import {
  ChannelSettingsInput,
  SmsProviderInput,
  type ChannelOptions,
  type ChannelSettings,
  type WebhookKind,
} from '@openstatuspage/shared';
import { sql } from 'kysely';
import type { Config } from '../../config.js';
import type { DB } from '../../db/index.js';
import type { SecretBox } from '../../lib/crypto.js';
import { nowIso } from '../../lib/time.js';

const CHANNELS_KEY = 'channels';
const PROVIDER_KEY = 'sms_provider';
const NOTICES_KEY = 'channel_notices';

export const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = ChannelSettingsInput.parse({});

async function readJson(db: DB, key: string): Promise<unknown> {
  const row = await db.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst();
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return undefined;
  }
}

async function writeJson(db: DB, key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  const now = nowIso();
  const exists = await db.selectFrom('settings').select('key').where('key', '=', key).executeTakeFirst();
  if (exists) await db.updateTable('settings').set({ value: json, updated_at: now }).where('key', '=', key).execute();
  else await db.insertInto('settings').values({ key, value: json, updated_at: now }).execute();
}

export async function getChannelSettings(db: DB): Promise<ChannelSettings> {
  const stored = await readJson(db, CHANNELS_KEY);
  const parsed = ChannelSettingsInput.safeParse({ ...DEFAULT_CHANNEL_SETTINGS, ...(typeof stored === 'object' ? stored : {}) });
  return parsed.success ? parsed.data : DEFAULT_CHANNEL_SETTINGS;
}

export async function saveChannelSettings(db: DB, settings: ChannelSettings): Promise<ChannelSettings> {
  // Unique codes, so the list stays readable.
  const value = { ...settings, smsCallingCodes: [...new Set(settings.smsCallingCodes)] };
  await writeJson(db, CHANNELS_KEY, value);
  return value;
}

/** The stored SMS provider: the template plus the encrypted credentials. */
export interface StoredSmsProvider extends Omit<SmsProviderInput, 'username' | 'password'> {
  /** SecretBox of `{ username?, password? }`. */
  credentials: string | null;
}

export const DEFAULT_SMS_PROVIDER: StoredSmsProvider = {
  ...SmsProviderInput.parse({}),
  credentials: null,
};

export async function getSmsProvider(db: DB): Promise<StoredSmsProvider> {
  const stored = await readJson(db, PROVIDER_KEY);
  if (!stored || typeof stored !== 'object') return DEFAULT_SMS_PROVIDER;
  const { credentials, ...rest } = stored as Record<string, unknown>;
  const parsed = SmsProviderInput.safeParse(rest);
  if (!parsed.success) return DEFAULT_SMS_PROVIDER;
  const { username: _u, password: _p, ...template } = parsed.data;
  return { ...template, credentials: typeof credentials === 'string' ? credentials : null };
}

export interface SmsCredentials {
  username?: string;
  password?: string;
}

export function readCredentials(secrets: SecretBox, provider: StoredSmsProvider): SmsCredentials {
  if (!provider.credentials) return {};
  try {
    return secrets.decryptJson<SmsCredentials>(provider.credentials);
  } catch {
    // SECRET_KEY changed: the credentials must be entered again.
    return {};
  }
}

/**
 * Saves the SMS provider. Credentials: undefined keeps the stored value, null
 * (or an empty string) removes it.
 */
export async function saveSmsProvider(db: DB, secrets: SecretBox, input: SmsProviderInput): Promise<StoredSmsProvider> {
  const current = await getSmsProvider(db);
  const creds = readCredentials(secrets, current);
  const next: SmsCredentials = { ...creds };
  for (const key of ['username', 'password'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (value === null || value === '') delete next[key];
    else next[key] = value;
  }
  const { username: _u, password: _p, ...template } = input;
  const stored: StoredSmsProvider = {
    ...template,
    credentials: Object.keys(next).length > 0 ? secrets.encryptJson(next) : null,
  };
  await writeJson(db, PROVIDER_KEY, stored);
  return stored;
}

/** Start of the current calendar month (UTC) as an ISO timestamp. */
export function monthStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** SMS used this month: sent or still pending (the budget counts both). */
export async function smsUsedThisMonth(db: DB, now = new Date()): Promise<number> {
  const row = await db
    .selectFrom('channel_outbox')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('channel', '=', 'sms')
    .where('status', 'in', ['sent', 'pending'])
    .where('created_at', '>=', monthStart(now))
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Webhook kinds visitors may use with these settings. */
export function subscriberWebhookKinds(settings: ChannelSettings): WebhookKind[] {
  if (!settings.webhookSubscriptions) return [];
  return settings.genericWebhookSubscriptions ? ['discord', 'slack', 'teams', 'generic'] : ['discord', 'slack', 'teams'];
}

/** What the public pages offer (same rules as osp_channel_options in 0015). */
export async function computeChannelOptions(db: DB, now = new Date()): Promise<ChannelOptions> {
  const [settings, provider] = await Promise.all([getChannelSettings(db), getSmsProvider(db)]);
  const codes = settings.smsCallingCodes;
  const sms = provider.enabled && codes.length > 0 && (await smsUsedThisMonth(db, now)) < settings.smsMonthlyBudget;
  return { webhookKinds: subscriberWebhookKinds(settings), sms, smsCallingCodes: codes };
}

const NO_CHANNELS: ChannelOptions = { webhookKinds: [], sms: false, smsCallingCodes: [] };

/** The channel options for this instance (database function on a restricted public role). */
export async function channelOptions(db: DB, config: Pick<Config, 'APP_ROLE' | 'database'>): Promise<ChannelOptions> {
  if (config.APP_ROLE === 'public' && config.database.dialect === 'postgres') {
    try {
      const { rows } = await sql<{ webhook_kinds: WebhookKind[]; sms: boolean; sms_calling_codes: string[] }>`
        select * from osp_public.channel_options()`.execute(db);
      const row = rows[0];
      if (!row) return NO_CHANNELS;
      return { webhookKinds: row.webhook_kinds, sms: row.sms, smsCallingCodes: row.sms_calling_codes };
    } catch {
      // Before the next start of an instance that migrates (function not granted yet): nothing offered.
      return NO_CHANNELS;
    }
  }
  return computeChannelOptions(db);
}

interface Notices {
  /** "YYYY-MM" of the month whose budget notice was sent. */
  smsBudgetMonth?: string;
}

/** Claims the budget notice of this month (true once per month). */
export async function claimBudgetNotice(db: DB, now = new Date()): Promise<boolean> {
  const month = now.toISOString().slice(0, 7);
  const stored = ((await readJson(db, NOTICES_KEY)) ?? {}) as Notices;
  if (stored.smsBudgetMonth === month) return false;
  await writeJson(db, NOTICES_KEY, { ...stored, smsBudgetMonth: month });
  return true;
}
