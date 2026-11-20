/**
 * Server rendering and hydration. The server renders with fixed inputs (the
 * render time, UTC, the theme from the cookie or the page default); the
 * browser hydrates with the same inputs from the state block and only then
 * switches to the visitor's clock, time zone and stored preferences. Components
 * must not read browser-only state (localStorage, window size, the URL fragment,
 * Date.now()) during the first render; they use these hooks instead.
 */
import { analyticsOptedOut, type SsrFormState, type ThemePreference } from '@openstatuspage/shared';
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation } from 'react-router';

export interface SsrInfo {
  /** Render time on the server (ms since epoch). */
  now: number;
  /** Theme preference the server rendered with. */
  theme: ThemePreference;
  /** Effective public base URL without trailing slash. */
  baseUrl: string;
  /** The page answers a form submission (values and errors the server checked). */
  form?: SsrFormState;
  /** The visitor turned analytics off (cookie osp-analytics=off). */
  analyticsOff?: boolean;
}

const SsrContext = createContext<SsrInfo | null>(null);

export function SsrProvider({ value, children }: { value: SsrInfo; children: ReactNode }) {
  return <SsrContext.Provider value={value}>{children}</SsrContext.Provider>;
}

/** Inputs of the server render; null in a client-only render (vite dev, management UI). */
export function useSsr(): SsrInfo | null {
  return useContext(SsrContext);
}

/**
 * The form state the server rendered this page with (a form that was sent
 * without JavaScript and came back with errors). Only for the page the browser
 * loaded: after navigating away and back the form starts empty again.
 */
export function useServerForm(): SsrFormState | null {
  const ssr = useSsr();
  const { key } = useLocation();
  return ssr?.form && key === 'default' ? ssr.form : null;
}

/**
 * Whether the visitor turned analytics off: as the server rendered the page,
 * or from the cookie in a client-only render.
 */
export function useAnalyticsOff(): boolean {
  const ssr = useSsr();
  if (ssr) return ssr.analyticsOff === true;
  return typeof document !== 'undefined' && analyticsOptedOut(document.cookie);
}

const subscribe = () => () => {};

/**
 * False on the server and during hydration, true afterwards and in client-only
 * renders. Gate browser-only output with it to avoid hydration mismatches.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
