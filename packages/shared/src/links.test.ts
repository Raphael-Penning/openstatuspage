import { describe, expect, it } from 'vitest';
import { formatCopyright, isOutboundUrl, outboundHref, type UtmSettings } from './links.js';
import { SettingsInput, zLinkTarget, zSitePath } from './schemas.js';

const SITE = 'https://status.example.com';
const UTM: UtmSettings = { utmEnabled: true, utmSource: 'status page', utmMedium: 'referral', utmCampaign: 'footer' };

describe('isOutboundUrl', () => {
  it('is true only for http(s) URLs on another origin', () => {
    expect(isOutboundUrl('https://example.com/imprint', SITE)).toBe(true);
    expect(isOutboundUrl('http://status.example.com/x', SITE)).toBe(true); // other scheme, other origin
    expect(isOutboundUrl('https://status.example.com/about', SITE)).toBe(false);
    expect(isOutboundUrl('https://STATUS.example.com:443/about', SITE)).toBe(false);
    expect(isOutboundUrl('/about', SITE)).toBe(false);
    expect(isOutboundUrl('mailto:ops@example.com', SITE)).toBe(false);
    expect(isOutboundUrl('javascript:alert(1)', SITE)).toBe(false);
    expect(isOutboundUrl('not a url', SITE)).toBe(false);
  });

  it('treats every absolute http(s) URL as outbound without a site origin', () => {
    expect(isOutboundUrl('https://example.com', null)).toBe(true);
    expect(isOutboundUrl('/about', undefined)).toBe(false);
  });
});

describe('outboundHref', () => {
  it('appends the configured UTM parameters to outbound links', () => {
    expect(outboundHref('https://example.com/imprint', UTM, SITE)).toBe(
      'https://example.com/imprint?utm_source=status%20page&utm_medium=referral&utm_campaign=footer',
    );
  });

  it('keeps existing query parameters and the fragment', () => {
    expect(outboundHref('https://example.com/p?a=1#top', UTM, SITE)).toBe(
      'https://example.com/p?a=1&utm_source=status%20page&utm_medium=referral&utm_campaign=footer#top',
    );
  });

  it('keeps the existing query string exactly as entered', () => {
    const utm = '&utm_source=status%20page&utm_medium=referral&utm_campaign=footer';
    expect(outboundHref('https://ex.com/imp?a=b%20c&flag&x=~;y#top', UTM, SITE)).toBe(`https://ex.com/imp?a=b%20c&flag&x=~;y${utm}#top`);
    expect(outboundHref('https://ex.com/imp?flag', UTM, SITE)).toBe(`https://ex.com/imp?flag${utm}`);
    expect(outboundHref('https://ex.com/imp?a=b+c', UTM, SITE)).toBe(`https://ex.com/imp?a=b+c${utm}`);
    expect(outboundHref('https://ex.com/imp?sig=a~b;c', UTM, SITE)).toBe(`https://ex.com/imp?sig=a~b;c${utm}`);
    expect(outboundHref('https://ex.com/imp?', UTM, SITE)).toBe(`https://ex.com/imp?${utm.slice(1)}`);
    expect(outboundHref('https://ex.com/imp?a=1&', UTM, SITE)).toBe(`https://ex.com/imp?a=1${utm}`);
  });

  it('encodes the UTM values with encodeURIComponent', () => {
    expect(outboundHref('https://ex.com/', { utmEnabled: true, utmSource: 'a&b=c+d/é' }, SITE)).toBe(
      'https://ex.com/?utm_source=a%26b%3Dc%2Bd%2F%C3%A9',
    );
  });

  it('leaves out empty parameters', () => {
    expect(outboundHref('https://example.com/', { utmEnabled: true, utmSource: 'status', utmMedium: ' ', utmCampaign: null }, SITE)).toBe(
      'https://example.com/?utm_source=status',
    );
  });

  it('changes nothing when UTM is off or nothing is configured', () => {
    expect(outboundHref('https://example.com/a', { ...UTM, utmEnabled: false }, SITE)).toBe('https://example.com/a');
    expect(outboundHref('https://example.com/a', null, SITE)).toBe('https://example.com/a');
    expect(outboundHref('https://example.com/a', { utmEnabled: true }, SITE)).toBe('https://example.com/a');
  });

  it('never touches same-origin links, relative paths, mailto: or other schemes', () => {
    for (const href of ['https://status.example.com/about', '/about', 'mailto:ops@example.com', 'tel:+4912345', 'javascript:void(0)']) {
      expect(outboundHref(href, UTM, SITE)).toBe(href);
    }
  });

  it('never overwrites or mixes existing utm_ parameters', () => {
    const href = 'https://example.com/?utm_source=newsletter';
    expect(outboundHref(href, UTM, SITE)).toBe(href);
    expect(outboundHref('https://example.com/?UTM_Campaign=x', UTM, SITE)).toBe('https://example.com/?UTM_Campaign=x');
  });

  it('is deterministic (server render and hydration agree)', () => {
    expect(outboundHref('https://example.com/a', UTM, SITE)).toBe(outboundHref('https://example.com/a', UTM, SITE));
  });
});

describe('formatCopyright', () => {
  it('replaces every {year}', () => {
    expect(formatCopyright('© {year} Example GmbH', 2026)).toBe('© 2026 Example GmbH');
    expect(formatCopyright('{year}–{year}', 2026)).toBe('2026–2026');
    expect(formatCopyright('Example', 2026)).toBe('Example');
  });
});

describe('link settings validation', () => {
  const base = { siteName: 'Status' };
  const ok = (extra: Record<string, unknown>) => SettingsInput.safeParse({ ...base, ...extra }).success;

  it('accepts http(s) legal and brand links and rejects other schemes', () => {
    for (const key of ['imprintUrl', 'privacyUrl', 'accessibilityUrl', 'brandUrl']) {
      expect(ok({ [key]: 'https://example.com/legal' })).toBe(true);
      expect(ok({ [key]: null })).toBe(true);
      for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.com', '/imprint', '//evil.example', 'mailto:a@b.c']) {
        expect(ok({ [key]: bad }), `${key}=${bad}`).toBe(false);
      }
    }
  });

  it('allows same-site paths and http(s) URLs for the info link only', () => {
    for (const good of ['/about', '/', '/help/status?x=1#a', 'https://example.com/status-explained']) {
      expect(ok({ infoLinkUrl: good }), good).toBe(true);
    }
    for (const bad of ['//evil.example', '/\\evil.example', '\\\\evil.example', '/\t/evil.example', '/ /x', 'about', 'javascript:alert(1)', 'JavaScript:alert(1)', 'https:/evil', 'data:,x']) {
      expect(ok({ infoLinkUrl: bad }), JSON.stringify(bad)).toBe(false);
    }
  });

  it('exposes the path and link target validators', () => {
    expect(zSitePath.safeParse('/a').success).toBe(true);
    expect(zSitePath.safeParse('//a').success).toBe(false);
    expect(zLinkTarget.safeParse('https://a.example').success).toBe(true);
  });

  it('trims the info link like the other link fields', () => {
    expect(zLinkTarget.parse(' https://a.example/x ')).toBe('https://a.example/x');
    expect(zLinkTarget.parse('\t/about\n')).toBe('/about');
    expect(SettingsInput.parse({ ...base, infoLinkUrl: ' /about' }).infoLinkUrl).toBe('/about');
    expect(SettingsInput.parse({ ...base, imprintUrl: ' https://a.example/i' }).imprintUrl).toBe('https://a.example/i');
  });

  it('rejects multi-line labels, notices and UTM values', () => {
    expect(ok({ imprintLabel: 'Imprint\nX' })).toBe(false);
    expect(ok({ copyrightText: '© {year}\r\nX' })).toBe(false);
    expect(ok({ utmSource: 'a\nb' })).toBe(false);
    expect(ok({ imprintLabel: 'x'.repeat(61) })).toBe(false);
  });

  it('has defaults that hide everything new and keep the attribution', () => {
    const s = SettingsInput.parse(base);
    expect(s).toMatchObject({
      imprintLabel: '',
      copyrightText: '',
      showPoweredBy: true,
      infoLinkLabel: '',
      utmEnabled: false,
      utmSource: '',
    });
    expect(s.imprintUrl).toBeUndefined();
    expect(s.infoLinkUrl).toBeUndefined();
  });
});
