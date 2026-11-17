import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemePreference = 'system' | 'dark' | 'light';
type Resolved = 'dark' | 'light';

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: Resolved;
  setPreference: (p: ThemePreference) => void;
}

const STORAGE_KEY = 'osp-theme';
const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored(): ThemePreference | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'dark' || v === 'light' || v === 'system' ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): Resolved {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Applies data-theme on <html>. `defaultPreference` comes from the page
 * settings; a visitor's own choice (localStorage) takes precedence.
 */
export function ThemeProvider({ children, defaultPreference = 'system' }: { children: ReactNode; defaultPreference?: ThemePreference }) {
  const [preference, setPref] = useState<ThemePreference>(() => readStored() ?? defaultPreference);
  const [system, setSystem] = useState<Resolved>(systemTheme);

  useEffect(() => {
    if (!readStored()) setPref(defaultPreference);
  }, [defaultPreference]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystem(systemTheme());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: Resolved = preference === 'system' ? system : preference;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const setPreference = useCallback((p: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* storage unavailable */
    }
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
