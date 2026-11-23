/**
 * Messages of the webhook and SMS channels: the event model and one formatter
 * per destination.
 *
 * - Discord: an embed (title, description, color, fields, link), mentions off.
 * - Slack: Block Kit (header, message, fields, button, context) with a `text` fallback.
 * - Microsoft Teams: an Adaptive Card 1.4 in the message envelope that the
 *   Workflows webhook trigger expects ({ type: "message", attachments: [...] }).
 * - Generic JSON: a stable, versioned document (WEBHOOK_PAYLOAD_VERSION), signed
 *   with HMAC-SHA256 over "<timestamp>.<body>" (see signGeneric, docs/api.md).
 * - SMS: one segment (GSM-7 aware): site, headline and the short manage link.
 *
 * Every message to a subscriber carries the manage/unsubscribe link. Event data
 * only holds what the public page shows (public incidents and maintenance,
 * public service names).
 */
import { createHmac } from 'node:crypto';
import {
  fitSms,
  gsm7Friendly,
  smsLength,
  WEBHOOK_PAYLOAD_VERSION,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type SubscriptionLocale,
  type WebhookKind,
} from '@openstatuspage/shared';
import { formatWindow } from '../../mail/templates.js';

export const CHANNEL_EVENTS = [
  'incident.created',
  'incident.updated',
  'incident.resolved',
  'maintenance.scheduled',
  'maintenance.updated',
  'maintenance.started',
  'maintenance.completed',
  'maintenance.cancelled',
  'maintenance.reminder',
] as const;
export type ChannelEventType = (typeof CHANNEL_EVENTS)[number];
/** Messages that are no status event. */
export type ChannelMessageType = ChannelEventType | 'subscription.confirm' | 'subscription.manage' | 'test';

export interface IncidentEventData {
  id: string;
  title: string;
  status: string;
  impact: string;
  /** Names of affected PUBLIC services. */
  services: string[];
  message: string;
}

export interface MaintenanceEventData {
  id: string;
  title: string;
  description: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
  services: string[];
  message: string;
}

/** The payload stored in channel_outbox for a status event. */
export interface ChannelEvent {
  type: ChannelEventType;
  occurredAt: string;
  incident?: IncidentEventData;
  maintenance?: MaintenanceEventData;
}

export interface RenderContext {
  siteName: string;
  baseUrl: string;
  locale: SubscriptionLocale;
  /** Manage/unsubscribe link (subscriber messages); null for admin channels. */
  manageUrl: string | null;
  /** Delivery id (generic payload, X-OSP-Delivery). */
  deliveryId: string;
}

/** A message before it is formatted for a destination. */
export interface ChannelMessage {
  type: ChannelMessageType;
  occurredAt: string;
  headline: string;
  text: string;
  fields: [label: string, value: string][];
  url: string | null;
  urlLabel: string | null;
  color: number;
  /** The confirmation code (subscription.confirm only). */
  code?: string;
  incident?: IncidentEventData;
  maintenance?: MaintenanceEventData;
}

const TEXTS = {
  en: {
    status: 'Status',
    impact: 'Impact',
    affected: 'Affected services',
    window: 'Scheduled window',
    viewIncident: 'View incident',
    viewMaintenance: 'View maintenance',
    manage: 'Manage or unsubscribe',
    headline: {
      'incident.created': (t: string) => `Incident: ${t}`,
      'incident.updated': (t: string) => `Incident update: ${t}`,
      'incident.resolved': (t: string) => `Resolved: ${t}`,
      'maintenance.scheduled': (t: string) => `Scheduled maintenance: ${t}`,
      'maintenance.updated': (t: string) => `Maintenance update: ${t}`,
      'maintenance.started': (t: string) => `Maintenance started: ${t}`,
      'maintenance.completed': (t: string) => `Maintenance completed: ${t}`,
      'maintenance.cancelled': (t: string) => `Maintenance cancelled: ${t}`,
      'maintenance.reminder': (t: string) => `Reminder: maintenance ${t}`,
    } as Record<ChannelEventType, (title: string) => string>,
    confirm: {
      headline: 'Confirm your subscription',
      text: (site: string, code: string) =>
        `Your confirmation code for ${site} is ${code}. Enter it on the page where you subscribed; it is valid for 24 hours. If you did not ask for this, ignore this message: nothing more will be sent.`,
      // The code comes first: only the site name may be shortened (see confirmSms).
      sms: (site: string, code: string) => `${code} is your code for ${site}. Not you? Ignore it or opt out:`,
      smsNoSite: (code: string) => `${code} is your code. Not you? Ignore it or opt out:`,
    },
    manageMsg: {
      headline: 'Already subscribed',
      text: (site: string) =>
        `Somebody (hopefully you) asked to subscribe this destination to ${site}. It is already subscribed; change or cancel it with the link below.`,
      sms: (site: string) => `${site}: this number is already subscribed. Manage:`,
    },
    test: {
      headline: 'Test message',
      text: (site: string) => `This is a test message from ${site}. Delivery works.`,
    },
    values: {
      investigating: 'Investigating',
      identified: 'Identified',
      monitoring: 'Monitoring',
      resolved: 'Resolved',
      none: 'None',
      minor: 'Minor',
      major: 'Major',
      critical: 'Critical',
      scheduled: 'Scheduled',
      in_progress: 'In progress',
      completed: 'Completed',
      cancelled: 'Cancelled',
    } as Record<string, string>,
  },
  de: {
    status: 'Status',
    impact: 'Auswirkung',
    affected: 'Betroffene Dienste',
    window: 'Geplanter Zeitraum',
    viewIncident: 'Vorfall ansehen',
    viewMaintenance: 'Wartung ansehen',
    manage: 'Verwalten oder abmelden',
    headline: {
      'incident.created': (t: string) => `Vorfall: ${t}`,
      'incident.updated': (t: string) => `Vorfall-Update: ${t}`,
      'incident.resolved': (t: string) => `Behoben: ${t}`,
      'maintenance.scheduled': (t: string) => `Geplante Wartung: ${t}`,
      'maintenance.updated': (t: string) => `Wartungs-Update: ${t}`,
      'maintenance.started': (t: string) => `Wartung begonnen: ${t}`,
      'maintenance.completed': (t: string) => `Wartung abgeschlossen: ${t}`,
      'maintenance.cancelled': (t: string) => `Wartung abgesagt: ${t}`,
      'maintenance.reminder': (t: string) => `Erinnerung: Wartung ${t}`,
    } as Record<ChannelEventType, (title: string) => string>,
    confirm: {
      headline: 'Bestätige dein Abonnement',
      text: (site: string, code: string) =>
        `Dein Bestätigungscode für ${site} ist ${code}. Gib ihn auf der Seite ein, auf der du das Abonnement gestartet hast; er gilt 24 Stunden. Falls du das nicht angefordert hast, ignoriere diese Nachricht: Es folgt nichts weiter.`,
      sms: (site: string, code: string) => `${code} ist dein Code für ${site}. Nicht du? Ignorieren oder abmelden:`,
      smsNoSite: (code: string) => `${code} ist dein Code. Nicht du? Ignorieren oder abmelden:`,
    },
    manageMsg: {
      headline: 'Bereits abonniert',
      text: (site: string) =>
        `Jemand (hoffentlich du) wollte dieses Ziel für ${site} anmelden. Es ist bereits angemeldet; über den Link unten kannst du es ändern oder beenden.`,
      sms: (site: string) => `${site}: Diese Nummer ist bereits angemeldet. Verwalten:`,
    },
    test: {
      headline: 'Testnachricht',
      text: (site: string) => `Dies ist eine Testnachricht von ${site}. Die Zustellung funktioniert.`,
    },
    values: {
      investigating: 'Wird untersucht',
      identified: 'Ursache identifiziert',
      monitoring: 'Wird beobachtet',
      resolved: 'Behoben',
      none: 'Keine',
      minor: 'Gering',
      major: 'Hoch',
      critical: 'Kritisch',
      scheduled: 'Geplant',
      in_progress: 'Läuft',
      completed: 'Abgeschlossen',
      cancelled: 'Abgesagt',
    } as Record<string, string>,
  },
} as const;

type Texts = (typeof TEXTS)['en'];
const texts = (locale: SubscriptionLocale): Texts => (TEXTS[locale] ?? TEXTS.en) as Texts;
const label = (t: Texts, v: string) => t.values[v] ?? v;

const COLORS = {
  critical: 0xdc2626,
  major: 0xea580c,
  minor: 0xca8a04,
  none: 0x2563eb,
  resolved: 0x16a34a,
  maintenance: 0x2563eb,
  neutral: 0x6b7280,
};

/** The message for a status event. */
export function eventMessage(event: ChannelEvent, ctx: Pick<RenderContext, 'baseUrl' | 'locale'>): ChannelMessage {
  const t = texts(ctx.locale);
  if (event.incident) {
    const i = event.incident;
    const fields: ChannelMessage['fields'] = [
      [t.status, label(t, i.status)],
      [t.impact, label(t, i.impact)],
    ];
    if (i.services.length > 0) fields.push([t.affected, i.services.join(', ')]);
    return {
      type: event.type,
      occurredAt: event.occurredAt,
      headline: t.headline[event.type](i.title),
      text: i.message,
      fields,
      url: `${ctx.baseUrl}/incidents/${encodeURIComponent(i.id)}`,
      urlLabel: t.viewIncident,
      color: i.status === 'resolved' ? COLORS.resolved : (COLORS[i.impact as keyof typeof COLORS] ?? COLORS.neutral),
      incident: i,
    };
  }
  const m = event.maintenance!;
  const fields: ChannelMessage['fields'] = [
    [t.status, label(t, m.status)],
    [t.window, formatWindow(m.scheduledStart, m.scheduledEnd, ctx.locale)],
  ];
  if (m.services.length > 0) fields.push([t.affected, m.services.join(', ')]);
  return {
    type: event.type,
    occurredAt: event.occurredAt,
    headline: t.headline[event.type](m.title),
    text: m.message.trim() || (event.type === 'maintenance.scheduled' || event.type === 'maintenance.reminder' ? m.description : ''),
    fields,
    url: `${ctx.baseUrl}/maintenance/${encodeURIComponent(m.id)}`,
    urlLabel: t.viewMaintenance,
    color: m.status === 'completed' ? COLORS.resolved : COLORS.maintenance,
    maintenance: m,
  };
}

/** The confirmation message with its code. */
export function confirmMessage(ctx: Pick<RenderContext, 'siteName' | 'locale'>, code: string, now: string): ChannelMessage {
  const t = texts(ctx.locale);
  return {
    type: 'subscription.confirm',
    occurredAt: now,
    headline: t.confirm.headline,
    text: t.confirm.text(ctx.siteName, code),
    fields: [],
    url: null,
    urlLabel: null,
    color: COLORS.neutral,
    code,
  };
}

/** "Already subscribed" with the manage link (subscribing a confirmed target again). */
export function manageMessage(ctx: Pick<RenderContext, 'siteName' | 'locale'>, now: string): ChannelMessage {
  const t = texts(ctx.locale);
  return {
    type: 'subscription.manage',
    occurredAt: now,
    headline: t.manageMsg.headline,
    text: t.manageMsg.text(ctx.siteName),
    fields: [],
    url: null,
    urlLabel: null,
    color: COLORS.neutral,
  };
}

export function testMessage(ctx: Pick<RenderContext, 'siteName' | 'locale'>, now: string): ChannelMessage {
  const t = texts(ctx.locale);
  return {
    type: 'test',
    occurredAt: now,
    headline: t.test.headline,
    text: t.test.text(ctx.siteName),
    fields: [],
    url: null,
    urlLabel: null,
    color: COLORS.neutral,
  };
}

const cut = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);

// --- Discord -------------------------------------------------------------------------

/** Discord's markdown: escaped, so editor texts cannot format, link or mention. */
function discordText(value: string): string {
  return value.replace(/([\\*_~`|>#[\]()<@-])/g, '\\$1');
}

export function discordPayload(m: ChannelMessage, ctx: RenderContext): unknown {
  const t = texts(ctx.locale);
  const description = [m.text ? discordText(m.text) : '', ctx.manageUrl ? `[${t.manage}](${ctx.manageUrl})` : '']
    .filter(Boolean)
    .join('\n\n');
  return {
    // No pings, whatever the text says.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: cut(m.headline, 256),
        ...(m.url ? { url: m.url } : {}),
        ...(description ? { description: cut(description, 4096) } : {}),
        color: m.color,
        fields: m.fields.slice(0, 25).map(([name, value]) => ({ name: cut(name, 256), value: cut(value, 1024), inline: true })),
        footer: { text: cut(ctx.siteName, 2048) },
        timestamp: m.occurredAt,
      },
    ],
  };
}

// --- Slack ---------------------------------------------------------------------------

/** Slack's mrkdwn control characters (https://api.slack.com/reference/surfaces/formatting#escaping). */
function slackText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function slackPayload(m: ChannelMessage, ctx: RenderContext): unknown {
  const t = texts(ctx.locale);
  const blocks: unknown[] = [{ type: 'header', text: { type: 'plain_text', text: cut(m.headline, 150), emoji: false } }];
  if (m.text) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: cut(slackText(m.text), 3000) } });
  if (m.fields.length > 0) {
    blocks.push({
      type: 'section',
      fields: m.fields.slice(0, 10).map(([name, value]) => ({ type: 'mrkdwn', text: cut(`*${slackText(name)}*\n${slackText(value)}`, 2000) })),
    });
  }
  if (m.url && m.urlLabel) {
    blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: m.urlLabel }, url: m.url }] });
  }
  const context = [slackText(ctx.siteName), ctx.manageUrl ? `<${ctx.manageUrl}|${slackText(t.manage)}>` : ''].filter(Boolean).join(' · ');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: cut(context, 3000) }] });
  return { text: cut(slackText(m.text ? `${m.headline}: ${m.text}` : m.headline), 3000), blocks };
}

// --- Microsoft Teams -----------------------------------------------------------------

export function teamsPayload(m: ChannelMessage, ctx: RenderContext): unknown {
  const t = texts(ctx.locale);
  const body: unknown[] = [{ type: 'TextBlock', text: m.headline, weight: 'Bolder', size: 'Medium', wrap: true }];
  if (m.text) body.push({ type: 'TextBlock', text: m.text, wrap: true });
  if (m.fields.length > 0) body.push({ type: 'FactSet', facts: m.fields.map(([title, value]) => ({ title, value })) });
  body.push({ type: 'TextBlock', text: ctx.siteName, isSubtle: true, size: 'Small', wrap: true });
  const actions: unknown[] = [];
  if (m.url && m.urlLabel) actions.push({ type: 'Action.OpenUrl', title: m.urlLabel, url: m.url });
  if (ctx.manageUrl) actions.push({ type: 'Action.OpenUrl', title: t.manage, url: ctx.manageUrl });
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
          ...(actions.length > 0 ? { actions } : {}),
        },
      },
    ],
  };
}

// --- Generic JSON --------------------------------------------------------------------

/** The generic payload (version 1, documented in docs/api.md#webhooks). */
export function genericPayload(m: ChannelMessage, ctx: RenderContext): unknown {
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    id: ctx.deliveryId,
    event: m.type,
    occurredAt: m.occurredAt,
    locale: ctx.locale,
    site: { name: ctx.siteName, url: ctx.baseUrl },
    headline: m.headline,
    text: m.text,
    ...(m.incident ? { incident: { ...m.incident, url: m.url } } : {}),
    ...(m.maintenance ? { maintenance: { ...m.maintenance, url: m.url } } : {}),
    ...(m.code ? { confirmationCode: m.code } : {}),
    links: { page: ctx.baseUrl, ...(m.url ? { event: m.url } : {}), ...(ctx.manageUrl ? { manage: ctx.manageUrl } : {}) },
  };
}

/** Headers of a signed generic delivery: X-OSP-Timestamp and X-OSP-Signature (v1=hex HMAC-SHA256 of "<ts>.<body>"). */
export function signGeneric(secret: string, body: string, timestamp: number): Record<string, string> {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp), [WEBHOOK_SIGNATURE_HEADER]: `v1=${signature}` };
}

/** The JSON body of a webhook delivery of `kind`. */
export function webhookBody(kind: WebhookKind, m: ChannelMessage, ctx: RenderContext): string {
  // The confirmation code is part of the text (and its own field in the generic payload).
  const payload =
    kind === 'discord'
      ? discordPayload(m, ctx)
      : kind === 'slack'
        ? slackPayload(m, ctx)
        : kind === 'teams'
          ? teamsPayload(m, ctx)
          : genericPayload(m, ctx);
  return JSON.stringify(payload);
}

// --- SMS -----------------------------------------------------------------------------

/** Whether `text` (normalized like fitSms) and `suffix` fit one segment. */
const fitsOneSegment = (text: string, suffix: string) =>
  smsLength(`${gsm7Friendly(text).replace(/\s+/g, ' ').trim()}${suffix}`).segments <= 1;

/**
 * The confirmation SMS. The code and the link are never cut: only the site name
 * is shortened, and dropped when even one character of it does not fit (a
 * Cyrillic or CJK name turns the text into UCS-2 with 70 characters, which the
 * link alone nearly fills). As a last resort the SMS is only "<code> <link>".
 */
function confirmSms(t: Texts, siteName: string, code: string, link: string): string {
  const full = t.confirm.sms(siteName, code);
  if (fitsOneSegment(full, link)) return fitSms(full, link);
  const chars = [...siteName.trim()];
  const withSite = (n: number) => t.confirm.sms(`${chars.slice(0, n).join('').trimEnd()}...`, code);
  let lo = 0;
  let hi = chars.length - 1;
  // Longest prefix of the site name that fits.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fitsOneSegment(withSite(mid), link)) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0 && fitsOneSegment(withSite(lo), link)) return fitSms(withSite(lo), link);
  const bare = t.confirm.smsNoSite(code);
  if (fitsOneSegment(bare, link)) return fitSms(bare, link);
  return `${code}${link}`;
}

/**
 * The SMS text of a message: one segment, the link (if any) never cut. Subscriber
 * SMS carry the short manage link; on-call SMS carry none.
 */
export function smsText(m: ChannelMessage, ctx: Pick<RenderContext, 'siteName' | 'locale'> & { shortUrl: string | null }): string {
  const t = texts(ctx.locale);
  const link = ctx.shortUrl ? ` ${ctx.shortUrl}` : '';
  if (m.type === 'subscription.confirm') return confirmSms(t, ctx.siteName, m.code ?? '', link);
  if (m.type === 'subscription.manage') return fitSms(t.manageMsg.sms(ctx.siteName), link);
  if (m.type === 'test') return fitSms(`${ctx.siteName}: ${m.headline}`, link);
  const status = m.fields[0]?.[1];
  const body = status && !m.headline.includes(status) ? `${m.headline} (${status})` : m.headline;
  return fitSms(`${ctx.siteName}: ${body}`, link);
}
