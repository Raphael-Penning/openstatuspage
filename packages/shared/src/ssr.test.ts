import { describe, expect, it } from 'vitest';
import { HEAD_ATTR, headElements, scriptJson } from './ssr.js';

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
