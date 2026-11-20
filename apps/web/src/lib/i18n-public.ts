/**
 * i18next instances with the namespaces of the public pages only (common,
 * public), one per language. Used by server-side rendering, where every
 * request renders in its own language and the admin and help namespaces would
 * only cost memory. The browser uses the global instance of lib/i18n.ts.
 */
import i18next, { type i18n as I18n } from 'i18next';
import commonDe from '../locales/de/common.json';
import publicDe from '../locales/de/public.json';
import commonEn from '../locales/en/common.json';
import publicEn from '../locales/en/public.json';
import { DEFAULT_LANGUAGE, LANGUAGES, type LanguageCode } from './languages';

const RESOURCES = {
  en: { common: commonEn, public: publicEn },
  de: { common: commonDe, public: publicDe },
};

const instances = new Map<LanguageCode, I18n>();

/** Initialized instance for a language (created once, synchronously). */
export function publicI18n(lng: LanguageCode): I18n {
  let instance = instances.get(lng);
  if (!instance) {
    instance = i18next.createInstance();
    void instance.init({
      lng,
      resources: RESOURCES,
      supportedLngs: LANGUAGES.map((l) => l.code),
      fallbackLng: DEFAULT_LANGUAGE,
      ns: ['common', 'public'],
      defaultNS: 'common',
      interpolation: { escapeValue: false },
      // Resources are bundled: initialize synchronously so the first render is translated.
      initAsync: false,
    });
    instances.set(lng, instance);
  }
  return instance;
}
