/**
 * Contrast of the design tokens in styles.css (WCAG 1.4.3 and 1.4.11) in the
 * light and the dark theme. jsdom cannot compute colors, so the axe-core page
 * tests leave contrast to this test (see docs/accessibility.md).
 */
import { readFileSync } from 'node:fs';
import { contrastRatio, readableOnAll, solidAccent } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import { accentCss, THEME_SURFACES } from './public/utils/accent';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${selector} not found`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!]));
}

const light = block(':root');

it('the server knows the surfaces of both themes (accent color in the page head)', () => {
  expect(THEME_SURFACES.light).toEqual([light.bg, light.surface, light['surface-2']]);
  const dark = block("[data-theme='dark']");
  expect(THEME_SURFACES.dark).toEqual([dark.bg, dark.surface, dark['surface-2']]);
  // The default accent gives the defaults of styles.css.
  expect(accentCss(light.accent)).toContain(`--osp-accent-text:${light['osp-accent-text']}`);
  expect(accentCss(light.accent)).toContain(`html[data-theme='dark']{--osp-accent-text:${dark['osp-accent-text']}}`);
  expect(accentCss('red;}</style>')).toBe('');
});

it("the OS dark preference without data-theme uses the dark theme's tokens", () => {
  expect(block(':root:not([data-theme])')).toEqual(block("[data-theme='dark']"));
});
const themes = { light, dark: { ...light, ...block("[data-theme='dark']") } };

const SURFACES = ['bg', 'surface', 'surface-2'] as const;
const STATUSES = ['operational', 'maintenance', 'degraded', 'partial-outage', 'major-outage'] as const;

describe.each(Object.entries(themes))('%s theme tokens', (_name, t) => {
  it.each(SURFACES)('body and muted text are readable on %s (4.5:1)', (surface) => {
    expect(contrastRatio(t.fg!, t[surface]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.muted!, t[surface]!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SURFACES)('status text colors are readable on %s (4.5:1)', (surface) => {
    for (const s of STATUSES) expect(contrastRatio(t[`status-${s}-text`]!, t[surface]!), s).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SURFACES)('status fills, the no-data outline and field borders stand out on %s (3:1)', (surface) => {
    for (const s of [...STATUSES, 'nodata']) expect(contrastRatio(t[`status-${s}`]!, t[surface]!), s).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(t['border-strong']!, t[surface]!)).toBeGreaterThanOrEqual(3);
  });

  it.each(SURFACES)('accent text is readable and the focus indicator stands out on %s', (surface) => {
    expect(contrastRatio(t['osp-accent-text']!, t[surface]!)).toBeGreaterThanOrEqual(4.5);
  });

  it('the default accent variants match what the page computes at runtime', () => {
    expect(t['osp-accent-text']).toBe(readableOnAll(t.accent!, SURFACES.map((s) => t[s]!)));
    const solid = solidAccent(t.accent!);
    expect(light['osp-accent-solid']).toBe(solid.background);
    expect(light['osp-accent-solid-fg']).toBe(solid.foreground);
    expect(contrastRatio(solid.foreground, solid.background)).toBeGreaterThanOrEqual(4.5);
  });
});
