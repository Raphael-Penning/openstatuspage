/**
 * The generic SMS provider: one HTTP request built from a template (method,
 * URL, headers, form or JSON body, success status codes) with placeholders:
 *
 *   {{to}}          the number in E.164 ("+491512345678")
 *   {{to_digits}}   the number without "+" ("491512345678")
 *   {{from}}        the sender (setting `from`)
 *   {{text}}        the message
 *   {{username}}    credential 1 (account SID, API key, ...)
 *   {{password}}    credential 2 (auth token, API secret, ...)
 *   {{basic_auth}}  base64("username:password") for an Authorization: Basic header
 *
 * Values are encoded for where they stand: URL-encoded in the URL and in form
 * bodies, JSON-escaped in JSON bodies (inside a string), without line breaks in
 * headers. The request goes through the SSRF guard (lib/safe-http.ts).
 *
 * Presets fill the template for common providers. They follow the providers'
 * public REST APIs as documented in late 2026 (docs/webhooks-and-sms.md#sms lists the
 * assumptions); every field stays editable.
 */
import type { SmsPreset, SmsProviderInput } from '@openstatuspage/shared';
import { OutboundRequestError, safeRequest, type SafeRequestOptions } from '../../lib/safe-http.js';
import type { SmsCredentials, StoredSmsProvider } from './settings.js';

export type SmsTemplate = Omit<SmsProviderInput, 'username' | 'password' | 'enabled'>;

export const SMS_PRESET_TEMPLATES: Record<Exclude<SmsPreset, 'custom'>, SmsTemplate> = {
  // POST /2010-04-01/Accounts/{AccountSid}/Messages.json, HTTP Basic (Account SID : Auth Token),
  // form fields To, From (a Twilio number or messaging service), Body; 201 Created.
  twilio: {
    preset: 'twilio',
    method: 'POST',
    url: 'https://api.twilio.com/2010-04-01/Accounts/{{username}}/Messages.json',
    headers: [{ name: 'Authorization', value: 'Basic {{basic_auth}}' }],
    bodyType: 'form',
    body: 'To={{to}}&From={{from}}&Body={{text}}',
    from: '',
    successStatuses: [201],
  },
  // Messages API v1: POST /v1/messages, HTTP Basic (API key : API secret), JSON with
  // message_type "text", channel "sms", numbers without "+"; 202 Accepted.
  vonage: {
    preset: 'vonage',
    method: 'POST',
    url: 'https://api.nexmo.com/v1/messages',
    headers: [{ name: 'Authorization', value: 'Basic {{basic_auth}}' }],
    bodyType: 'json',
    body: '{"message_type":"text","channel":"sms","to":"{{to_digits}}","from":"{{from}}","text":"{{text}}"}',
    from: '',
    successStatuses: [202],
  },
  // POST /api/sms with the API key in X-Api-Key; form fields to, from, text. Answers 200 also for some
  // rejected messages (the "success" code is in the body), see docs.
  seven: {
    preset: 'seven',
    method: 'POST',
    url: 'https://gateway.seven.io/api/sms',
    headers: [
      { name: 'X-Api-Key', value: '{{password}}' },
      { name: 'Accept', value: 'application/json' },
    ],
    bodyType: 'form',
    body: 'to={{to}}&from={{from}}&text={{text}}',
    from: '',
    successStatuses: [200],
  },
  // REST API: POST /messages, "Authorization: AccessKey <key>", JSON recipients/originator/body; 201 Created.
  messagebird: {
    preset: 'messagebird',
    method: 'POST',
    url: 'https://rest.messagebird.com/messages',
    headers: [{ name: 'Authorization', value: 'AccessKey {{password}}' }],
    bodyType: 'json',
    body: '{"recipients":["{{to_digits}}"],"originator":"{{from}}","body":"{{text}}"}',
    from: '',
    successStatuses: [201],
  },
};

const PLACEHOLDER = /\{\{\s*(to|to_digits|from|text|username|password|basic_auth)\s*\}\}/g;

type Values = Record<'to' | 'to_digits' | 'from' | 'text' | 'username' | 'password' | 'basic_auth', string>;

function fill(template: string, values: Values, encode: (v: string) => string): string {
  return template.replace(PLACEHOLDER, (_m, name: keyof Values) => encode(values[name]));
}

const jsonString = (v: string) => JSON.stringify(v).slice(1, -1);
const headerValue = (v: string) => v.replace(/[\r\n\u0000]/g, ' ');

export interface SmsRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** The request for one SMS. */
export function buildSmsRequest(provider: SmsTemplate, creds: SmsCredentials, to: string, text: string): SmsRequest {
  const username = creds.username ?? '';
  const password = creds.password ?? '';
  const values: Values = {
    to,
    to_digits: to.replace(/^\+/, ''),
    from: provider.from,
    text,
    username,
    password,
    basic_auth: Buffer.from(`${username}:${password}`).toString('base64'),
  };
  const headers: Record<string, string> = {};
  if (provider.bodyType === 'form') headers['content-type'] = 'application/x-www-form-urlencoded';
  if (provider.bodyType === 'json') headers['content-type'] = 'application/json';
  for (const h of provider.headers) headers[h.name.toLowerCase()] = fill(h.value, values, headerValue);
  const body =
    provider.bodyType === 'none' || provider.method === 'GET'
      ? undefined
      : fill(provider.body, values, provider.bodyType === 'json' ? jsonString : encodeURIComponent);
  return { url: fill(provider.url, values, encodeURIComponent), method: provider.method, headers, body };
}

export interface SmsResult {
  ok: boolean;
  status: number | null;
  /** Secret-free description for the delivery log. */
  message: string;
  /** Worth another attempt (network error, 408, 425, 429, 5xx). */
  retry: boolean;
}

/** E.164 numbers in provider answers are masked before they are stored or logged. */
export function maskNumbers(text: string): string {
  return text.replace(/\+?\d{7,15}/g, (n) => `${n.slice(0, 3)}…${n.slice(-2)}`);
}

export const retryableStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;

/** Sends one SMS through the provider; never throws. */
export async function sendSms(
  provider: StoredSmsProvider,
  creds: SmsCredentials,
  to: string,
  text: string,
  options: SafeRequestOptions = {},
  request: typeof safeRequest = safeRequest,
): Promise<SmsResult> {
  if (!provider.url) return { ok: false, status: null, message: 'No SMS provider configured', retry: false };
  const req = buildSmsRequest(provider, creds, to, text);
  try {
    const res = await request(req.url, { method: req.method, headers: req.headers, body: req.body }, options);
    if (provider.successStatuses.includes(res.status)) return { ok: true, status: res.status, message: `HTTP ${res.status}`, retry: false };
    // Only the status and a short, masked detail: provider answers may quote the request.
    const detail = maskNumbers(res.body.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()).slice(0, 160);
    const secretFree = [creds.username, creds.password].reduce<string>(
      (text, secret) => (secret && secret.length >= 4 ? text.replaceAll(secret, '***') : text),
      detail,
    );
    return {
      ok: false,
      status: res.status,
      message: secretFree ? `HTTP ${res.status}: ${secretFree}` : `HTTP ${res.status}`,
      retry: retryableStatus(res.status),
    };
  } catch (err) {
    const refused = err instanceof OutboundRequestError && (err.code === 'scheme' || err.code === 'address');
    return { ok: false, status: null, message: err instanceof Error ? err.message : 'request failed', retry: !refused };
  }
}
