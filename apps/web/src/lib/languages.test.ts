import { describe, expect, it } from 'vitest';
import { fromAcceptLanguage, languageDir, readCookie, resolveLanguage } from './languages';

describe('languages', () => {
  it('reads Accept-Language by weight', () => {
    expect(fromAcceptLanguage('de-DE,de;q=0.9,en;q=0.8')).toBe('de');
    expect(fromAcceptLanguage('fr-CH, fr;q=0.9, en;q=0.8, de;q=0.9')).toBe('de');
    expect(fromAcceptLanguage('en-US;q=0, de;q=0.1')).toBe('de');
    expect(fromAcceptLanguage('fr, *;q=0.5')).toBeNull();
    expect(fromAcceptLanguage('')).toBeNull();
  });

  it('reads cookies', () => {
    expect(readCookie('a=1; osp-lang=de; b=2', 'osp-lang')).toBe('de');
    expect(readCookie('xosp-lang=de', 'osp-lang')).toBeNull();
    expect(readCookie('osp-lang=%E0', 'osp-lang')).toBeNull();
    expect(readCookie(undefined, 'osp-lang')).toBeNull();
  });

  it('resolves cookie, then ?lang=, then Accept-Language, then the page default', () => {
    expect(resolveLanguage({ cookie: 'osp-lang=de', query: 'en', acceptLanguage: 'en' })).toBe('de');
    expect(resolveLanguage({ cookie: 'osp-lang=xx', query: 'de', acceptLanguage: 'en' })).toBe('de');
    expect(resolveLanguage({ query: 'xx', acceptLanguage: 'de-AT', fallback: 'en' })).toBe('de');
    expect(resolveLanguage({ acceptLanguage: 'fr', fallback: 'de' })).toBe('de');
    expect(resolveLanguage({ fallback: 'xx' })).toBe('en');
  });

  it('knows the text direction', () => {
    expect(languageDir('de')).toBe('ltr');
    expect(languageDir('ar-EG')).toBe('rtl');
  });
});
