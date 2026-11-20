import { THEME_COOKIE, type ThemePreference } from '@openstatuspage/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { readCookie, writePreferenceCookie } from './languages';
import { useSsr } from './ssr';

export type { ThemePreference } from '@openstatuspage/shared';
type Resolved = 'dark' | 'light';

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: Resolved;
  setPreference: (p: ThemePreference) => void;
}

const STORAGE_KEY = 'osp-theme';
const ThemeContext = createContext<ThemeContextValue | null>(null);

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'dark' || v === 'light' || v === 'system';
}

/**
 * The visitor's choice: the cookie first (also set by the theme form without
 * JavaScript, and what the server rendered with), then the stored one.
 */
function readStored(): ThemePreference | null {
  if (typeof document === 'undefined') return null;
  const cookie = readCookie(document.cookie, THEME_COOKIE);
  if (isThemePreference(cookie)) return cookie;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isThemePreference(v) ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): Resolved {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Applies data-theme on <html>. `defaultPreference` comes from the page
 * settings; a visitor's own choice (localStorage, mirrored in the `osp-theme`
 * cookie for server rendering) takes precedence. A server-rendered page starts
 * with the theme the server used and reads the stored choice after hydration.
 */
export function ThemeProvider({ children, defaultPreference = 'system' }: { children: ReactNode; defaultPreference?: ThemePreference }) {
  const ssr = useSsr();
  const [preference, setPref] = useState<ThemePreference>(() => (ssr ? ssr.theme : (readStored() ?? defaultPreference)));
  const [system, setSystem] = useState<Resolved>(() => (ssr ? 'light' : systemTheme()));

  useEffect(() => {
    const stored = readStored();
    // A choice made before the cookie existed lives in localStorage only: mirror
    // it, so the server renders it from the next page load on (no flash).
    if (stored && !isThemePreference(readCookie(document.cookie, THEME_COOKIE))) writePreferenceCookie(THEME_COOKIE, stored);
    setPref(stored ?? defaultPreference);
  }, [defaultPreference]);

  useEffect(() => {
    setSystem(systemTheme());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystem(systemTheme());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: Resolved = preference === 'system' ? system : preference;

  useEffect(() => {
    // Read the OS preference here rather than `system`: right after hydration it
    // still holds the server's guess, and writing that would flash the wrong theme
    // over what the stylesheet already shows (prefers-color-scheme).
    document.documentElement.dataset.theme = preference === 'system' ? systemTheme() : preference;
  }, [preference, system]);

  const setPreference = useCallback((p: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* storage unavailable */
    }
    writePreferenceCookie(THEME_COOKIE, p);
    setPref(p);
  }, []);

  const value = useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}

/** Applies the configurable accent color from page settings. */
export function useAccentColor(color: string | undefined): void {
  useEffect(() => {
    if (color) document.documentElement.style.setProperty('--accent', color);
  }, [color]);
}
