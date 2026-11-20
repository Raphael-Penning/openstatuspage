/**
 * Content only for browsers without JavaScript, e.g. the submit button of a
 * filter form that applies every change by itself with JavaScript. The server
 * renders it; a browser with JavaScript never shows it, so hydration moves
 * nothing.
 */
import type { ReactNode } from 'react';

export function NoScript({ children }: { children: ReactNode }) {
  return <noscript>{children}</noscript>;
}
