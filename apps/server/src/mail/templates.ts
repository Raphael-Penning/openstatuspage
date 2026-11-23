/**
 * Localized notification mails (en/de): plain text plus simple inline-styled HTML.
 *
 * Every template builds a neutral MailContent model that is rendered twice;
 * all dynamic values are escaped by the HTML renderer, so templates never
 * concatenate HTML themselves.
 *
 * Subscriber mails are rendered with token placeholders in their link URLs, which
 * the delivery replaces with the subscriber's real tokens. Placeholders anywhere
 * else (an editor's title or message, a service or site name) are removed while
 * rendering, so only the template-built links can ever carry a token.
 */
import { solidAccent, type SubscriptionLocale } from '@openstatuspage/shared';
import { formatUtcDateTime } from '../lib/time.js';

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export interface MailSite {
  siteName: string;
  baseUrl: string;
  /** Hex color for links and buttons: the accent override of the settings; none: the default accent. */
  accentColor?: string | null;
}

interface MailLink {
  label: string;
  url: string;
}

interface MailContent {
  subject: string;
  heading: string;
  paragraphs: string[];
  fields: [label: string, value: string][];
  /** Free text written by an editor (incident/maintenance update). Newlines are kept. */
  message?: string;
  action?: MailLink;
  footer: string[];
  footerLinks: MailLink[];
}

const TEXTS = {
  en: {
    status: 'Status',
    impact: 'Impact',
    affected: 'Affected services',
    window: 'Scheduled window',
    viewIncident: 'View the incident on the status page',
    viewMaintenance: 'View the maintenance on the status page',
    manage: 'Manage subscription',
    unsubscribe: 'Unsubscribe',
    footer: (site: string) => `You receive this email because you subscribed to status updates from ${site}.`,
    confirm: {
      subject: 'Confirm your subscription',
      heading: 'Confirm your subscription',
      intro: (site: string) =>
        `Please confirm that you want to receive email notifications about incidents and maintenance from ${site}.`,
      button: 'Confirm subscription',
      ignore: 'If you did not request this, you can ignore this email. Without confirmation, no further emails are sent and your address is deleted after 7 days.',
    },
    manageMail: {
      subject: 'Manage your subscription',
      heading: 'Your subscription',
      intro: (site: string) =>
        `Somebody (hopefully you) asked to subscribe this address to ${site}. It is already subscribed. You can change or cancel the subscription here:`,
      ignore: 'If you did not request this, you can ignore this email.',
    },
    incidentNew: (title: string) => `Incident: ${title}`,
    incidentUpdate: (title: string, status: string) => `${title}: ${status}`,
    maintenanceNew: (title: string) => `Scheduled maintenance: ${title}`,
    maintenanceUpdate: (title: string, status: string) => `Maintenance ${title}: ${status}`,
    maintenanceReminder: (title: string) => `Reminder: maintenance ${title}`,
    reminderIntro: (start: string) => `This maintenance starts on ${start}.`,
    scheduledIntro: 'We have scheduled the following maintenance.',
    maintenanceDefaults: {
      scheduled: 'The maintenance has been scheduled.',
      in_progress: 'The maintenance has started.',
      completed: 'The maintenance has been completed.',
      cancelled: 'The maintenance has been cancelled.',
    } as Record<string, string>,
    test: {
      subject: 'Test email',
      heading: 'Test email',
      intro: (site: string) => `This is a test email from ${site}. Email delivery works.`,
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
    viewIncident: 'Vorfall auf der Statusseite ansehen',
    viewMaintenance: 'Wartung auf der Statusseite ansehen',
    manage: 'Abonnement verwalten',
    unsubscribe: 'Abmelden',
    footer: (site: string) => `Du erhältst diese E-Mail, weil du Status-Benachrichtigungen von ${site} abonniert hast.`,
    confirm: {
      subject: 'Bitte bestätige dein Abonnement',
      heading: 'Abonnement bestätigen',
      intro: (site: string) =>
        `Bitte bestätige, dass du E-Mail-Benachrichtigungen zu Vorfällen und Wartungen von ${site} erhalten möchtest.`,
      button: 'Abonnement bestätigen',
      ignore: 'Falls du das nicht angefordert hast, kannst du diese E-Mail ignorieren. Ohne Bestätigung erhältst du keine weiteren E-Mails und deine Adresse wird nach 7 Tagen gelöscht.',
    },
    manageMail: {
      subject: 'Dein Abonnement verwalten',
      heading: 'Dein Abonnement',
      intro: (site: string) =>
        `Jemand (hoffentlich du) wollte diese Adresse für ${site} anmelden. Sie ist bereits angemeldet. Hier kannst du das Abonnement ändern oder beenden:`,
      ignore: 'Falls du das nicht angefordert hast, kannst du diese E-Mail ignorieren.',
    },
    incidentNew: (title: string) => `Vorfall: ${title}`,
    incidentUpdate: (title: string, status: string) => `${title}: ${status}`,
    maintenanceNew: (title: string) => `Geplante Wartung: ${title}`,
    maintenanceUpdate: (title: string, status: string) => `Wartung ${title}: ${status}`,
    maintenanceReminder: (title: string) => `Erinnerung: Wartung ${title}`,
    reminderIntro: (start: string) => `Diese Wartung beginnt am ${start}.`,
    scheduledIntro: 'Wir haben die folgende Wartung geplant.',
    maintenanceDefaults: {
      scheduled: 'Die Wartung wurde geplant.',
      in_progress: 'Die Wartung hat begonnen.',
      completed: 'Die Wartung wurde abgeschlossen.',
      cancelled: 'Die Wartung wurde abgesagt.',
    } as Record<string, string>,
    test: {
      subject: 'Test-E-Mail',
      heading: 'Test-E-Mail',
      intro: (site: string) => `Dies ist eine Test-E-Mail von ${site}. Der E-Mail-Versand funktioniert.`,
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

type Texts = (typeof TEXTS)[SubscriptionLocale];

function texts(locale: SubscriptionLocale): Texts {
  return TEXTS[locale] ?? TEXTS.en;
}

const value = (t: Texts, v: string) => t.values[v] ?? v;

/** Formats an ISO timestamp in UTC, e.g. "17 Nov 2026, 10:00 UTC". */
export function formatUtc(iso: string, locale: SubscriptionLocale): string {
  return `${formatUtcDateTime(iso, locale)} UTC`;
}

/** Formats a time window in UTC, e.g. "17 Nov 2026, 10:00 – 17 Nov 2026, 12:00 UTC". */
export function formatWindow(start: string, end: string, locale: SubscriptionLocale): string {
  return `${formatUtcDateTime(start, locale)} – ${formatUtcDateTime(end, locale)} UTC`;
}

// --- Escaping & rendering ------------------------------------------------------------

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Subjects are single-line header values: CR, LF, tab and the Unicode line breaks
 * (NEL U+0085, LINE SEPARATOR U+2028, PARAGRAPH SEPARATOR U+2029) become spaces,
 * whatever the transport does with them.
 */
function oneLine(value: string): string {
  return value.replace(/[\r\n\t\u0085\u2028\u2029]+/g, ' ').trim();
}

/** Only http(s) URLs end up in links. */
function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : '#';
}

const DEFAULT_ACCENT = '#7c6cf2';

/** The token placeholders of queued subscriber mails (TOKEN_PLACEHOLDERS in services/subscriptions.ts). */
export const TOKEN_PLACEHOLDER_PATTERN = /__OSP_[A-Z]+_TOKEN__/g;

/** Removes token placeholders from a text, also ones that removing an inner one would form. */
export function stripTokenPlaceholders(value: string): string {
  let out = value;
  for (let before = ''; before !== out; ) {
    before = out;
    out = out.replace(TOKEN_PLACEHOLDER_PATTERN, '');
  }
  return out;
}

/** Every text of a mail without token placeholders; only the link URLs keep theirs. */
function withoutPlaceholders(c: MailContent): MailContent {
  const strip = stripTokenPlaceholders;
  return {
    subject: strip(c.subject),
    heading: strip(c.heading),
    paragraphs: c.paragraphs.map(strip),
    fields: c.fields.map(([label, value]) => [strip(label), strip(value)]),
    message: c.message === undefined ? undefined : strip(c.message),
    action: c.action && { label: strip(c.action.label), url: c.action.url },
    footer: c.footer.map(strip),
    footerLinks: c.footerLinks.map((l) => ({ label: strip(l.label), url: l.url })),
  };
}

function render(site: MailSite, locale: SubscriptionLocale, content: MailContent): RenderedMail {
  const clean = withoutPlaceholders(content);
  const cleanSite = { ...site, siteName: stripTokenPlaceholders(site.siteName) };
  const subject = oneLine(`[${cleanSite.siteName}] ${clean.subject}`);
  return { subject, text: renderText(clean), html: renderHtml(cleanSite, locale, subject, clean) };
}

function renderText(c: MailContent): string {
  const blocks: string[] = [c.heading];
  for (const p of c.paragraphs) blocks.push(p);
  if (c.fields.length > 0) blocks.push(c.fields.map(([label, v]) => `${label}: ${v}`).join('\n'));
  if (c.message) blocks.push(c.message.trim());
  if (c.action) blocks.push(`${c.action.label}: ${c.action.url}`);
  const footer = [...c.footer, ...c.footerLinks.map((l) => `${l.label}: ${l.url}`)];
  if (footer.length > 0) blocks.push(`--\n${footer.join('\n')}`);
  return `${blocks.join('\n\n')}\n`;
}

/** Text colors of the mails: >= 4.5:1 on the white card and the grey page background (WCAG 1.4.3). */
const COLOR = {
  text: '#18181b',
  muted: '#52525b',
  page: '#f4f4f5',
  card: '#ffffff',
  border: '#d4d4d8',
  quote: '#fafafa',
} as const;

/**
 * Accessible HTML (WCAG 2.2 AA, see docs/accessibility.md): lang and dir of the
 * mail locale, the subject as <title>, layout tables marked as presentation,
 * a real heading, relative font sizes that follow the reader's settings,
 * contrast-safe colors (the button derives its colors from the accent) and
 * link texts that make sense on their own. The plain text part carries the
 * same content.
 */
function renderHtml(site: MailSite, locale: SubscriptionLocale, subject: string, c: MailContent): string {
  const accent = site.accentColor && /^#[0-9a-fA-F]{6}$/.test(site.accentColor) ? site.accentColor : DEFAULT_ACCENT;
  const button = solidAccent(accent);
  const p = (text: string) => `<p style="margin:0 0 1em;line-height:1.5">${escapeHtml(text)}</p>`;
  const parts: string[] = [];
  parts.push(`<h1 style="font-size:1.375em;line-height:1.3;margin:0 0 0.75em;color:${COLOR.text}">${escapeHtml(c.heading)}</h1>`);
  for (const text of c.paragraphs) parts.push(p(text));
  if (c.fields.length > 0) {
    const rows = c.fields
      .map(
        ([label, v]) =>
          `<tr><td style="padding:0.25em 1em 0.25em 0;color:${COLOR.muted};vertical-align:top">${escapeHtml(label)}</td>` +
          `<td style="padding:0.25em 0;vertical-align:top">${escapeHtml(v)}</td></tr>`,
      )
      .join('');
    parts.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 1em;font-size:0.9375em;line-height:1.5">${rows}</table>`,
    );
  }
  if (c.message) {
    const lines = c.message.trim().split(/\r?\n/).map(escapeHtml).join('<br>');
    parts.push(
      `<div style="margin:0 0 1em;padding:0.75em 1em;border-left:3px solid ${accent};background:${COLOR.quote};line-height:1.5">${lines}</div>`,
    );
  }
  if (c.action) {
    parts.push(
      `<p style="margin:1.5em 0 0.5em"><a href="${escapeHtml(safeUrl(c.action.url))}" ` +
        `style="display:inline-block;padding:0.625em 1.125em;border-radius:6px;background:${button.background};color:${button.foreground};text-decoration:underline;font-weight:600">` +
        `${escapeHtml(c.action.label)}</a></p>`,
    );
  }
  const footerLinks = c.footerLinks
    .map((l) => `<a href="${escapeHtml(safeUrl(l.url))}" style="color:${COLOR.muted};text-decoration:underline">${escapeHtml(l.label)}</a>`)
    .join(' &middot; ');
  const footer = [...c.footer.map((f) => `<p style="margin:0 0 0.5em">${escapeHtml(f)}</p>`)];
  if (footerLinks) footer.push(`<p style="margin:0">${footerLinks}</p>`);
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  return [
    '<!doctype html>',
    `<html lang="${locale}" dir="ltr">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">',
    `<title>${escapeHtml(subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:${COLOR.page};color:${COLOR.text}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.page}"><tr><td align="center" style="padding:1.5em 1em">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;font-family:${font};color:${COLOR.text};font-size:1em;text-align:left">`,
    `<tr><td style="padding:0 0 0.75em;font-size:0.875em;color:${COLOR.muted}">${escapeHtml(site.siteName)}</td></tr>`,
    `<tr><td style="background:${COLOR.card};border:1px solid ${COLOR.border};border-radius:8px;padding:1.5em">${parts.join('')}</td></tr>`,
    `<tr><td style="padding:1em 0 0;font-size:0.875em;color:${COLOR.muted};line-height:1.5">${footer.join('')}</td></tr>`,
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('\n');
}

// --- Templates ----------------------------------------------------------------------------

export interface SubscriberLinks {
  manageUrl: string;
  unsubscribeUrl: string;
}

function subscriberFooter(t: Texts, site: MailSite, links: SubscriberLinks): Pick<MailContent, 'footer' | 'footerLinks'> {
  return {
    footer: [t.footer(site.siteName)],
    footerLinks: [
      { label: t.manage, url: links.manageUrl },
      { label: t.unsubscribe, url: links.unsubscribeUrl },
    ],
  };
}

export function confirmationMail(site: MailSite, locale: SubscriptionLocale, confirmUrl: string): RenderedMail {
  const t = texts(locale);
  return render(site, locale, {
    subject: t.confirm.subject,
    heading: t.confirm.heading,
    paragraphs: [t.confirm.intro(site.siteName)],
    fields: [],
    action: { label: t.confirm.button, url: confirmUrl },
    footer: [t.confirm.ignore],
    footerLinks: [],
  });
}

export function manageMail(site: MailSite, locale: SubscriptionLocale, manageUrl: string): RenderedMail {
  const t = texts(locale);
  return render(site, locale, {
    subject: t.manageMail.subject,
    heading: t.manageMail.heading,
    paragraphs: [t.manageMail.intro(site.siteName)],
    fields: [],
    action: { label: t.manage, url: manageUrl },
    footer: [t.manageMail.ignore],
    footerLinks: [],
  });
}

export function testMail(site: MailSite, locale: SubscriptionLocale): RenderedMail {
  const t = texts(locale);
  return render(site, locale, {
    subject: t.test.subject,
    heading: t.test.heading,
    paragraphs: [t.test.intro(site.siteName)],
    fields: [],
    footer: [],
    footerLinks: [],
  });
}

export interface IncidentMailData {
  id: string;
  title: string;
  status: string;
  impact: string;
  /** Names of affected PUBLIC services only. */
  services: string[];
  /** The update being announced. */
  message: string;
  /** First announcement of the incident (vs. a follow-up update). */
  isNew: boolean;
}

export function incidentMail(
  site: MailSite,
  locale: SubscriptionLocale,
  incident: IncidentMailData,
  links: SubscriberLinks,
): RenderedMail {
  const t = texts(locale);
  const status = value(t, incident.status);
  const fields: MailContent['fields'] = [
    [t.status, status],
    [t.impact, value(t, incident.impact)],
  ];
  if (incident.services.length > 0) fields.push([t.affected, incident.services.join(', ')]);
  return render(site, locale, {
    subject: incident.isNew ? t.incidentNew(incident.title) : t.incidentUpdate(incident.title, status),
    heading: incident.title,
    paragraphs: [],
    fields,
    message: incident.message,
    action: { label: t.viewIncident, url: `${site.baseUrl}/incidents/${encodeURIComponent(incident.id)}` },
    ...subscriberFooter(t, site, links),
  });
}

export type MaintenanceMailKind = 'scheduled' | 'update' | 'reminder';

export interface MaintenanceMailData {
  id: string;
  title: string;
  description: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
  /** Names of affected PUBLIC services only. */
  services: string[];
  /** Update message; empty messages get a localized default text. */
  message: string;
}

export function maintenanceMail(
  site: MailSite,
  locale: SubscriptionLocale,
  kind: MaintenanceMailKind,
  m: MaintenanceMailData,
  links: SubscriberLinks,
): RenderedMail {
  const t = texts(locale);
  const status = value(t, m.status);
  const fields: MailContent['fields'] = [
    [t.status, status],
    [t.window, formatWindow(m.scheduledStart, m.scheduledEnd, locale)],
  ];
  if (m.services.length > 0) fields.push([t.affected, m.services.join(', ')]);

  let subject: string;
  const paragraphs: string[] = [];
  let message: string | undefined;
  if (kind === 'reminder') {
    subject = t.maintenanceReminder(m.title);
    paragraphs.push(t.reminderIntro(formatUtc(m.scheduledStart, locale)));
    if (m.description) message = m.description;
  } else if (kind === 'scheduled') {
    subject = t.maintenanceNew(m.title);
    paragraphs.push(t.scheduledIntro);
    message = m.message.trim() || m.description || undefined;
  } else {
    subject = t.maintenanceUpdate(m.title, status);
    message = m.message.trim() || t.maintenanceDefaults[m.status] || undefined;
  }

  return render(site, locale, {
    subject,
    heading: m.title,
    paragraphs,
    fields,
    message,
    action: { label: t.viewMaintenance, url: `${site.baseUrl}/maintenance/${encodeURIComponent(m.id)}` },
    ...subscriberFooter(t, site, links),
  });
}
