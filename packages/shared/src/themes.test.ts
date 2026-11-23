import { describe, expect, it } from 'vitest';
import { contrastRatio } from './color.js';
import { cssColorToHex, parseCssColor } from './css-color.js';
import { BUILTIN_THEMES, builtinTheme } from './theme-builtins.js';
import {
  checkExtraCss,
  checkThemeContrast,
  isAllowedCssUrl,
  THEME_CSS_MAX_BYTES,
  themeContrastFailures,
  ThemeFile,
  themeModeVariables,
  themeTokensCss,
  type ThemeFile as Theme,
} from './themes.js';

const base = builtinTheme('default')!;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const theme = (patch: Record<string, unknown> = {}) => ({ ...clone(base), id: 'custom', name: 'Custom', ...patch });

describe('theme colours', () => {
  it('parse hex, rgb, hsl and oklch', () => {
    expect(parseCssColor('#fff')).toEqual([255, 255, 255]);
    expect(cssColorToHex('#7C6CF2')).toBe('#7c6cf2');
    expect(cssColorToHex('rgb(124 108 242)')).toBe('#7c6cf2');
    expect(cssColorToHex('rgb(124, 108, 242)')).toBe('#7c6cf2');
    expect(cssColorToHex('rgb(100% 0% 0%)')).toBe('#ff0000');
    expect(cssColorToHex('hsl(0 100% 50%)')).toBe('#ff0000');
    expect(cssColorToHex('hsl(120deg, 100%, 25%)')).toBe('#008000');
    expect(cssColorToHex('oklch(1 0 0)')).toBe('#ffffff');
    expect(cssColorToHex('oklch(0% 0 0)')).toBe('#000000');
    // sRGB red is about oklch(0.628 0.2577 29.23).
    expect(cssColorToHex('oklch(0.628 0.2577 29.23)')).toBe('#ff0000');
  });

  it('reject alpha, names and anything else', () => {
    for (const bad of ['red', '#ffff', '#12345678', 'rgb(1 2 3 / 50%)', 'rgba(1,2,3,0.5)', 'rgb(300 0 0)', 'hsl(0 1 0.5)', 'url(x)', 'var(--x)', 'oklch(2 0 0)', '#fff;}', '']) {
      expect(parseCssColor(bad), bad).toBeNull();
    }
  });
});

describe('theme file schema', () => {
  it('accepts every built-in theme', () => {
    for (const t of BUILTIN_THEMES) expect(ThemeFile.safeParse(t).success, t.id).toBe(true);
    expect(new Set(BUILTIN_THEMES.map((t) => t.id)).size).toBe(BUILTIN_THEMES.length);
  });

  it('accepts a minimal theme in any colour syntax', () => {
    const t = theme({ radius: undefined, density: undefined });
    t.light.accent = 'oklch(0.55 0.2 280)';
    t.dark.text = 'hsl(240 5% 96%)';
    expect(ThemeFile.safeParse(t).success).toBe(true);
  });

  it('rejects unknown keys at every level', () => {
    expect(ThemeFile.safeParse({ ...theme(), extra: 1 }).success).toBe(false);
    const t = theme();
    (t.light as Record<string, unknown>).shadow = '#000000';
    expect(ThemeFile.safeParse(t).success).toBe(false);
    const s = theme();
    (s.dark.status as Record<string, unknown>).unknown = '#000000';
    expect(ThemeFile.safeParse(s).success).toBe(false);
  });

  it('rejects bad ids, versions, colours, radii and font stacks', () => {
    expect(ThemeFile.safeParse(theme({ id: 'Bad Id' })).success).toBe(false);
    expect(ThemeFile.safeParse(theme({ id: '../x' })).success).toBe(false);
    expect(ThemeFile.safeParse(theme({ version: 2 })).success).toBe(false);
    const c = theme();
    c.light.text = 'red;background:url(https://example.com/x)';
    expect(ThemeFile.safeParse(c).success).toBe(false);
    expect(ThemeFile.safeParse(theme({ radius: '3rem' })).success).toBe(false);
    expect(ThemeFile.safeParse(theme({ radius: '1em' })).success).toBe(false);
    expect(ThemeFile.safeParse(theme({ radius: '12px' })).success).toBe(true);
    expect(ThemeFile.safeParse(theme({ fonts: { sans: 'Inter' } })).success).toBe(false);
    expect(ThemeFile.safeParse(theme({ fonts: { sans: "Inter, url(https://example.com/f.woff2), sans-serif" } })).success).toBe(false);
    expect(ThemeFile.safeParse(theme({ fonts: { sans: "Inter;} body{x:y}, sans-serif" } })).success).toBe(false);
    expect(ThemeFile.safeParse(theme({ fonts: { sans: "'IBM Plex Sans', -apple-system, system-ui, sans-serif" } })).success).toBe(true);
    expect(ThemeFile.safeParse(theme({ density: 'huge' })).success).toBe(false);
  });
});

describe('contrast checker', () => {
  it('passes every built-in theme in light and dark', () => {
    for (const t of BUILTIN_THEMES) expect(themeContrastFailures(t), t.id).toEqual([]);
  });

  it('checks text, muted, controls, status fills and status text on every surface', () => {
    const checks = checkThemeContrast(base);
    const light = checks.filter((c) => c.mode === 'light');
    expect(light.filter((c) => c.foreground === 'text').map((c) => c.background)).toEqual(['background', 'surface', 'surfaceAlt']);
    expect(light.find((c) => c.foreground === 'muted')!.required).toBe(4.5);
    expect(light.find((c) => c.foreground === 'status.majorOutage')!.required).toBe(3);
    expect(light.find((c) => c.foreground === 'statusText.majorOutage')!.required).toBe(4.5);
    expect(checks.some((c) => c.mode === 'dark' && c.foreground === 'status.noData')).toBe(true);
  });

  it('reports failures (light grey text, a pale accent, a status fill)', () => {
    const t = theme() as Theme;
    t.light.muted = '#aaaaaa';
    t.dark.status.operational = '#1e3a1e';
    const failures = themeContrastFailures(t);
    expect(failures.some((f) => f.mode === 'light' && f.foreground === 'muted' && f.ratio < 4.5)).toBe(true);
    expect(failures.some((f) => f.mode === 'dark' && f.foreground === 'status.operational')).toBe(true);
    expect(themeContrastFailures(base, '#fefefe').some((f) => f.foreground === 'accent')).toBe(true);
  });

  it('derives readable status text and accent variants', () => {
    const t = theme() as Theme;
    delete t.light.statusText;
    const vars = themeModeVariables(t.light, 'light');
    for (const s of ['operational', 'maintenance', 'degraded', 'partial-outage', 'major-outage']) {
      for (const bg of [t.light.background, t.light.surface, t.light.surfaceAlt]) {
        expect(contrastRatio(vars[`status-${s}-text`]!, bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrastRatio(vars['osp-accent-text']!, t.light.surfaceAlt)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(vars['osp-accent-solid-fg']!, vars['osp-accent-solid']!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('token stylesheet', () => {
  it('reproduces the default tokens of styles.css', () => {
    const css = themeTokensCss(base);
    expect(css).toContain('html:root{');
    expect(css).toContain('--bg:#f7f7f8');
    expect(css).toContain('--osp-accent-text:#695cce');
    expect(css).toContain('--osp-accent-solid:#7061da');
    expect(css).toContain("html[data-theme='dark']{--bg:#161618");
    expect(css).toContain('@media (prefers-color-scheme:dark){html:root:not([data-theme]){--bg:#161618');
    expect(css).toContain('--osp-accent-text:#8f81f4');
    expect(css).toContain('--spacing:0.25rem');
    expect(css).not.toMatch(/[<]/);
  });

  it('applies an accent override in both modes', () => {
    const css = themeTokensCss(base, '#0f766e');
    expect(css.match(/--accent:#0f766e/g)).toHaveLength(3);
  });

  it('is deterministic', () => {
    expect(themeTokensCss(base)).toBe(themeTokensCss(clone(base)));
  });
});

describe('extra CSS filter', () => {
  const hash = 'a'.repeat(64);
  it('accepts ordinary CSS with uploads and relative urls', () => {
    expect(
      checkExtraCss(`
        /* header */
        .osp-group > summary { letter-spacing: .01em; }
        header { background-image: url("/uploads/${hash}.png"); }
        .x { background: url(img/dots.png) repeat; mask: url(#m); }
        @media (min-width: 40rem) { main { padding-inline: 2rem; } }
        .q::before { content: "\\2014"; }
      `),
    ).toEqual([]);
  });

  it.each([
    ['@import url(/uploads/x.css);', 'import'],
    ['@import "https://example.com/x.css";', 'import'],
    ['@IMPORT "x.css";', 'import'],
    ['@\\69mport "x.css";', 'import'],
    ['@im/**/port "x.css";', 'import'],
    ['a{background:url(https://example.com/t.png)}', 'url'],
    ['a{background:url(//example.com/t.png)}', 'url'],
    ["a{background:url('data:image/png;base64,AAAA')}", 'url'],
    ['a{background:\\75rl(https://example.com/t.png)}', 'url'],
    ['a{background:u\\72l(https://example.com/t.png)}', 'url'],
    ['a{background:url( /uploads/../api/x )}', 'url'],
    ['a{background:url(/api/public/settings)}', 'url'],
    ['a{background:url(javascript:alert(1))}', 'javascript'],
    ['a{width:expression(alert(1))}', 'expression'],
    ['a{behavior:url(x.htc)}', 'binding'],
    ['a{-moz-binding:url(x.xml#y)}', 'binding'],
    ['a{background:image-set("https://example.com/a.png" 1x)}', 'image_set'],
    ['a{background:src("x.png")}', 'image_set'],
    ['</style><script>alert(1)</script>', 'html'],
    ['a{content:"\\3c/style>"}', 'html'],
    ['<!-- a{} -->', 'html'],
    ['a{color:red} /* open', 'unterminated_comment'],
    ['a{color:red}\u0000', 'control_character'],
  ])('rejects %s', (css, code) => {
    expect(checkExtraCss(css).map((i) => i.code)).toContain(code);
  });

  it('rejects CSS over the size limit', () => {
    expect(checkExtraCss(`a{}${' '.repeat(THEME_CSS_MAX_BYTES)}`).map((i) => i.code)).toEqual(['too_large']);
  });

  it('only allows same-site url targets', () => {
    expect(isAllowedCssUrl(`/uploads/${hash}.webp`)).toBe(true);
    expect(isAllowedCssUrl('img/a.png')).toBe(true);
    expect(isAllowedCssUrl('#clip')).toBe(true);
    expect(isAllowedCssUrl('./img/a.svg#icon')).toBe(true);
    expect(isAllowedCssUrl('img/..a.png')).toBe(true);
    for (const bad of ['', '/favicon.svg', 'https://example.com/a.png', 'HTTP://x', '//x/y', 'a\\b', 'mailto:x', 'a b', '/uploads//x', '../api/admin/session', 'img/../../subscription', '..', 'a/..', 'img/a.png?x=1', '?x', '.%2e/x']) {
      expect(isAllowedCssUrl(bad), bad).toBe(false);
    }
  });
});
