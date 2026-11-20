/**
 * UI languages and how a request picks one. No i18next and no translations
 * here: the server-side rendering bundle and the public entry import this
 * without the admin and help namespaces.
 *
 * Order (server render and hydration alike): the `osp-lang` cookie (an explicit
 * choice in the language switcher), then `?lang=`, then Accept-Language, then
 * the page default language from the settings.
 */
import { LANG_COOKIE } from '@openstatuspage/shared';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

export const DEFAULT_LANGUAGE: LanguageCode = 'en';

export function isLanguage(value: unknown): value is LanguageCode {
  return typeof value === 'string' && LANGUAGES.some((l) => l.code === value);
}

/** Primary subtag of a language tag, lower case ("de-AT" → "de"). */
const primary = (tag: string) => tag.trim().split(/[-_]/)[0]!.toLowerCase();

/** Supported language of an Accept-Language header with the highest weight (null: none). */
export function fromAcceptLanguage(header: string | null | undefined): LanguageCode | null {
  if (!header) return null;
  const ranked = header
    .split(',')
    .slice(0, 20)
    .map((part, index) => {
      const [tag = '', ...params] = part.split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number.parseFloat(q.slice(2)) : 1;
      return { code: primary(tag), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((e) => e.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  return ranked.map((e) => e.code).find(isLanguage) ?? null;
}

/** Value of one cookie of a Cookie header (null: not set). */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export interface LanguageInputs {
  cookie?: string | null;
  query?: string | null;
  acceptLanguage?: string | null;
  /** Page default language (settings). */
  fallback?: string | null;
}

export function resolveLanguage({ cookie, query, acceptLanguage, fallback }: LanguageInputs): LanguageCode {
  const fromCookie = readCookie(cookie, LANG_COOKIE);
  if (isLanguage(fromCookie)) return fromCookie;
  if (isLanguage(query)) return query;
  return fromAcceptLanguage(acceptLanguage) ?? (isLanguage(fallback) ? fallback : DEFAULT_LANGUAGE);
}

const RTL = new Set(['ar', 'fa', 'he', 'ps', 'ur', 'yi']);

/** Text direction of a language (`<html dir>`). */
export function languageDir(code: string): 'ltr' | 'rtl' {
  return RTL.has(primary(code)) ? 'rtl' : 'ltr';
}

const YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Sets a preference cookie for the whole site (read by the server-side rendering). */
export function writePreferenceCookie(name: string, value: string): void {
  if (typeof document === 'undefined') return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${YEAR_SECONDS}; SameSite=Lax${secure}`;
}
