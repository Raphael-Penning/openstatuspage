/**
 * The configured accent color as CSS for the page head (entry-server.tsx): the
 * contrast-safe variants PublicLayout computes in the browser, computed on the
 * server for both themes, so pages without JavaScript (and before hydration)
 * show the configured accent. Selectors are one step more specific than the
 * defaults in styles.css, which the page loads after this.
 */
import { readableOnAll, solidAccent } from './color';

/** --bg, --surface and --surface-2 of both themes (tokens.test.ts checks them against styles.css). */
export const THEME_SURFACES = {
  light: ['#f7f7f8', '#ffffff', '#f1f1f3'],
  dark: ['#161618', '#1e1e21', '#26262a'],
} as const;

export function accentCss(accent: string | null | undefined): string {
  if (!accent || !/^#[0-9a-fA-F]{6}$/.test(accent)) return '';
  const solid = solidAccent(accent);
  const light = readableOnAll(accent, THEME_SURFACES.light);
  const dark = readableOnAll(accent, THEME_SURFACES.dark);
  return (
    `html:root{--accent:${accent};--osp-accent-text:${light};--osp-accent-solid:${solid.background};--osp-accent-solid-fg:${solid.foreground}}` +
    `html[data-theme='dark']{--osp-accent-text:${dark}}` +
    `@media (prefers-color-scheme:dark){html:root:not([data-theme]){--osp-accent-text:${dark}}}`
  );
}
