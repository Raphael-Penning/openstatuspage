/**
 * API contract of the webhook and SMS notifications (admin channels and
 * subscriber channels). Re-exported by schemas.ts; see docs/api.md.
 */
import { z } from 'zod';
import {
  CALLING_CODE,
  SMS_PRESETS,
  WEBHOOK_KINDS,
  type SubscriptionChannel,
  type WebhookKind,
} from './channels.js';
import { SUBSCRIPTION_LOCALES, type SubscriptionLocale } from './subscriptions.js';

export const zWebhookKind = z.enum(WEBHOOK_KINDS);
export const zSmsPreset = z.enum(SMS_PRESETS);
const zLocale = z.enum(SUBSCRIPTION_LOCALES);
const zRefId = z.string().min(1).max(64);

const scope = {
  /** All public incidents and maintenance. When false, only those affecting `serviceIds`. */
  allServices: z.boolean().default(true),
  /** Service ids; required (non-empty) when allServices is false. */
  serviceIds: z.array(zRefId).max(500).default([]),
};
const requireServices = <T extends { allServices: boolean; serviceIds: string[] }>(s: T) =>
  s.allServices || s.serviceIds.length > 0;
const requireServicesIssue = { message: 'Select at least one service', path: ['serviceIds'] };

/** HTTP header name (RFC 9110 token). */
const zHeaderName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'invalid header name');
/** Header value: no line breaks or other control characters. */
const zHeaderValue = z
  .string()
  .max(2000)
  .regex(/^[^\u0000-\u0008\u000a-\u001f\u007f]*$/, 'invalid header value');
export const HeaderInput = z.object({ name: zHeaderName, value: zHeaderValue });
export type HeaderInput = z.infer<typeof HeaderInput>;

/** Webhook and SMS subscriptions offered to visitors (public summary). */
export interface ChannelOptions {
  /** Webhook kinds a visitor may subscribe with (empty: none). */
  webhookKinds: WebhookKind[];
  /** SMS subscriptions are offered (provider enabled, countries allowed, budget left). */
  sms: boolean;
  /** Calling codes of the countries SMS subscriptions accept (without "+"). */
  smsCallingCodes: string[];
}

/** POST /api/public/channel-subscriptions. Always answered with 202 and a `reference` for the code. */
export const ChannelSubscribeInput = z
  .object({
    channel: z.enum(['webhook', 'sms']),
    /** channel webhook: the kind and the URL. */
    webhookKind: zWebhookKind.optional(),
    url: z.string().trim().max(2048).optional(),
    /** channel sms: the number in international form (+491512345678). */
    phone: z.string().trim().max(32).optional(),
    locale: zLocale.default('en'),
    ...scope,
    /** Honeypot, as in SubscribeInput. */
    website: z.string().max(500).optional(),
  })
  .refine(requireServices, requireServicesIssue)
  .refine((s) => s.channel !== 'webhook' || s.webhookKind !== undefined, {
    message: 'Choose the kind of webhook',
    path: ['webhookKind'],
  })
  .refine((s) => s.channel !== 'webhook' || !!s.url, { message: 'Enter the webhook URL', path: ['url'] })
  .refine((s) => s.channel !== 'sms' || !!s.phone, { message: 'Enter the phone number', path: ['phone'] });
export type ChannelSubscribeInput = z.infer<typeof ChannelSubscribeInput>;

/** POST /api/public/channel-subscriptions/confirm: the reference of the subscribe answer and the code. */
export const ChannelConfirmInput = z.object({
  reference: z
    .string()
    .trim()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  code: z
    .string()
    .max(32)
    .transform((v) => v.replace(/\s/g, ''))
    .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code')),
});
export type ChannelConfirmInput = z.infer<typeof ChannelConfirmInput>;

/** PATCH /api/public/channel-subscriptions/:id (manage token in X-Subscription-Token). */
export const ChannelPreferencesInput = z.object({ locale: zLocale.default('en'), ...scope }).refine(requireServices, requireServicesIssue);
export type ChannelPreferencesInput = z.infer<typeof ChannelPreferencesInput>;

/** A webhook or SMS subscription (public, only with its manage token). */
export interface PublicChannelSubscription {
  id: string;
  channel: Exclude<SubscriptionChannel, 'email'>;
  webhookKind: WebhookKind | null;
  /** Masked target: the webhook host or the phone number's first and last digits. */
  target: string;
  locale: SubscriptionLocale;
  allServices: boolean;
  serviceIds: string[];
  confirmed: boolean;
  /** Generic webhooks: the key of the X-OSP-Signature header (only with the manage token). */
  signingSecret?: string;
}

/** POST/PATCH /api/admin/webhooks. `url` and `headers` are write-only (kept when left out of a PATCH). */
export const WebhookInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: zWebhookKind,
    url: z.string().trim().min(1).max(2048),
    enabled: z.boolean().default(true),
    /** Allow an http:// URL (never for subscriber webhooks). */
    allowHttp: z.boolean().default(false),
    ...scope,
    /** Extra headers of generic webhooks (values stored encrypted). */
    headers: z.array(HeaderInput).max(10).default([]),
  })
  .refine(requireServices, requireServicesIssue);
export type WebhookInput = z.infer<typeof WebhookInput>;

/** GET /api/admin/webhooks (admin only). The URL, header values and secret are never returned. */
export interface AdminWebhook {
  id: string;
  name: string;
  kind: WebhookKind;
  /** Host of the URL (the path holds the secret of Discord/Slack/Teams URLs). */
  host: string;
  enabled: boolean;
  allowHttp: boolean;
  allServices: boolean;
  services: { id: string; name: string }[];
  /** Names of the extra headers (values are write-only). */
  headerNames: string[];
  consecutiveFailures: number;
  /** Why it was disabled automatically (null when enabled or disabled by hand). */
  disabledReason: string | null;
  disabledAt: string | null;
  lastDeliveryAt: string | null;
  lastStatusCode: number | null;
  createdAt: string;
  updatedAt: string;
  /** Generic webhooks: the signing secret, only in the answer that created or rotated it. */
  signingSecret?: string;
}

/** One delivery of an admin webhook (GET /api/admin/webhooks/:id/deliveries). No URL, header or body. */
export interface WebhookDelivery {
  id: string;
  event: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  statusCode: number | null;
  error: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
  sentAt: string | null;
}

/** PATCH /api/admin/sms-provider. Credentials are write-only: left out keeps them, null removes them. */
export const SmsProviderInput = z.object({
  enabled: z.boolean().default(false),
  preset: zSmsPreset.default('custom'),
  method: z.enum(['POST', 'PUT', 'GET']).default('POST'),
  /** May hold {{to}}, {{to_digits}}, {{from}}, {{text}}, {{username}}, {{password}} (values URL-encoded). */
  url: z.string().trim().max(2048).default(''),
  headers: z.array(HeaderInput).max(10).default([]),
  bodyType: z.enum(['form', 'json', 'none']).default('form'),
  /** Template of the body: form fields `a={{to}}&b={{text}}` or a JSON document with placeholders in strings. */
  body: z.string().max(4000).default(''),
  from: z.string().trim().max(32).default(''),
  /** Status codes that mean "accepted". */
  successStatuses: z.array(z.number().int().min(100).max(599)).min(1).max(10).default([200, 201, 202]),
  username: z.string().max(500).nullish(),
  password: z.string().max(2000).nullish(),
});
export type SmsProviderInput = z.infer<typeof SmsProviderInput>;

/** GET /api/admin/sms-provider (admin only); credentials only as "set". */
export interface AdminSmsProvider extends Omit<SmsProviderInput, 'username' | 'password'> {
  usernameSet: boolean;
  passwordSet: boolean;
  /** SMS accepted by the provider this calendar month (UTC). */
  sentThisMonth: number;
  monthlyBudget: number;
  /** Public SMS is paused: the monthly budget is used up. */
  budgetExhausted: boolean;
}

/** POST /api/admin/sms-provider/test */
export const SmsTestInput = z.object({ to: z.string().trim().min(4).max(32) });
export type SmsTestInput = z.infer<typeof SmsTestInput>;

/** POST/PATCH /api/admin/sms-recipients: on-call numbers that get every SMS notification of their scope. */
export const SmsRecipientInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(4).max(32),
    enabled: z.boolean().default(true),
    ...scope,
  })
  .refine(requireServices, requireServicesIssue);
export type SmsRecipientInput = z.infer<typeof SmsRecipientInput>;

export interface AdminSmsRecipient {
  id: string;
  name: string;
  phone: string;
  enabled: boolean;
  allServices: boolean;
  services: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

/** PATCH /api/admin/channel-settings: what visitors may subscribe with, and the limits. */
export const ChannelSettingsInput = z.object({
  /** Visitors may subscribe with Discord, Slack and Teams webhooks. */
  webhookSubscriptions: z.boolean().default(false),
  /** ... and with generic webhooks (any https URL that passes the SSRF guard). */
  genericWebhookSubscriptions: z.boolean().default(false),
  /** Countries (calling codes) whose numbers may subscribe by SMS; empty: no public SMS subscriptions. */
  smsCallingCodes: z.array(z.string().trim().regex(CALLING_CODE)).max(50).default([]),
  /** SMS per calendar month (all SMS); when reached, public SMS pauses and admins are notified. */
  smsMonthlyBudget: z.number().int().min(0).max(1_000_000).default(200),
  /** Subscriber webhook deliveries per minute (all subscribers together). */
  subscriberWebhooksPerMinute: z.number().int().min(1).max(10_000).default(60),
  /**
   * Webhook requests per destination and minute: per webhook for admin webhooks and for
   * Discord, Slack and Teams subscribers (those services limit per webhook), per host for
   * generic subscriber webhooks. The setting keeps its name for compatibility.
   */
  webhookHostPerMinute: z.number().int().min(1).max(10_000).default(30),
  /** Subscriber SMS per minute; on-call SMS count toward it but are never postponed. */
  smsPerMinute: z.number().int().min(1).max(10_000).default(30),
  /** Confirmation SMS per hour (public subscriptions together). */
  smsConfirmationsPerHour: z.number().int().min(1).max(10_000).default(20),
});
export type ChannelSettings = z.infer<typeof ChannelSettingsInput>;

/** A subscriber of any channel (GET /api/admin/subscribers?filter[channel]=...). */
export interface AdminChannelSubscriber {
  id: string;
  channel: SubscriptionChannel;
  webhookKind: WebhookKind | null;
  /** Masked phone number or webhook host. */
  target: string;
  locale: SubscriptionLocale;
  allServices: boolean;
  services: { id: string; name: string }[];
  confirmed: boolean;
  createdAt: string;
  confirmedAt: string | null;
}
