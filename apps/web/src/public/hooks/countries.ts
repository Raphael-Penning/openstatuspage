import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useHydrated } from '../../lib/ssr';

/**
 * Localized country name for an ISO 3166-1 alpha-2 code (falls back to the code).
 * The server render and the hydration render show the code: the names come from
 * ICU, which the server does not load (see `neutral` in utils/time.ts).
 */
export function useCountryName(): (code: string | null) => string | null {
  const { i18n } = useTranslation();
  const hydrated = useHydrated();
  const locale = i18n.resolvedLanguage ?? 'en';
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    if (hydrated) {
      try {
        names = new Intl.DisplayNames([locale], { type: 'region' });
      } catch {
        names = null;
      }
    }
    return (code: string | null) => (code ? (names?.of(code) ?? code) : null);
  }, [locale, hydrated]);
}
