/**
 * i18next setup. Namespaces:
 *   common  shared vocabulary (statuses, impacts, buttons, dates)
 *   public  public status page
 *   admin   management UI
 *   help    help area of the management UI (the guide itself is markdown in docs/guide)
 * Add a language by adding src/locales/<lng>/*.json and listing it in LANGUAGES.
 */
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import adminDe from '../locales/de/admin.json';
import commonDe from '../locales/de/common.json';
import helpDe from '../locales/de/help.json';
import publicDe from '../locales/de/public.json';
import adminEn from '../locales/en/admin.json';
import commonEn from '../locales/en/common.json';
import helpEn from '../locales/en/help.json';
import publicEn from '../locales/en/public.json';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
] as const;

/**
 * <html lang> and dir follow the UI language, so screen readers pronounce the
 * page correctly and hyphenation works (WCAG 3.1.1).
 */
export function applyDocumentLanguage(lng: string | undefined): void {
  if (typeof document === 'undefined') return;
  const code = lng && LANGUAGES.some((l) => l.code === lng) ? lng : 'en';
  document.documentElement.lang = code;
  document.documentElement.dir = i18n.dir(code);
}

i18n.on('languageChanged', () => applyDocumentLanguage(i18n.resolvedLanguage));

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: commonEn, public: publicEn, admin: adminEn, help: helpEn },
      de: { common: commonDe, public: publicDe, admin: adminDe, help: helpDe },
    },
    supportedLngs: LANGUAGES.map((l) => l.code),
    fallbackLng: 'en',
    ns: ['common', 'public', 'admin', 'help'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'osp-lang',
      caches: ['localStorage'],
    },
  });
applyDocumentLanguage(i18n.resolvedLanguage);

export default i18n;
