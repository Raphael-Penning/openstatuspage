/**
 * i18next setup of the browser. Namespaces:
 *   common  shared vocabulary (statuses, impacts, buttons, dates)
 *   public  public status page
 *   admin   management UI           } added by lib/i18n-admin.ts when the management
 *   help    help of the management UI } UI loads (not part of the public pages' bundle)
 * Add a language by adding src/locales/<lng>/*.json and listing it in lib/languages.ts.
 *
 * The language is detected like on the server (lib/languages.ts): the `osp-lang`
 * cookie, `?lang=`, then the stored and the browser language. A server-rendered
 * page switches to the language it was rendered in before hydrating (main-public.tsx).
 */
import { LANG_COOKIE, LANG_QUERY } from '@openstatuspage/shared';
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import commonDe from '../locales/de/common.json';
import publicDe from '../locales/de/public.json';
import commonEn from '../locales/en/common.json';
import publicEn from '../locales/en/public.json';
import { isLanguage, languageDir, LANGUAGES } from './languages';

export { LANGUAGES } from './languages';

/**
 * <html lang> and dir follow the UI language, so screen readers pronounce the
 * page correctly and hyphenation works (WCAG 3.1.1).
 */
export function applyDocumentLanguage(lng: string | undefined): void {
  if (typeof document === 'undefined') return;
  const code = isLanguage(lng) ? lng : 'en';
  document.documentElement.lang = code;
  document.documentElement.dir = languageDir(code);
}

i18n.on('languageChanged', () => applyDocumentLanguage(i18n.resolvedLanguage));

/** Resolves once the instance is initialized. */
export const i18nReady = i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: commonEn, public: publicEn },
      de: { common: commonDe, public: publicDe },
    },
    supportedLngs: LANGUAGES.map((l) => l.code),
    fallbackLng: 'en',
    ns: ['common', 'public'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    detection: {
      order: ['cookie', 'querystring', 'localStorage', 'navigator'],
      lookupCookie: LANG_COOKIE,
      lookupQuerystring: LANG_QUERY,
      lookupLocalStorage: 'osp-lang',
      caches: ['localStorage'],
    },
  })
  .then(() => undefined);
applyDocumentLanguage(i18n.resolvedLanguage);

export default i18n;
