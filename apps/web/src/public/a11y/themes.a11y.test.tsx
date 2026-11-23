// @vitest-environment jsdom
/**
 * The public pages under every built-in theme (docs/themes.md), light and
 * dark: axe-core finds no WCAG 2.2 A/AA violation with the theme's token
 * stylesheet applied, and the theme passes the contrast checks jsdom cannot
 * run itself (it computes no colours; the shared checker covers every pair
 * the pages draw, see themes.test.ts in packages/shared).
 */
import { BUILTIN_THEMES, checkThemeContrast, themeTokensCss } from '@openstatuspage/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { axeViolations, installBrowserStubs, renderPublic, type Rendered } from './harness';

const AXE_TIMEOUT_MS = 30_000;
const PAGES = ['/', '/services/api', '/history', '/subscribe', '/accessibility'];

let page: Rendered | null = null;

beforeAll(() => installBrowserStubs());
afterEach(() => {
  page?.unmount();
  page = null;
  document.getElementById('osp-theme-test')?.remove();
  for (const link of document.querySelectorAll('link[data-osp-theme]')) link.remove();
});

describe.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))('built-in theme %s', (_id, theme) => {
  it('passes WCAG 2.2 AA contrast in light and dark', () => {
    const checks = checkThemeContrast(theme);
    expect(checks.filter((c) => c.mode === 'light').length).toBeGreaterThan(30);
    expect(checks.filter((c) => !c.pass)).toEqual([]);
  });

  it.each(['light', 'dark'] as const)(
    'public pages have no WCAG A/AA violations (%s)',
    async (mode) => {
      for (const path of PAGES) {
        page = await renderPublic({ path, lang: 'en', theme: mode });
        const style = document.createElement('style');
        style.id = 'osp-theme-test';
        style.textContent = themeTokensCss(theme);
        document.head.appendChild(style);
        expect(document.documentElement.dataset.theme).toBe(mode);
        // Rendered in the browser (no server rendering): the page links the theme stylesheet itself, once.
        expect([...document.querySelectorAll('link[data-osp-theme]')].map((l) => l.getAttribute('href'))).toEqual(['/theme/0123456789abcdef0123.css']);
        expect(await axeViolations(), path).toEqual([]);
        page.unmount();
        page = null;
        style.remove();
        for (const link of document.querySelectorAll('link[data-osp-theme]')) link.remove();
      }
    },
    AXE_TIMEOUT_MS * 2,
  );
});
