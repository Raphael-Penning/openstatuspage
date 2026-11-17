/**
 * i18next setup. Namespaces:
 *   common  shared vocabulary (statuses, impacts, buttons, dates)
 *   public  public status page
 *   admin   management UI
 * Add a language by adding src/locales/<lng>/*.json and listing it in LANGUAGES.
 */
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import adminDe from '../locales/de/admin.json';
import commonDe from '../locales/de/common.json';
import publicDe from '../locales/de/public.json';
import adminEn from '../locales/en/admin.json';
import commonEn from '../locales/en/common.json';
import publicEn from '../locales/en/public.json';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
] as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: commonEn, public: publicEn, admin: adminEn },
      de: { common: commonDe, public: publicDe, admin: adminDe },
    },
    supportedLngs: LANGUAGES.map((l) => l.code),
    fallbackLng: 'en',
    ns: ['common', 'public', 'admin'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'osp-lang',
      caches: ['localStorage'],
    },
  });

export default i18n;
