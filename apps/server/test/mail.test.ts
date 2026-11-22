import { describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createMailer, OutboxOnlyMailer } from '../src/mail/mailer.js';
import {
  confirmationMail,
  escapeHtml,
  formatWindow,
  incidentMail,
  maintenanceMail,
} from '../src/mail/templates.js';
import {
  fillTokens,
  maskEmail,
  maskEmailsIn,
  subscriberLinks,
  subscriberTokens,
  subscriptionToken,
  TOKEN_PLACEHOLDERS,
} from '../src/services/subscriptions.js';

const site = { siteName: 'Example <Status>', baseUrl: 'https://status.example.com', accentColor: '#123456' };
const links = {
  manageUrl: 'https://status.example.com/subscription/manage?id=1#token=abc',
  unsubscribeUrl: 'https://status.example.com/subscription/manage?id=1&unsubscribe=1#token=abc',
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
    expect(mail.html).toContain('href="https://status.example.com/subscription/manage?id=1&amp;unsubscribe=1#token=abc"');
    expect(mail.html).toContain('background:#123456');
    // Plain text keeps the original characters.
    expect(mail.text).toContain('<script>alert("x")</script>');
    expect(mail.text).toContain('Unsubscribe: https://status.example.com/subscription/manage?id=1&unsubscribe=1#token=abc');
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

  it('masks every address in SMTP error messages', () => {
    expect(maskEmailsIn('550 5.1.1 <jane.doe+status@example.com>: Recipient address rejected')).toBe(
      '550 5.1.1 <j***@example.com>: Recipient address rejected',
    );
    expect(maskEmailsIn('from status@mail.example.com to john@example.com failed')).toBe(
      'from s***@mail.example.com to j***@example.com failed',
    );
    expect(maskEmailsIn('Connection timeout')).toBe('Connection timeout');
  });
});

describe('subscriber links', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SECRET_KEY: 'test-secret-key-that-is-long-enough-1234567890',
    BASE_URL: 'https://status.example.com',
  });

  it('puts the tokens into the query, so the pages work without JavaScript', () => {
    const links = subscriberLinks(config, 'sub-1', { confirm: 'ct', manage: 'mt' });
    expect(links).toEqual({
      confirmUrl: 'https://status.example.com/subscription/confirm?id=sub-1&token=ct',
      manageUrl: 'https://status.example.com/subscription/manage?id=sub-1&token=mt',
      unsubscribeUrl: 'https://status.example.com/subscription/manage?id=sub-1&token=mt&unsubscribe=1',
      oneClickUrl: 'https://status.example.com/api/public/subscriptions/sub-1/unsubscribe?token=mt',
    });
  });

  it('use PUBLIC_BASE_URL instead of the BASE_URL of an admin or worker instance', () => {
    const split = loadConfig({
      NODE_ENV: 'test',
      SECRET_KEY: 'test-secret-key-that-is-long-enough-1234567890',
      BASE_URL: 'https://status.admin.example.com',
      PUBLIC_BASE_URL: 'https://status.example.com/',
    });
    expect(split.PUBLIC_BASE_URL).toBe('https://status.example.com');
    expect(config.PUBLIC_BASE_URL).toBe(config.BASE_URL);
    const links = subscriberLinks(split, 'sub-1', { confirm: 'ct', manage: 'mt' });
    for (const url of Object.values(links)) expect(url.startsWith('https://status.example.com/')).toBe(true);
  });

  it('fills placeholders with the derived tokens', () => {
    const sub = { id: 'sub-1', token_salt: 'salt' };
    const tokens = subscriberTokens(config, sub);
    expect(tokens.confirm).toBe(subscriptionToken(config.SECRET_KEY, 'confirm', sub.id, sub.token_salt));
    const queued = subscriberLinks(config, sub.id, TOKEN_PLACEHOLDERS);
    const real = subscriberLinks(config, sub.id, tokens);
    expect(fillTokens(`${queued.confirmUrl} ${queued.unsubscribeUrl} ${queued.oneClickUrl}`, tokens)).toBe(
      `${real.confirmUrl} ${real.unsubscribeUrl} ${real.oneClickUrl}`,
    );
    // Placeholders survive HTML escaping in the templates.
    const mail = confirmationMail(site, 'en', queued.confirmUrl);
    expect(fillTokens(mail.html, tokens)).toContain(`href="${real.confirmUrl.replaceAll('&', '&amp;')}"`);
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

  it('redacts the link tokens of logged mails in production', async () => {
    const message = {
      to: 'a@example.com',
      subject: 'Confirm',
      text: 'Confirm: https://status.example.com/subscription/confirm?id=sub-1&token=SECRETconfirm_-1\n' +
        'Old: https://status.example.com/subscription/confirm?id=sub-1#token=SECRETfragment',
      html: '<p>Confirm</p>',
      headers: { 'List-Unsubscribe': '<https://status.example.com/api/public/subscriptions/sub-1/unsubscribe?token=SECREToneclick>' },
    };
    const env = { ...base, MAIL_TRANSPORT: 'log', SMTP_FROM: 'status@example.com' };
    logged.length = 0;
    await createMailer(loadConfig({ ...env, NODE_ENV: 'production' }), log).send(message);
    const entry = JSON.stringify(logged[0]);
    expect(entry).not.toContain('SECRET');
    expect(entry).toContain('/subscription/confirm?id=sub-1&token=[redacted]');
    expect(entry).toContain('unsubscribe?token=[redacted]');
    // Development keeps the links usable.
    logged.length = 0;
    await createMailer(loadConfig({ ...env, NODE_ENV: 'development' }), log).send(message);
    expect(JSON.stringify(logged[0])).toContain('token=SECRETconfirm_-1');
  });

  it('never sends from a public instance, but keeps the configured kind', async () => {
    const env = {
      ...base,
      APP_ROLE: 'public',
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMTP_FROM: 'Example Status <status@example.com>',
    };
    const mailer = createMailer(loadConfig(env, { allowSqliteForAnyRole: true }), log);
    expect(mailer).toBeInstanceOf(OutboxOnlyMailer);
    expect(mailer).toMatchObject({ transport: 'smtp', from: 'Example Status <status@example.com>' });
    await expect(mailer.send({ to: 'a@example.com', subject: 's', text: 't', html: 'h' })).rejects.toThrow(/APP_ROLE=public/);
  });
});
