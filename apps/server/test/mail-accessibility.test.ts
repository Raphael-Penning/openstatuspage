/**
 * Accessibility of the notification mails (WCAG 2.2 AA, docs/accessibility.md).
 */
import { contrastRatio } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import {
  confirmationMail,
  incidentMail,
  maintenanceMail,
  manageMail,
  testMail,
  type RenderedMail,
} from '../src/mail/templates.js';

const site = { siteName: 'Example Status', baseUrl: 'https://status.example.com', accentColor: '#7c6cf2' };
const links = {
  manageUrl: 'https://status.example.com/subscription/manage?id=1#token=abc',
  unsubscribeUrl: 'https://status.example.com/subscription/manage?id=1&unsubscribe=1#token=abc',
};
const incident = {
  id: 'inc-1',
  title: 'API errors',
  status: 'investigating',
  impact: 'major',
  services: ['API'],
  message: 'We are looking into it.',
  isNew: true,
};
const maintenance = {
  id: 'm-1',
  title: 'Database upgrade',
  description: 'Short read-only window.',
  status: 'scheduled',
  scheduledStart: '2026-03-01T22:00:00.000Z',
  scheduledEnd: '2026-03-02T01:30:00.000Z',
  services: ['API'],
  message: '',
};

function allMails(locale: 'en' | 'de', accentColor = site.accentColor): [string, RenderedMail][] {
  const s = { ...site, accentColor };
  return [
    ['confirmation', confirmationMail(s, locale, 'https://status.example.com/subscription/confirm?id=1#token=x')],
    ['manage', manageMail(s, locale, links.manageUrl)],
    ['test', testMail(s, locale)],
    ['incident', incidentMail(s, locale, incident, links)],
    ['maintenance scheduled', maintenanceMail(s, locale, 'scheduled', maintenance, links)],
    ['maintenance update', maintenanceMail(s, locale, 'update', { ...maintenance, status: 'in_progress' }, links)],
    ['maintenance reminder', maintenanceMail(s, locale, 'reminder', maintenance, links)],
  ];
}

/** Every "color:… ; background:…" pair used for text in the mail, plus the page colors. */
function textColorPairs(html: string): { fg: string; bg: string }[] {
  const pairs: { fg: string; bg: string }[] = [];
  for (const m of html.matchAll(/style="([^"]*)"/g)) {
    const style = m[1]!;
    const fg = /(?:^|;)color:(#[0-9a-fA-F]{6})/.exec(style)?.[1];
    const bg = /background:(#[0-9a-fA-F]{6})/.exec(style)?.[1];
    if (fg && bg) pairs.push({ fg, bg });
  }
  return pairs;
}

const textOf = (html: string) =>
  html
    .replace(/<head>[\s\S]*<\/head>/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

describe.each(['en', 'de'] as const)('mail accessibility (%s)', (locale) => {
  it.each(allMails(locale))('%s mail has language, direction, title and a heading', (_name, mail) => {
    expect(mail.html).toMatch(new RegExp(`<html lang="${locale}" dir="ltr">`));
    expect(mail.html).toContain(`<title>${mail.subject}</title>`);
    expect(mail.html.match(/<h1[ >]/g)).toHaveLength(1);
  });

  it.each(allMails(locale))('%s mail marks every table as layout table', (_name, mail) => {
    const tables = mail.html.match(/<table[^>]*>/g) ?? [];
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) expect(table).toContain('role="presentation"');
    expect(mail.html).not.toMatch(/<th[ >]/);
  });

  it.each(allMails(locale))('%s mail uses relative font sizes only', (_name, mail) => {
    for (const m of mail.html.matchAll(/font-size:([^;"]+)/g)) {
      expect(m[1]).toMatch(/^\d+(\.\d+)?em$/);
      expect(Number.parseFloat(m[1]!)).toBeGreaterThanOrEqual(0.875);
    }
  });

  it.each(allMails(locale))('%s mail has no images and readable link texts', (_name, mail) => {
    expect(mail.html).not.toMatch(/<img[ >]/);
    for (const m of mail.html.matchAll(/<a [^>]*>([^<]*)<\/a>/g)) {
      const label = m[1]!.trim();
      // Link texts must say where they lead, not "here" or a bare URL.
      expect(label.length).toBeGreaterThan(5);
      expect(label).not.toMatch(/^(here|hier|click|klick|link|https?:)/i);
    }
  });

  it.each(allMails(locale))('%s mail has sufficient text contrast', (_name, mail) => {
    const pairs = textColorPairs(mail.html);
    expect(pairs.length).toBeGreaterThan(0);
    for (const { fg, bg } of pairs) expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    // Text without its own background sits on the white card or the grey page.
    for (const m of mail.html.matchAll(/style="([^"]*)"/g)) {
      if (/background:/.test(m[1]!)) continue;
      const fg = /(?:^|;)color:(#[0-9a-fA-F]{6})/.exec(m[1]!)?.[1];
      if (!fg) continue;
      expect(contrastRatio(fg, '#ffffff')).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(fg, '#f4f4f5')).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(allMails(locale))('%s mail has a complete plain text part', (_name, mail) => {
    const html = textOf(mail.html);
    // Every link target and every line of text of the HTML part is in the text part too.
    for (const m of mail.html.matchAll(/href="([^"]+)"/g)) {
      expect(mail.text).toContain(m[1]!.replace(/&amp;/g, '&'));
    }
    for (const line of mail.text.split('\n')) {
      // "Label: value" lines are a two-column table in HTML.
      const words = line.replace(/^--$/, '').replace(/: https?:\/\/\S+$/, '').replace(/^([^:]+): /, '$1 ').trim();
      if (words) expect(html).toContain(words);
    }
  });
});

describe('mail button colors', () => {
  it.each(['#7c6cf2', '#ffd400', '#00ff00', '#123456', '#ffffff', '#000000'])(
    'keeps the button text readable for the accent %s',
    (accent) => {
      const mail = incidentMail({ ...site, accentColor: accent }, 'en', incident, links);
      const button = /<a [^>]*style="[^"]*background:(#[0-9a-f]{6});color:(#[0-9a-f]{6})/i.exec(mail.html);
      expect(button).not.toBeNull();
      expect(contrastRatio(button![2]!, button![1]!)).toBeGreaterThanOrEqual(4.5);
    },
  );
});
