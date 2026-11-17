/**
 * Visitor preferences of the public page: time zone mode (local / UTC) and a
 * shared "now" that ticks every 30 s so relative times stay current.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  durationBetween,
  formatDate,
  formatDateTime,
  formatDuration,
  formatRange,
  formatRelative,
  formatTime,
  type TimeZoneMode,
} from '../utils/time';

const TZ_KEY = 'osp-tz';
const TICK_MS = 30_000;

interface PreferencesValue {
  timeZone: TimeZoneMode;
  setTimeZone: (mode: TimeZoneMode) => void;
  now: number;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

function readTimeZone(): TimeZoneMode {
  try {
    return localStorage.getItem(TZ_KEY) === 'utc' ? 'utc' : 'local';
  } catch {
    return 'local';
  }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [timeZone, setTz] = useState<TimeZoneMode>(readTimeZone);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const setTimeZone = useCallback((mode: TimeZoneMode) => {
    try {
      localStorage.setItem(TZ_KEY, mode);
    } catch {
      /* storage unavailable */
    }
    setTz(mode);
  }, []);

  const value = useMemo(() => ({ timeZone, setTimeZone, now }), [timeZone, setTimeZone, now]);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('usePreferences must be used inside PreferencesProvider');
  return ctx;
}

/** Formatting functions bound to the current language and time zone mode. */
export function useFormat() {
  const { i18n } = useTranslation();
  const { timeZone, now } = usePreferences();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  return useMemo(
    () => ({
      locale,
      timeZone,
      now,
      dateTime: (v: string | Date) => formatDateTime(v, locale, timeZone),
      date: (v: string | Date) => formatDate(v, locale, timeZone),
      time: (v: string | Date) => formatTime(v, locale, timeZone),
      range: (a: string | Date, b: string | Date) => formatRange(a, b, locale, timeZone),
      relative: (v: string | Date) => formatRelative(v, now, locale),
      duration: (ms: number) => formatDuration(ms, locale),
      durationSince: (start: string, end: string | null) => formatDuration(durationBetween(start, end, now), locale),
    }),
    [locale, timeZone, now],
  );
}
