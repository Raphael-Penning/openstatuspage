import { describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createMailer } from '../src/mail/mailer.js';
import {
  confirmationMail,
  escapeHtml,
  formatWindow,
  incidentMail,
  maintenanceMail,
} from '../src/mail/templates.js';
import { maskEmail } from '../src/services/subscriptions.js';

const site = { siteName: 'Example <Status>', baseUrl: 'https://status.example.com', accentColor: '#123456' };
const links = {
  manageUrl: 'https://status.example.com/subscription/manage?id=1&token=abc',
  unsubscribeUrl: 'https://status.example.com/subscription/manage?id=1&token=abc&unsubscribe=1',
};

describe('mail templates', () => {
  it('escapes every dynamic value in HTML', () => {
    const mail = incidentMail(
      site,
      'en',
      {
        id: 'inc-1',
        title: '<script>alert("x")</script>',
        status: 'investigating',
        impact: 'major',
        services: ['API & "Web"'],
        message: 'Line 1 <b>bold</b>\nLine 2 \'quoted\'',
        isNew: true,
      },
      links,
    );
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<b>bold</b>');
    expect(mail.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(mail.html).toContain('API &amp; &quot;Web&quot;');
    expect(mail.html).toContain('Line 1 &lt;b&gt;bold&lt;/b&gt;<br>Line 2 &#39;quoted&#39;');
    expect(mail.html).toContain('Example &lt;Status&gt;');
    expect(mail.html).toContain('href="https://status.example.com/subscription/manage?id=1&amp;token=abc&amp;unsubscribe=1"');
    expect(mail.html).toContain('background:#123456');
    // Plain text keeps the original characters.
    expect(mail.text).toContain('<script>alert("x")</script>');
    expect(mail.text).toContain('Unsubscribe: https://status.example.com/subscription/manage?id=1&token=abc&unsubscribe=1');
    expect(mail.subject).toBe('[Example <Status>] Incident: <script>alert("x")</script>');
  });

  it('keeps subjects on one line and only links http(s) URLs', () => {
    const mail = confirmationMail({ ...site, siteName: 'Example\r\nBcc: x@example.com' }, 'en', 'javascript:alert(1)');
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain('javascript:');
    expect(mail.html).toContain('href="#"');
  });

  it('renders maintenance windows in UTC and default texts for empty messages', () => {
    const data = {
      id: 'm-1',
      title: 'Upgrade',
      description: '',
      status: 'in_progress',
      scheduledStart: '2026-03-01T22:00:00.000Z',
      scheduledEnd: '2026-03-02T01:30:00.000Z',
      services: [],
      message: '',
    };
    const en = maintenanceMail(site, 'en', 'update', data, links);
    expect(en.text).toContain('The maintenance has started.');
    expect(en.text).toContain(`Scheduled window: ${formatWindow(data.scheduledStart, data.scheduledEnd, 'en')}`);
    expect(formatWindow(data.scheduledStart, data.scheduledEnd, 'en')).toMatch(/22:00 – .*01:30 UTC$/);
    const de = maintenanceMail(site, 'de', 'update', { ...data, status: 'completed' }, links);
    expect(de.subject).toBe('[Example <Status>] Wartung Upgrade: Abgeschlossen');
    expect(de.text).toContain('Die Wartung wurde abgeschlossen.');
    expect(de.text).toContain('Geplanter Zeitraum: ');
    expect(de.text).toContain(' UTC');
  });

  it('escapes HTML special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('masks addresses', () => {
    expect(maskEmail('jane@example.com')).toBe('j***@example.com');
    expect(maskEmail('invalid')).toBe('***');
  });
});

describe('mail configuration', () => {
  const base = { NODE_ENV: 'test', SECRET_KEY: 'test-secret-key-that-is-long-enough-1234567890' };

  it('defaults to smtp with SMTP_HOST and to none otherwise', () => {
    expect(loadConfig({ ...base }).MAIL_TRANSPORT).toBe('none');
    const smtp = loadConfig({ ...base, SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'Example Status <status@example.com>' });
    expect(smtp).toMatchObject({
      MAIL_TRANSPORT: 'smtp',
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      SMTP_TLS_REJECT_UNAUTHORIZED: true,
    });
    const tls = loadConfig({
      ...base,
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_FROM: 'status@example.com',
    });
    expect(tls).toMatchObject({ SMTP_PORT: 465, SMTP_SECURE: true });
    expect(loadConfig({ ...base, MAIL_TRANSPORT: 'none', SMTP_HOST: 'smtp.example.com' }).MAIL_TRANSPORT).toBe('none');
  });

  it('requires SMTP_FROM for smtp and log, and SMTP_HOST for smtp', () => {
    expect(() => loadConfig({ ...base, SMTP_HOST: 'smtp.example.com' })).toThrow(/SMTP_FROM/);
    expect(() => loadConfig({ ...base, MAIL_TRANSPORT: 'log' })).toThrow(/SMTP_FROM/);
    expect(() => loadConfig({ ...base, MAIL_TRANSPORT: 'smtp', SMTP_FROM: 'status@example.com' })).toThrow(/SMTP_HOST/);
    expect(() => loadConfig({ ...base, MAIL_TRANSPORT: 'log', SMTP_FROM: 'not an address' })).toThrow(/SMTP_FROM/);
    expect(() => loadConfig({ ...base, MAIL_TRANSPORT: 'carrier-pigeon' })).toThrow(/MAIL_TRANSPORT/);
    expect(loadConfig({ ...base, MAIL_TRANSPORT: 'log', SMTP_FROM: 'status@example.com' }).MAIL_TRANSPORT).toBe('log');
  });
});

describe('createMailer', () => {
  const base = { NODE_ENV: 'test', SECRET_KEY: 'test-secret-key-that-is-long-enough-1234567890' };
  const logged: unknown[][] = [];
  const log = { info: (...args: unknown[]) => logged.push(args) } as unknown as FastifyBaseLogger;

  it('creates the configured transport', async () => {
    const smtp = createMailer(
      loadConfig({ ...base, SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'Example Status <status@example.com>' }),
      log,
    );
    expect(smtp).toMatchObject({ transport: 'smtp', from: 'Example Status <status@example.com>' });
    smtp.close();

    const none = createMailer(loadConfig({ ...base }), log);
    expect(none).toMatchObject({ transport: 'none', from: null });
    await expect(none.send({ to: 'a@example.com', subject: 's', text: 't', html: 'h' })).rejects.toThrow(/MAIL_TRANSPORT/);

    const logMailer = createMailer(loadConfig({ ...base, MAIL_TRANSPORT: 'log', SMTP_FROM: 'status@example.com' }), log);
    await logMailer.send({ to: 'a@example.com', subject: 'Hello', text: 'Body text', html: '<p>Body</p>' });
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0])).toContain('Body text');
  });
});
