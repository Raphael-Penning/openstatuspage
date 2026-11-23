import { describe, expect, it } from 'vitest';
import {
  checkWebhookUrl,
  fitSms,
  gsm7Friendly,
  isGsm7,
  maskPhone,
  normalizePhone,
  phoneAllowed,
  smsLength,
  webhookHint,
} from './channels.js';
import { ChannelConfirmInput, ChannelSubscribeInput, ChannelSettingsInput } from './schemas.js';

const sub = { subscriber: true } as const;

describe('checkWebhookUrl', () => {
  it('accepts the official hosts of Discord, Slack and Teams for subscribers', () => {
    expect(checkWebhookUrl('discord', 'https://discord.com/api/webhooks/123456/abc_DEF-1', sub).ok).toBe(true);
    expect(checkWebhookUrl('discord', 'https://ptb.discord.com/api/v10/webhooks/1/x', sub).ok).toBe(true);
    expect(checkWebhookUrl('slack', 'https://hooks.slack.com/services/T000/B000/XXXX', sub).ok).toBe(true);
    expect(
      checkWebhookUrl(
        'teams',
        'https://prod-12.westeurope.logic.azure.com:443/workflows/0123abcd/triggers/manual/paths/invoke?api-version=2016-06-01&sig=x',
        sub,
      ).ok,
    ).toBe(true);
    expect(
      checkWebhookUrl(
        'teams',
        'https://default0123.ab.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc123/triggers/manual/paths/invoke?api-version=1',
        sub,
      ).ok,
    ).toBe(true);
  });

  it('rejects other hosts and paths for subscriber webhooks of a named kind', () => {
    expect(checkWebhookUrl('discord', 'https://discord.com.example.com/api/webhooks/1/x', sub)).toEqual({ ok: false, problem: 'host' });
    expect(checkWebhookUrl('discord', 'https://discord.com/api/users/1', sub)).toEqual({ ok: false, problem: 'host' });
    expect(checkWebhookUrl('slack', 'https://example.com/services/T/B/X', sub)).toEqual({ ok: false, problem: 'host' });
    expect(checkWebhookUrl('teams', 'https://outlook.webhook.office.com/webhookb2/x', sub)).toEqual({ ok: false, problem: 'host' });
  });

  it('allows other hosts for admin webhooks of a named kind (the SSRF guard still applies)', () => {
    expect(checkWebhookUrl('slack', 'https://chat.example.com/hooks/abc', { subscriber: false }).ok).toBe(true);
  });

  it('requires https, except for admin webhooks with allowHttp', () => {
    expect(checkWebhookUrl('generic', 'http://hooks.example.com/x', { subscriber: false })).toEqual({ ok: false, problem: 'insecure' });
    expect(checkWebhookUrl('generic', 'http://hooks.example.com/x', { subscriber: false, allowHttp: true }).ok).toBe(true);
    expect(checkWebhookUrl('generic', 'http://hooks.example.com/x', { subscriber: true, allowHttp: true })).toEqual({
      ok: false,
      problem: 'insecure',
    });
  });

  it('rejects user info, fragments, IP literals, other schemes and ports for subscribers', () => {
    expect(checkWebhookUrl('generic', 'https://user:pw@hooks.example.com/x', sub)).toEqual({ ok: false, problem: 'invalid' });
    expect(checkWebhookUrl('generic', 'https://hooks.example.com/x#y', sub)).toEqual({ ok: false, problem: 'invalid' });
    expect(checkWebhookUrl('generic', 'ftp://hooks.example.com/x', sub)).toEqual({ ok: false, problem: 'invalid' });
    expect(checkWebhookUrl('generic', 'https://127.0.0.1/x', sub)).toEqual({ ok: false, problem: 'address' });
    // Decimal and octal forms are normalized to dotted IPv4 by the URL parser.
    expect(checkWebhookUrl('generic', 'https://2130706433/x', sub)).toEqual({ ok: false, problem: 'address' });
    expect(checkWebhookUrl('generic', 'https://0177.0.0.1/x', sub)).toEqual({ ok: false, problem: 'address' });
    expect(checkWebhookUrl('generic', 'https://[::ffff:127.0.0.1]/x', sub)).toEqual({ ok: false, problem: 'address' });
    expect(checkWebhookUrl('generic', 'https://hooks.example.com:8443/x', sub)).toEqual({ ok: false, problem: 'address' });
    expect(checkWebhookUrl('generic', 'https://hooks.example.com/a b', sub)).toEqual({ ok: false, problem: 'invalid' });
  });

  it('hints only the host', () => {
    expect(webhookHint('https://hooks.slack.com/services/T/B/secret')).toBe('hooks.slack.com/…');
  });
});

describe('phone numbers', () => {
  it('normalizes to E.164', () => {
    expect(normalizePhone('+49 151 2345-678')).toBe('+491512345678');
    expect(normalizePhone('0049 (151) 2345678')).toBe('+491512345678');
    expect(normalizePhone('01512345678')).toBeNull();
    expect(normalizePhone('+0123456789')).toBeNull();
    expect(normalizePhone('+1234567890123456')).toBeNull();
  });

  it('allows only listed calling codes', () => {
    expect(phoneAllowed('+491512345678', ['49'])).toBe(true);
    expect(phoneAllowed('+441512345678', ['49'])).toBe(false);
    expect(phoneAllowed('+491512345678', [])).toBe(false);
  });

  it('masks numbers', () => {
    expect(maskPhone('+491512345678')).toBe('+49 ••• 78');
  });
});

describe('SMS length', () => {
  it('counts GSM-7 septets with the extension table', () => {
    expect(isGsm7('Störung: API €')).toBe(true);
    expect(smsLength('a'.repeat(160))).toEqual({ encoding: 'gsm7', units: 160, segments: 1 });
    expect(smsLength('€'.repeat(81)).segments).toBe(2);
    expect(smsLength('a'.repeat(161)).segments).toBe(2);
  });

  it('falls back to UCS-2 for other characters', () => {
    expect(smsLength('😀').encoding).toBe('ucs2');
    expect(smsLength('ж'.repeat(71)).segments).toBe(2);
  });

  it('replaces typographic characters with GSM-7 ones', () => {
    expect(gsm7Friendly('„Hi“ – it’s…')).toBe('"Hi" - it\'s...');
  });

  it('fits a text and a suffix into one segment', () => {
    const fitted = fitSms('x'.repeat(300), ' https://status.example.com/s/abc/def');
    expect(smsLength(fitted).segments).toBe(1);
    expect(fitted.endsWith('... https://status.example.com/s/abc/def')).toBe(true);
    expect(fitSms('Short', ' link')).toBe('Short link');
  });
});

describe('channel schemas', () => {
  it('requires the target of the channel', () => {
    expect(ChannelSubscribeInput.safeParse({ channel: 'sms' }).success).toBe(false);
    expect(ChannelSubscribeInput.safeParse({ channel: 'webhook', url: 'https://x' }).success).toBe(false);
    expect(ChannelSubscribeInput.safeParse({ channel: 'sms', phone: '+491512345678' }).success).toBe(true);
  });

  it('accepts a code with spaces', () => {
    expect(ChannelConfirmInput.parse({ reference: 'a'.repeat(20), code: '123 456' }).code).toBe('123456');
    expect(ChannelConfirmInput.safeParse({ reference: 'a'.repeat(20), code: '12345' }).success).toBe(false);
  });

  it('defaults to no public channels', () => {
    const s = ChannelSettingsInput.parse({});
    expect(s.webhookSubscriptions).toBe(false);
    expect(s.genericWebhookSubscriptions).toBe(false);
    expect(s.smsCallingCodes).toEqual([]);
  });
});
