import { createHmac } from 'node:crypto';
import { smsLength } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import {
  confirmMessage,
  discordPayload,
  eventMessage,
  genericPayload,
  signGeneric,
  slackPayload,
  smsText,
  teamsPayload,
  webhookBody,
  type ChannelEvent,
  type RenderContext,
} from '../src/services/channels/messages.js';
import { buildSmsRequest, maskNumbers, SMS_PRESET_TEMPLATES } from '../src/services/channels/sms.js';
import { channelCode, channelManageToken, codeHash } from '../src/services/channels/subscriptions.js';

const incident: ChannelEvent = {
  type: 'incident.created',
  occurredAt: '2026-11-20T10:00:00.000Z',
  incident: {
    id: 'inc-1',
    title: 'API errors <@everyone>',
    status: 'investigating',
    impact: 'major',
    services: ['Public API', 'Dashboard'],
    message: 'We are *looking* into <it> & more @here',
  },
};

const maintenance: ChannelEvent = {
  type: 'maintenance.scheduled',
  occurredAt: '2026-11-20T10:00:00.000Z',
  maintenance: {
    id: 'mnt-1',
    title: 'Database upgrade',
    description: 'Short downtime.',
    status: 'scheduled',
    scheduledStart: '2026-11-21T08:00:00.000Z',
    scheduledEnd: '2026-11-21T09:00:00.000Z',
    services: ['Public API'],
    message: '',
  },
};

const ctx: RenderContext = {
  siteName: 'Example Status',
  baseUrl: 'https://status.example.com',
  locale: 'en',
  manageUrl: 'https://status.example.com/s/abc/def',
  deliveryId: 'dlv-1',
};

describe('event messages', () => {
  it('builds headline, fields and link of an incident', () => {
    const m = eventMessage(incident, ctx);
    expect(m.headline).toBe('Incident: API errors <@everyone>');
    expect(m.fields).toContainEqual(['Status', 'Investigating']);
    expect(m.fields).toContainEqual(['Affected services', 'Public API, Dashboard']);
    expect(m.url).toBe('https://status.example.com/incidents/inc-1');
  });

  it('uses the description for a scheduled maintenance and localizes', () => {
    const m = eventMessage(maintenance, { ...ctx, locale: 'de' });
    expect(m.headline).toBe('Geplante Wartung: Database upgrade');
    expect(m.text).toBe('Short downtime.');
    expect(m.fields[0]).toEqual(['Status', 'Geplant']);
  });
});

describe('Discord', () => {
  it('sends an embed without mentions, with escaped markdown and the manage link', () => {
    const p = discordPayload(eventMessage(incident, ctx), ctx) as {
      allowed_mentions: { parse: string[] };
      embeds: { title: string; description: string; color: number; url: string; fields: unknown[]; footer: { text: string } }[];
    };
    expect(p.allowed_mentions).toEqual({ parse: [] });
    const embed = p.embeds[0]!;
    expect(embed.url).toBe('https://status.example.com/incidents/inc-1');
    expect(embed.description).toContain('\\*looking\\*');
    expect(embed.description).toContain('\\<it\\>');
    expect(embed.description).toContain('(https://status.example.com/s/abc/def)');
    expect(embed.color).toBe(0xea580c);
    expect(embed.fields.length).toBe(3);
  });
});

describe('Slack', () => {
  it('sends Block Kit with escaped mrkdwn and a fallback text', () => {
    const p = slackPayload(eventMessage(incident, ctx), ctx) as { text: string; blocks: { type: string; text?: { text: string } }[] };
    expect(p.blocks[0]).toMatchObject({ type: 'header', text: { type: 'plain_text' } });
    const section = p.blocks.find((b) => b.type === 'section' && b.text)!;
    expect(section.text!.text).toBe('We are *looking* into &lt;it&gt; &amp; more @here');
    expect(p.text).not.toContain('<it>');
    expect(JSON.stringify(p.blocks.at(-1))).toContain('<https://status.example.com/s/abc/def|Manage or unsubscribe>');
  });
});

describe('Microsoft Teams', () => {
  it('wraps an Adaptive Card in the Workflows message envelope', () => {
    const p = teamsPayload(eventMessage(incident, ctx), ctx) as {
      type: string;
      attachments: { contentType: string; content: { type: string; version: string; actions: { url: string }[] } }[];
    };
    expect(p.type).toBe('message');
    expect(p.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(p.attachments[0]!.content.type).toBe('AdaptiveCard');
    expect(p.attachments[0]!.content.version).toBe('1.4');
    expect(p.attachments[0]!.content.actions.map((a) => a.url)).toEqual([
      'https://status.example.com/incidents/inc-1',
      'https://status.example.com/s/abc/def',
    ]);
  });

  it('escapes markdown in editor texts', () => {
    const linked: ChannelEvent = { ...incident, incident: { ...incident.incident!, message: 'See [here](https://evil.example.com) *now*\n1. step' } };
    const p = teamsPayload(eventMessage(linked, ctx), ctx) as { attachments: { content: { body: { text?: string }[] } }[] };
    const texts = p.attachments[0]!.content.body.map((b) => b.text);
    expect(texts[1]).toBe('See \\[here\\]\\(https://evil.example.com\\) \\*now\\*\n1\\. step');
  });
});

describe('generic JSON', () => {
  it('has a stable, versioned schema', () => {
    const p = genericPayload(eventMessage(incident, ctx), ctx);
    expect(p).toEqual({
      version: 1,
      id: 'dlv-1',
      event: 'incident.created',
      occurredAt: '2026-11-20T10:00:00.000Z',
      locale: 'en',
      site: { name: 'Example Status', url: 'https://status.example.com' },
      headline: 'Incident: API errors <@everyone>',
      text: 'We are *looking* into <it> & more @here',
      incident: { ...incident.incident, url: 'https://status.example.com/incidents/inc-1' },
      links: {
        page: 'https://status.example.com',
        event: 'https://status.example.com/incidents/inc-1',
        manage: 'https://status.example.com/s/abc/def',
      },
    });
  });

  it('carries the confirmation code in its own field', () => {
    const body = JSON.parse(webhookBody('generic', confirmMessage(ctx, '123456', ctx.deliveryId), ctx)) as { confirmationCode: string; event: string };
    expect(body).toMatchObject({ event: 'subscription.confirm', confirmationCode: '123456' });
    expect(webhookBody('discord', confirmMessage(ctx, '123456', 'x'), ctx)).toContain('123456');
  });

  it('signs "<timestamp>.<body>" with HMAC-SHA256', () => {
    const headers = signGeneric('whsec_test', '{"a":1}', 1_700_000_000);
    const expected = createHmac('sha256', 'whsec_test').update('1700000000.{"a":1}').digest('hex');
    expect(headers).toEqual({ 'x-osp-timestamp': '1700000000', 'x-osp-signature': `v1=${expected}` });
  });
});

describe('SMS', () => {
  it('fits one segment with the link', () => {
    const long: ChannelEvent = { ...incident, incident: { ...incident.incident!, title: 'Very long title '.repeat(20) } };
    const text = smsText(eventMessage(long, ctx), { ...ctx, shortUrl: ctx.manageUrl });
    expect(smsLength(text).segments).toBe(1);
    expect(text.startsWith('Example Status: Incident: Very long')).toBe(true);
    expect(text.endsWith(' https://status.example.com/s/abc/def')).toBe(true);
  });

  it('puts the code into the confirmation SMS', () => {
    const text = smsText(confirmMessage(ctx, '654321', 'now'), { ...ctx, shortUrl: ctx.manageUrl });
    expect(text).toContain('654321');
    expect(text).toContain(ctx.manageUrl);
  });

  it('never cuts the code or the link of the confirmation SMS', () => {
    const link = 'https://status.example.com/s/abcdefghijkl/abcdefghijklmnopqrstuv';
    for (const siteName of ['Статус сервисов', '服务状态页面', `Example Corporation ${'Holding '.repeat(12)}Ltd`.slice(0, 120)]) {
      for (const locale of ['en', 'de'] as const) {
        const text = smsText(confirmMessage({ siteName, locale }, '123456', 'now'), { siteName, locale, shortUrl: link });
        expect(text, `${siteName} ${locale}`).toContain('123456');
        expect(text.endsWith(` ${link}`), text).toBe(true);
        expect(smsLength(text).segments, text).toBe(1);
      }
    }
    // A short site name is kept whole.
    expect(smsText(confirmMessage(ctx, '123456', 'now'), { ...ctx, shortUrl: link })).toBe(
      `123456 is your code for Example Status. Not you? Ignore it or opt out: ${link}`,
    );
  });
});

describe('SMS provider templates', () => {
  it('Twilio: form body, basic auth, account in the URL', () => {
    const req = buildSmsRequest({ ...SMS_PRESET_TEMPLATES.twilio, from: '+15005550006' }, { username: 'AC123', password: 'tok' }, '+491512345678', 'Hi & bye');
    expect(req.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('AC123:tok').toString('base64')}`);
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(req.body).get('Body')).toBe('Hi & bye');
    expect(new URLSearchParams(req.body).get('To')).toBe('+491512345678');
  });

  it('Vonage and MessageBird: JSON with escaped text and digits only', () => {
    const vonage = buildSmsRequest(SMS_PRESET_TEMPLATES.vonage, { username: 'k', password: 's' }, '+491512345678', 'He said "hi"\n');
    expect(JSON.parse(vonage.body!)).toEqual({ message_type: 'text', channel: 'sms', to: '491512345678', from: '', text: 'He said "hi"\n' });
    const bird = buildSmsRequest({ ...SMS_PRESET_TEMPLATES.messagebird, from: 'Status' }, { password: 'live_x' }, '+491512345678', 'x');
    expect(bird.headers.authorization).toBe('AccessKey live_x');
    expect(JSON.parse(bird.body!)).toEqual({ recipients: ['491512345678'], originator: 'Status', body: 'x' });
  });

  it('seven: API key header without line breaks', () => {
    const req = buildSmsRequest(SMS_PRESET_TEMPLATES.seven, { password: 'key\r\nX-Evil: 1' }, '+491512345678', 'x');
    expect(req.headers['x-api-key']).toBe('key  X-Evil: 1');
  });

  it('masks numbers in provider answers', () => {
    expect(maskNumbers('invalid number +491512345678')).toBe('invalid number +49…78');
  });
});

describe('subscription secrets', () => {
  it('derives a 6-digit code and a short manage token', () => {
    const code = channelCode('k'.repeat(40), 'salt-salt-salt-salt');
    expect(code).toMatch(/^\d{6}$/);
    expect(codeHash('salt', code)).toMatch(/^[0-9a-f]{64}$/);
    expect(channelManageToken('k'.repeat(40), 'id', 'salt')).toHaveLength(22);
  });
});
