import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/** Localized country name for an ISO 3166-1 alpha-2 code (falls back to the code). */
export function useCountryName(): (code: string | null) => string | null {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? 'en';
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      names = null;
    }
    return (code: string | null) => (code ? (names?.of(code) ?? code) : null);
  }, [locale]);
}
