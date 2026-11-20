/**
 * Server rendering and hydration. The server renders with fixed inputs (the
 * render time, UTC, the theme from the cookie or the page default); the
 * browser hydrates with the same inputs from the state block and only then
 * switches to the visitor's clock, time zone and stored preferences. Components
 * must not read browser-only state (localStorage, window size, the URL fragment,
 * Date.now()) during the first render; they use these hooks instead.
 */
import type { ThemePreference } from '@openstatuspage/shared';
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

export interface SsrInfo {
  /** Render time on the server (ms since epoch). */
  now: number;
  /** Theme preference the server rendered with. */
  theme: ThemePreference;
  /** Effective public base URL without trailing slash. */
  baseUrl: string;
}

const SsrContext = createContext<SsrInfo | null>(null);

export function SsrProvider({ value, children }: { value: SsrInfo; children: ReactNode }) {
  return <SsrContext.Provider value={value}>{children}</SsrContext.Provider>;
}

/** Inputs of the server render; null in a client-only render (vite dev, management UI). */
export function useSsr(): SsrInfo | null {
  return useContext(SsrContext);
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
