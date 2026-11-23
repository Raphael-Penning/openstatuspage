import { describe, expect, it } from 'vitest';
import { localizedText, SitePageInput, sitePagePath, uploadPathsIn } from './site-pages.js';

describe('site pages', () => {
  it('have stable paths', () => {
    expect(sitePagePath({ systemKey: 'legal-notice', slug: 'legal-notice' })).toBe('/legal-notice');
    expect(sitePagePath({ systemKey: null, slug: 'faq' })).toBe('/pages/faq');
  });

  it('fall back to the other language', () => {
    expect(localizedText({ en: 'About', de: '' }, 'de')).toBe('About');
    expect(localizedText({ en: 'About', de: 'Über' }, 'de')).toBe('Über');
    expect(localizedText({ en: ' ', de: 'Über' }, 'en')).toBe('Über');
  });

  it('validate slug and title', () => {
    expect(SitePageInput.safeParse({ slug: 'faq', title: { en: 'FAQ', de: '' } }).success).toBe(true);
    expect(SitePageInput.safeParse({ slug: 'FAQ', title: { en: 'FAQ', de: '' } }).success).toBe(false);
    expect(SitePageInput.safeParse({ slug: '../x', title: { en: 'x', de: '' } }).success).toBe(false);
    expect(SitePageInput.safeParse({ slug: 'faq', title: { en: '', de: '' } }).success).toBe(false);
    expect(SitePageInput.safeParse({ slug: 'faq', title: { en: 'a\nb', de: '' } }).success).toBe(false);
  });

  it('find the uploads a text shows', () => {
    const hash = 'b'.repeat(64);
    expect(uploadPathsIn(`![x](/uploads/${hash}.png) ![y](/uploads/${hash}.png) /uploads/${hash}.svg`)).toEqual([`/uploads/${hash}.png`]);
  });
});
