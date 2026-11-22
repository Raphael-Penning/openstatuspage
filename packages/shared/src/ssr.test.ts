import { describe, expect, it } from 'vitest';
import { canonicalPath, hasDotSegments, HEAD_ATTR, headElements, isPersonalPath, normalizePath, scriptJson } from './ssr.js';

describe('scriptJson', () => {
  it('cannot close the script element or open a comment, and parses back', () => {
    const value = { title: '</script><script>alert(1)</script>', note: '<!-- & -->', lines: 'a\u2028b\u2029c' };
    const json = scriptJson(value);
    expect(json).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(json)).toEqual(value);
  });
});

describe('headElements', () => {
  const key = (el: { tag: string; attrs: Record<string, string> }) =>
    `${el.tag} ${el.attrs.name ?? el.attrs.property ?? el.attrs.rel ?? el.attrs.type}`;

  it('lists description, robots, canonical, alternates, Open Graph, Twitter card and JSON-LD', () => {
    const els = headElements({
      title: 'Incident · Example',
      description: 'What happened',
      robots: 'index, follow',
      canonical: 'https://status.example.com/incidents/1',
      alternates: [
        { hreflang: 'en', href: 'https://status.example.com/incidents/1' },
        { hreflang: 'x-default', href: 'https://status.example.com/incidents/1' },
      ],
      siteName: 'Example',
      type: 'article',
      locale: 'en_US',
      localeAlternates: ['de_DE'],
      image: 'https://status.example.com/logo.png',
      themeColor: '#123456',
      jsonLd: [{ '@type': 'Article', headline: '</script>' }],
    });
    expect(els.map(key)).toEqual([
      'meta description',
      'meta robots',
      'link canonical',
      'link alternate',
      'link alternate',
      'meta theme-color',
      'meta og:type',
      'meta og:site_name',
      'meta og:title',
      'meta og:description',
      'meta og:url',
      'meta og:locale',
      'meta og:locale:alternate',
      'meta og:image',
      'meta twitter:card',
      'meta twitter:title',
      'meta twitter:description',
      'meta twitter:image',
      'script application/ld+json',
    ]);
    expect(els.every((el) => el.attrs[HEAD_ATTR] === '')).toBe(true);
    expect(els.find((el) => el.attrs.property === 'og:type')?.attrs.content).toBe('article');
    const ld = els.at(-1)!;
    expect(ld.text).not.toContain('<');
    expect(JSON.parse(ld.text!)).toEqual({ '@type': 'Article', headline: '</script>' });
  });

  it('omits what the page does not have (no image, no canonical, no description)', () => {
    const els = headElements({ title: 'Not found · Example', robots: 'noindex', canonical: null });
    expect(els.map(key)).toEqual(['meta robots', 'meta og:type', 'meta og:title', 'meta twitter:card', 'meta twitter:title']);
  });
});

describe('normalizePath / isPersonalPath', () => {
  it('decodes, lower-cases and collapses slashes like the client router', () => {
    expect(normalizePath('/SERVICES//Web?q=1')).toBe('/services/web');
    expect(normalizePath('/%61dmin/x')).toBe('/admin/x');
    expect(normalizePath('/bad%E0%A4%A')).toBe('/bad%e0%a4%a');
  });

  it('treats a backslash as a path separator like the WHATWG URL parser', () => {
    expect(normalizePath('/p\\abc')).toBe('/p/abc');
    expect(normalizePath('/P%5Cabc')).toBe('/p/abc');
    expect(normalizePath('/\\p\\\\abc\\services')).toBe('/p/abc/services');
    expect(normalizePath('/x\\..\\p\\abc')).toBe('/p/abc');
    for (const url of ['/p\\abc', '/p%5cabc', '/subscription\\manage', '\\p/abc']) expect(isPersonalPath(url), url).toBe(true);
  });

  it('resolves dot segments like the router, also percent-encoded ones', () => {
    expect(normalizePath('/./p/abc')).toBe('/p/abc');
    expect(normalizePath('/a/../p/abc?x=1')).toBe('/p/abc');
    expect(normalizePath('/%2e/P/abc')).toBe('/p/abc');
    expect(normalizePath('/x/%2E%2E/subscription/manage')).toBe('/subscription/manage');
    expect(normalizePath('/../../p')).toBe('/p');
    expect(normalizePath('/p/.')).toBe('/p/');
    expect(normalizePath('/..')).toBe('/');
    expect(normalizePath('/services/a..b')).toBe('/services/a..b');
  });

  it('finds dot segments in any spelling', () => {
    for (const url of ['/./p/abc', '/a/../p', '/%2e/p', '/%2E%2E/p', '/x/..%2fp', '/p/.', '/..', '/x\\..\\p', '/x%5c..%5cp']) {
      expect(hasDotSegments(url), url).toBe(true);
    }
    for (const url of ['/', '/p/abc', '/services/a..b', '/history?return=/../p', '/.well-known/x', '/a.b/c']) {
      expect(hasDotSegments(url), url).toBe(false);
    }
  });

  it('canonical paths: lower case, single slashes, no trailing slash', () => {
    expect(canonicalPath('/SERVICES/')).toBe('/services');
    expect(canonicalPath('//history//')).toBe('/history');
    expect(canonicalPath('/')).toBe('/');
    expect(canonicalPath('/services/web-app')).toBe('/services/web-app');
  });

  it('detects personal pages in any spelling', () => {
    for (const url of ['/subscription/manage?id=1&token=x', '/SUBSCRIPTION/manage', '/Subscription/Confirm', '//subscription//manage', '/%73ubscription/manage', '/p/abc', '/P/abc/services/web', '//p//abc', '/%70/abc', '/p', '/./p/abc', '/x/../p/abc', '/%2e/subscription/manage']) {
      expect(isPersonalPath(url), url).toBe(true);
    }
    for (const url of ['/', '/subscribe', '/subscriptions', '/history?return=/subscription/manage', '/pages', '/history?return=/p/abc']) {
      expect(isPersonalPath(url), url).toBe(false);
    }
  });
});
