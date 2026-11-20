/**
 * Visitor preferences of the public page: time zone mode (local / UTC) and a
 * shared "now" that ticks every 30 s so relative times stay current.
 *
 * Server rendering is deterministic: the server renders in UTC against its
 * render time, and hydration repeats exactly that (lib/ssr.tsx). The visitor's
 * time zone and clock apply right after hydration.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useHydrated, useSsr } from '../../lib/ssr';
import {
  durationBetween,
  formatDate,
  formatDateTime,
  formatDuration,
  formatRange,
  formatRelative,
  formatMonth,
  formatTime,
  formatUtcDay,
  neutral,
  type TimeZoneMode,
} from '../utils/time';
import { formatPercent, formatPercentNeutral } from '../utils/uptime';

const TZ_KEY = 'osp-tz';
const TICK_MS = 30_000;

interface PreferencesValue {
  timeZone: TimeZoneMode;
  setTimeZone: (mode: TimeZoneMode) => void;
  now: number;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

function readTimeZone(): TimeZoneMode {
  if (typeof window === 'undefined') return 'utc';
  try {
    return localStorage.getItem(TZ_KEY) === 'utc' ? 'utc' : 'local';
  } catch {
    return 'local';
  }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const ssr = useSsr();
  const hydrated = useHydrated();
  const [storedTimeZone, setTz] = useState<TimeZoneMode>(readTimeZone);
  const [now, setNow] = useState(() => ssr?.now ?? Date.now());
  const timeZone: TimeZoneMode = hydrated ? storedTimeZone : 'utc';

  useEffect(() => {
    setNow(Date.now());
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

export interface Format {
  locale: string;
  timeZone: TimeZoneMode;
  now: number;
  dateTime: (v: string | Date) => string;
  date: (v: string | Date) => string;
  time: (v: string | Date) => string;
  range: (a: string | Date, b: string | Date) => string;
  /** "2 hours ago"; the absolute time until hydration. */
  relative: (v: string | Date) => string;
  duration: (ms: number) => string;
  durationSince: (start: string, end: string | null) => string;
  /** Day of a UTC uptime bucket ("YYYY-MM-DD"). */
  utcDay: (day: string) => string;
  /** Month of a "YYYY-MM" key. */
  month: (month: string) => string;
  /** Percentage (0–100), at most two fraction digits. */
  percent: (value: number) => string;
}

/**
 * Formatting functions bound to the current language and time zone mode. On the
 * server and during hydration they are language neutral and ICU-free (UTC, ISO
 * dates, see `neutral` in utils/time.ts), afterwards localized with Intl.
 */
export function useFormat(): Format {
  const { i18n } = useTranslation();
  const { timeZone, now } = usePreferences();
  const hydrated = useHydrated();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  return useMemo(
    (): Format =>
      hydrated
        ? {
            locale,
            timeZone,
            now,
            dateTime: (v) => formatDateTime(v, locale, timeZone),
            date: (v) => formatDate(v, locale, timeZone),
            time: (v) => formatTime(v, locale, timeZone),
            range: (a, b) => formatRange(a, b, locale, timeZone),
            relative: (v) => formatRelative(v, now, locale),
            duration: (ms) => formatDuration(ms, locale),
            durationSince: (start, end) => formatDuration(durationBetween(start, end, now), locale),
            utcDay: (day) => formatUtcDay(day, locale),
            month: (month) => formatMonth(month, locale),
            percent: (value) => formatPercent(value, locale),
          }
        : {
            locale,
            timeZone: 'utc',
            now,
            dateTime: neutral.dateTime,
            date: neutral.date,
            time: neutral.time,
            range: neutral.range,
            relative: neutral.dateTime,
            duration: neutral.duration,
            durationSince: (start, end) => neutral.duration(durationBetween(start, end, now)),
            utcDay: (day) => day,
            month: (month) => month,
            percent: (value) => formatPercentNeutral(value, locale),
          },
    [hydrated, locale, timeZone, now],
  );
}
