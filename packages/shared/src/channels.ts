/**
 * Notification channels besides email: webhooks (Discord, Slack, Microsoft
 * Teams, generic JSON) and SMS. Pure helpers without zod, shared by the server
 * and the pages: URL rules of the webhook kinds, phone numbers (E.164) and the
 * length of SMS texts (GSM-7 or UCS-2).
 */

/** Kinds of webhooks (admin and subscriber). */
export const WEBHOOK_KINDS = ['discord', 'slack', 'teams', 'generic'] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

/** Channels a visitor can subscribe with. */
export const SUBSCRIPTION_CHANNELS = ['email', 'webhook', 'sms'] as const;
export type SubscriptionChannel = (typeof SUBSCRIPTION_CHANNELS)[number];

/** Presets of the generic SMS provider (they fill the request template). */
export const SMS_PRESETS = ['custom', 'twilio', 'vonage', 'seven', 'messagebird'] as const;
export type SmsPreset = (typeof SMS_PRESETS)[number];

/** Header of the generic webhooks: Unix time (seconds) of the signature. */
export const WEBHOOK_TIMESTAMP_HEADER = 'x-osp-timestamp';
/** Header of the generic webhooks: `v1=<hex HMAC-SHA256 of "<timestamp>.<body>">`. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-osp-signature';
/** Version of the generic webhook payload (field `version`). */
export const WEBHOOK_PAYLOAD_VERSION = 1;

/** The WHATWG URL of Node.js and browsers (this package compiles without DOM or Node types). */
interface WhatwgUrl {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly username: string;
  readonly password: string;
  readonly pathname: string;
  readonly hash: string;
  toString(): string;
}
const Url = (globalThis as unknown as { URL: new (input: string) => WhatwgUrl }).URL;

/** Longest webhook URL. */
export const MAX_WEBHOOK_URL = 2048;

/**
 * Official hosts and paths of the webhook kinds a visitor may subscribe with
 * (generic URLs only when the admin allows them). Teams: the Workflows
 * ("Post to a channel when a webhook request is received") trigger URLs of
 * Azure Logic Apps and Power Automate; the retired Office 365 connectors are not accepted.
 */
const OFFICIAL: Record<Exclude<WebhookKind, 'generic'>, { host: RegExp; path: RegExp }> = {
  discord: {
    host: /^(?:(?:canary|ptb)\.)?discord(?:app)?\.com$/,
    path: /^\/api\/(?:v\d{1,2}\/)?webhooks\/\d{1,25}\/[A-Za-z0-9_-]{1,200}\/?$/,
  },
  slack: {
    host: /^hooks\.slack\.com$/,
    path: /^\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{1,300}$/,
  },
  teams: {
    host: /^(?:[a-z0-9-]{1,63}\.){2}logic\.azure\.com$|^(?:[a-z0-9-]{1,63}\.){1,3}environment\.api\.powerplatform\.com$/,
    path: /^\/(?:workflows|powerautomate\/automations\/direct\/workflows)\/[A-Za-z0-9]{1,64}\/triggers\/[A-Za-z0-9_-]{1,64}\/paths\/invoke\/?$/,
  },
};

export type WebhookUrlProblem =
  /** Not an absolute URL, too long, or with user info or a fragment. */
  | 'invalid'
  /** http while only https is allowed. */
  | 'insecure'
  /** Not the official host and path of the kind (subscriber webhooks). */
  | 'host'
  /** An IP address or a port other than the default one. */
  | 'address';

export interface WebhookUrlOptions {
  /** A visitor's webhook: Discord, Slack and Teams only on their official hosts. */
  subscriber: boolean;
  /** http allowed (admin webhooks with the explicit option). */
  allowHttp?: boolean;
}

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Checks a webhook URL. Returns the normalized URL, or the problem. The
 * address the host resolves to is checked when the server connects (SSRF
 * guard); this only checks the form of the URL.
 */
export function checkWebhookUrl(
  kind: WebhookKind,
  raw: string,
  options: WebhookUrlOptions,
): { ok: true; url: string } | { ok: false; problem: WebhookUrlProblem } {
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_WEBHOOK_URL || /[\s\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, problem: 'invalid' };
  }
  let url: WhatwgUrl;
  try {
    url = new Url(value);
  } catch {
    return { ok: false, problem: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, problem: 'invalid' };
  if (url.username || url.password || url.hash) return { ok: false, problem: 'invalid' };
  if (url.protocol === 'http:' && !(options.allowHttp && !options.subscriber)) return { ok: false, problem: 'insecure' };
  const host = url.hostname.toLowerCase();
  if (!host || host.startsWith('[') || IPV4_LITERAL.test(host)) return { ok: false, problem: 'address' };
  if (options.subscriber && url.port !== '') return { ok: false, problem: 'address' };
  if (kind !== 'generic') {
    const rule = OFFICIAL[kind];
    if (options.subscriber && (!rule.host.test(host) || !rule.path.test(url.pathname))) {
      return { ok: false, problem: 'host' };
    }
  }
  return { ok: true, url: url.toString() };
}

/** "https://hooks.slack.com/services/T0/B0/xyz" → "hooks.slack.com/…": a hint that reveals no secret path. */
export function webhookHint(url: string): string {
  try {
    const u = new Url(url);
    return `${u.hostname}/…`;
  } catch {
    return '…';
  }
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/** E.164: "+", country calling code, at most 15 digits in all. */
export const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * A phone number as typed ("+49 151 2345-678", "0049 (151) 2345678") in
 * E.164 ("+491512345678"), or null. National numbers without a country code
 * are not accepted (the country cannot be told).
 */
export function normalizePhone(raw: string): string | null {
  const compact = raw.trim().replace(/[\s().\- /]/g, '');
  const withPlus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  return E164.test(withPlus) ? withPlus : null;
}

/** A country calling code (1 to 4 digits, no "+"). */
export const CALLING_CODE = /^[1-9]\d{0,3}$/;

/** Whether an E.164 number starts with one of the calling codes (an empty list allows nothing). */
export function phoneAllowed(phone: string, callingCodes: readonly string[]): boolean {
  return callingCodes.some((code) => CALLING_CODE.test(code) && phone.startsWith(`+${code}`));
}

/** "+491512345678" → "+49 ••• 78": enough to recognize a number, not to dial it. */
export function maskPhone(phone: string): string {
  if (!E164.test(phone)) return '•••';
  return `${phone.slice(0, 3)} ••• ${phone.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// SMS length
// ---------------------------------------------------------------------------

/** The GSM 03.38 basic character set (one septet each). */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
/** The extension table (escape + character: two septets each). */
const GSM7_EXTENDED = '^{}\\[~]|€\f';
const BASIC = new Set(GSM7_BASIC);
const EXTENDED = new Set(GSM7_EXTENDED);

/** Characters outside GSM-7 with a close GSM-7 replacement (typographic quotes, dashes, ellipsis, ...). */
const REPLACEMENTS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '«': '"',
  '»': '"',
  '–': '-',
  '—': '-',
  '−': '-',
  '…': '...',
  ' ': ' ',
  '•': '-',
  '·': '-',
  '\t': ' ',
  'á': 'a',
  'â': 'a',
  'ê': 'e',
  'ë': 'e',
  'í': 'i',
  'î': 'i',
  'ó': 'o',
  'ô': 'o',
  'ú': 'u',
  'û': 'u',
  'ç': 'c',
};

/** Replaces characters that have a close GSM-7 equivalent, so more texts fit GSM-7. */
export function gsm7Friendly(text: string): string {
  let out = '';
  for (const ch of text) out += REPLACEMENTS[ch] ?? ch;
  return out;
}

/** Whether a text can be sent in GSM-7. */
export function isGsm7(text: string): boolean {
  for (const ch of text) if (!BASIC.has(ch) && !EXTENDED.has(ch)) return false;
  return true;
}

export interface SmsLength {
  encoding: 'gsm7' | 'ucs2';
  /** Septets (GSM-7) or UTF-16 code units (UCS-2). */
  units: number;
  segments: number;
}

/** Encoding, length and number of segments of an SMS text (153/67 per segment of a long SMS). */
export function smsLength(text: string): SmsLength {
  if (isGsm7(text)) {
    let units = 0;
    for (const ch of text) units += EXTENDED.has(ch) ? 2 : 1;
    return { encoding: 'gsm7', units, segments: units <= 160 ? 1 : Math.ceil(units / 153) };
  }
  const units = text.length;
  return { encoding: 'ucs2', units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}

/**
 * Shortens `text` (whole characters, with "...") so that `text + suffix` fits
 * one SMS segment. The suffix (a link) is never shortened.
 */
export function fitSms(text: string, suffix: string): string {
  const friendly = gsm7Friendly(text).replace(/\s+/g, ' ').trim();
  const whole = `${friendly}${suffix}`;
  if (smsLength(whole).segments <= 1) return whole;
  const chars = [...friendly];
  let lo = 0;
  let hi = chars.length;
  // Longest prefix that fits with "..." and the suffix.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (smsLength(`${chars.slice(0, mid).join('').trimEnd()}...${suffix}`).segments <= 1) lo = mid;
    else hi = mid - 1;
  }
  return `${chars.slice(0, lo).join('').trimEnd()}...${suffix}`;
}
