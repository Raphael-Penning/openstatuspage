/**
 * Themes of the public pages (docs/themes.md): a JSON token file, validated
 * here, plus optional extra CSS. Themes come from three places: the built-in
 * ones (theme-builtins.ts), a themes folder on the server (THEMES_DIR) and
 * uploads in the management UI (stored in the database).
 *
 * The tokens become CSS custom properties (themeTokensCss) that the server
 * serves as a separate, content-hashed stylesheet, never inline. Every colour
 * pair the pages draw is checked against WCAG 2.2 AA (checkThemeContrast); a
 * theme that fails is only activated when an admin explicitly confirms it.
 * Extra CSS is written by admins, but still filtered (checkExtraCss): no
 * @import, no url() to anything but /uploads/ or a relative path, no
 * expression(), javascript: or anything that looks like HTML.
 */
import { z } from 'zod';
import { contrastRatio, readableOnAll, solidAccent } from './color.js';
import { cssColorToHex } from './css-color.js';

/** Version of the theme file format (the `version` key). */
export const THEME_SCHEMA_VERSION = 1;
/** Largest extra CSS of a theme, in bytes (UTF-8). */
export const THEME_CSS_MAX_BYTES = 64 * 1024;
/** Largest theme JSON file, in bytes. */
export const THEME_JSON_MAX_BYTES = 64 * 1024;
/** Id of the built-in theme that is active until another one is chosen. */
export const DEFAULT_THEME_ID = 'default';

export const zThemeId = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lower-case letters, digits and hyphens');

export const zThemeColor = z
  .string()
  .max(64)
  .refine((v) => cssColorToHex(v) !== null, 'must be an opaque colour: #rgb, #rrggbb, rgb(), hsl() or oklch()');

const GENERIC_FAMILIES = [
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
];
const FAMILY = String.raw`(?:'[A-Za-z0-9 .\-]{1,60}'|"[A-Za-z0-9 .\-]{1,60}"|-?[A-Za-z][A-Za-z0-9\-]*(?: [A-Za-z0-9\-]+)*)`;
const FONT_STACK = new RegExp(`^${FAMILY}(?:\\s*,\\s*${FAMILY})*$`);

/**
 * A font stack of locally installed fonts: family names, comma separated,
 * ending with a generic family. Nothing is downloaded (no web fonts).
 */
export const zFontStack = z
  .string()
  .max(300)
  .transform((v) => v.trim())
  .refine((v) => FONT_STACK.test(v), 'font family names separated by commas')
  .refine((v) => GENERIC_FAMILIES.includes(v.split(',').at(-1)!.trim().toLowerCase()), 'must end with a generic family such as sans-serif');

/** A length for the corner radius: 0, or rem/px up to 2rem / 32px. */
export const zRadius = z
  .string()
  .regex(/^(?:0|(?:\d(?:\.\d{1,3})?|1\d(?:\.\d{1,3})?)rem|\d{1,2}px)$/, 'a length such as 0.5rem or 8px')
  .refine((v) => (v.endsWith('px') ? Number.parseFloat(v) <= 32 : v === '0' || Number.parseFloat(v) <= 2), 'at most 2rem or 32px');

export const THEME_STATUSES = ['operational', 'maintenance', 'degraded', 'partialOutage', 'majorOutage'] as const;
export type ThemeStatus = (typeof THEME_STATUSES)[number];

const statusShape = Object.fromEntries(THEME_STATUSES.map((s) => [s, zThemeColor])) as Record<ThemeStatus, typeof zThemeColor>;

/** Colours of one colour scheme (light or dark). */
export const ThemeModeTokens = z.strictObject({
  /** Page background (--bg). */
  background: zThemeColor,
  /** Cards and panels (--surface). */
  surface: zThemeColor,
  /** Insets, table heads, hover backgrounds (--surface-2). */
  surfaceAlt: zThemeColor,
  /** Hairlines between items (--border; decorative, not contrast checked). */
  border: zThemeColor,
  /** Boundaries of form fields and controls (--border-strong; 3:1). */
  borderStrong: zThemeColor,
  /** Body text (--fg; 4.5:1). */
  text: zThemeColor,
  /** Secondary text (--muted; 4.5:1). */
  muted: zThemeColor,
  /** Brand / accent colour (--accent; 3:1 as a UI colour). Text and buttons use contrast-safe variants derived from it. */
  accent: zThemeColor,
  /** Focus indicator (--focus; 3:1). Default: the readable accent. */
  focus: zThemeColor.optional(),
  /** Fills of the status bars, dots and markers (3:1). */
  status: z.strictObject({ ...statusShape, noData: zThemeColor }),
  /** Status colours for text and icons (4.5:1). Default: derived from the fills. */
  statusText: z.strictObject(statusShape).optional(),
});
export type ThemeModeTokens = z.infer<typeof ThemeModeTokens>;

export const THEME_DENSITIES = ['compact', 'comfortable', 'spacious'] as const;
export type ThemeDensity = (typeof THEME_DENSITIES)[number];

/** A theme file (`<id>.json`). Unknown keys are rejected. */
export const ThemeFile = z.strictObject({
  /** Optional JSON Schema reference for editors; ignored. */
  $schema: z.string().max(300).optional(),
  id: zThemeId,
  name: z.string().trim().min(1).max(80),
  version: z.literal(THEME_SCHEMA_VERSION),
  author: z.string().trim().max(120).optional(),
  description: z.string().trim().max(500).optional(),
  light: ThemeModeTokens,
  dark: ThemeModeTokens,
  /** Base corner radius (Tailwind's rounded-lg; the other sizes scale with it). */
  radius: zRadius.optional(),
  fonts: z
    .strictObject({
      sans: zFontStack.optional(),
      mono: zFontStack.optional(),
    })
    .optional(),
  /** Spacing scale: compact (90 %), comfortable (default), spacious (110 %). */
  density: z.enum(THEME_DENSITIES).optional(),
});
export type ThemeFile = z.infer<typeof ThemeFile>;

export const THEME_SOURCES = ['builtin', 'folder', 'database'] as const;
export type ThemeSource = (typeof THEME_SOURCES)[number];

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

export type ThemeMode = 'light' | 'dark';

export interface ContrastCheck {
  mode: ThemeMode;
  /** Token of the foreground (`text`, `status.operational`, `statusText.degraded`, …). */
  foreground: string;
  /** Token of the background (`background`, `surface`, `surfaceAlt`). */
  background: string;
  /** Contrast ratio, rounded to two decimals. */
  ratio: number;
  /** Required ratio: 4.5 for text, 3 for UI components and graphics (WCAG 1.4.3, 1.4.11). */
  required: number;
  pass: boolean;
}

const SURFACES = ['background', 'surface', 'surfaceAlt'] as const;

const hex = (color: string) => cssColorToHex(color) ?? '#000000';

/** The surfaces of a mode (#rrggbb): page, cards, insets. */
export function themeSurfaces(tokens: ThemeModeTokens): string[] {
  return SURFACES.map((s) => hex(tokens[s]));
}

/** The text colour of a status: the explicit one, or the fill made readable on every surface. */
export function statusTextColor(tokens: ThemeModeTokens, status: ThemeStatus): string {
  return tokens.statusText?.[status] ?? readableOnAll(hex(tokens.status[status]), themeSurfaces(tokens));
}

/**
 * Every colour pair the public pages draw, checked against WCAG 2.2 AA, for
 * both modes. `accentOverride` is the accent of the page settings (it replaces
 * the theme's accent in both modes).
 */
export function checkThemeContrast(theme: ThemeFile, accentOverride?: string | null): ContrastCheck[] {
  const out: ContrastCheck[] = [];
  for (const mode of ['light', 'dark'] as const) {
    const t = theme[mode];
    const pairs: [string, string, number][] = [
      ['text', t.text, 4.5],
      ['muted', t.muted, 4.5],
      ['borderStrong', t.borderStrong, 3],
      ['accent', accentOverride ?? t.accent, 3],
      ...(t.focus ? [['focus', t.focus, 3] as [string, string, number]] : []),
      ...THEME_STATUSES.map((s) => [`status.${s}`, t.status[s], 3] as [string, string, number]),
      ['status.noData', t.status.noData, 3],
      ...(t.statusText ? THEME_STATUSES.map((s) => [`statusText.${s}`, t.statusText![s], 4.5] as [string, string, number]) : []),
    ];
    for (const [foreground, color, required] of pairs) {
      for (const background of SURFACES) {
        const ratio = Math.floor(contrastRatio(hex(color), hex(t[background])) * 100) / 100;
        out.push({ mode, foreground, background, ratio, required, pass: ratio >= required });
      }
    }
    // Solid accent buttons: their text on the (derived) button colour.
    const solid = solidAccent(hex(accentOverride ?? t.accent));
    const ratio = Math.floor(contrastRatio(solid.foreground, solid.background) * 100) / 100;
    out.push({ mode, foreground: 'accentButtonText', background: 'accentButton', ratio, required: 4.5, pass: ratio >= 4.5 });
  }
  return out;
}

/** Only the failed checks of {@link checkThemeContrast}. */
export function themeContrastFailures(theme: ThemeFile, accentOverride?: string | null): ContrastCheck[] {
  return checkThemeContrast(theme, accentOverride).filter((c) => !c.pass);
}

// ---------------------------------------------------------------------------
// Tokens as CSS
// ---------------------------------------------------------------------------

export const DEFAULT_FONT_SANS = "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
export const DEFAULT_FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
export const DEFAULT_RADIUS = '0.5rem';
const SPACING: Record<ThemeDensity, string> = { compact: '0.225rem', comfortable: '0.25rem', spacious: '0.275rem' };

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The custom properties of one mode (name without `--` → value). */
export function themeModeVariables(tokens: ThemeModeTokens, mode: ThemeMode, accentOverride?: string | null): Record<string, string> {
  const accent = accentOverride ?? tokens.accent;
  const surfaces = themeSurfaces(tokens);
  const solid = solidAccent(hex(accent));
  const accentText = readableOnAll(hex(accent), surfaces);
  const vars: Record<string, string> = {
    bg: tokens.background,
    surface: tokens.surface,
    'surface-2': tokens.surfaceAlt,
    border: tokens.border,
    'border-strong': tokens.borderStrong,
    fg: tokens.text,
    muted: tokens.muted,
    accent,
    'accent-fg': solid.foreground,
    'osp-accent-text': accentText,
    'osp-accent-solid': solid.background,
    'osp-accent-solid-fg': solid.foreground,
    focus: tokens.focus ?? accentText,
  };
  for (const s of THEME_STATUSES) vars[`status-${kebab(s)}`] = tokens.status[s];
  vars['status-nodata'] = tokens.status.noData;
  for (const s of THEME_STATUSES) vars[`status-${kebab(s)}-text`] = statusTextColor(tokens, s);
  vars['color-scheme'] = mode;
  return vars;
}

const declarations = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([name, value]) => (name === 'color-scheme' ? `color-scheme:${value}` : `--${name}:${value}`))
    .join(';');

/**
 * The stylesheet of a theme's tokens. Its selectors are one step more specific
 * than the defaults in styles.css (html:root over :root), so the order of the
 * stylesheets does not matter. Light by default; dark for `data-theme="dark"`
 * and, without a data-theme (no JavaScript, "system"), for an OS that prefers
 * dark. Every value has been validated by {@link ThemeFile}.
 */
export function themeTokensCss(theme: ThemeFile, accentOverride?: string | null): string {
  const global = {
    'osp-radius': theme.radius ?? DEFAULT_RADIUS,
    'osp-font-sans': theme.fonts?.sans ?? DEFAULT_FONT_SANS,
    'osp-font-mono': theme.fonts?.mono ?? DEFAULT_FONT_MONO,
    spacing: SPACING[theme.density ?? 'comfortable'],
  };
  const light = declarations({ ...global, ...themeModeVariables(theme.light, 'light', accentOverride) });
  const dark = declarations(themeModeVariables(theme.dark, 'dark', accentOverride));
  return (
    `/* Theme ${theme.id} */\n` +
    `html:root{${light}}\n` +
    `html[data-theme='dark']{${dark}}\n` +
    `@media (prefers-color-scheme:dark){html:root:not([data-theme]){${dark}}}\n`
  );
}

// ---------------------------------------------------------------------------
// Extra CSS filter
// ---------------------------------------------------------------------------

export type ExtraCssIssueCode =
  | 'too_large'
  | 'control_character'
  | 'html'
  | 'unterminated_comment'
  | 'import'
  | 'url'
  | 'expression'
  | 'javascript'
  | 'binding'
  | 'image_set';

export interface ExtraCssIssue {
  code: ExtraCssIssueCode;
  message: string;
  /** The offending text (shortened). */
  excerpt?: string;
}

const MESSAGES: Record<ExtraCssIssueCode, string> = {
  too_large: `Extra CSS may be at most ${THEME_CSS_MAX_BYTES / 1024} KB`,
  control_character: 'Control characters are not allowed',
  html: 'The character < and the sequence --> are not allowed, also in comments (nothing that looks like HTML)',
  unterminated_comment: 'A comment is not closed',
  import: '@import is not allowed',
  url: 'url() may only point to /uploads/ or a relative path on this site',
  expression: 'expression() is not allowed',
  javascript: 'javascript: and vbscript: URLs are not allowed',
  binding: 'behavior and -moz-binding are not allowed',
  image_set: 'image-set() and src() are not allowed (use url() with an upload)',
};

/** Length of a string in UTF-8 bytes. */
export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return n;
}

const excerpt = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);

/** CSS escapes (`\75 rl(`, `\@import`) decoded, so they cannot hide a forbidden word. */
function decodeEscapes(css: string): string {
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|([^\n0-9a-fA-F]))/g, (_m, hexDigits: string | undefined, ch: string | undefined) => {
    if (hexDigits) {
      const code = Number.parseInt(hexDigits, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
    }
    return ch ?? '';
  });
}

/** Whether a url() target stays on this site: /uploads/…, a relative path or a fragment. */
export function isAllowedCssUrl(target: string): boolean {
  const t = target.trim();
  if (t === '' || t.length > 512) return false;
  if (/[\s\\"'()<>]/.test(t)) return false;
  if (t.startsWith('#')) return /^#[A-Za-z][\w-]*$/.test(t);
  if (t.includes('//')) return false;
  if (t.startsWith('/')) return /^\/uploads\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(t);
  // Relative: no scheme (a colon before the first slash would be one).
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(t) && !t.includes(':') && /^[A-Za-z0-9._~\-/]+(?:[?#][A-Za-z0-9._~\-=&]*)?$/.test(t);
}

/** The targets of every url() in decoded, comment-free CSS. */
function urlTargets(css: string): string[] {
  const out: string[] = [];
  const re = /url\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let i = m.index + m[0].length;
    while (i < css.length && /\s/.test(css[i]!)) i++;
    const quote = css[i] === '"' || css[i] === "'" ? css[i] : null;
    let target = '';
    if (quote) {
      const end = css.indexOf(quote, i + 1);
      target = end === -1 ? css.slice(i + 1) : css.slice(i + 1, end);
    } else {
      const end = css.indexOf(')', i);
      target = end === -1 ? css.slice(i) : css.slice(i, end);
    }
    out.push(target.trim());
  }
  return out;
}

/**
 * Checks the extra CSS of a theme. It is written by admins (trusted), but it
 * is still filtered: it must not load anything from elsewhere, run anything or
 * be able to end a style element. Returns the problems; empty when it is fine.
 * The CSS is rejected as a whole, never rewritten.
 */
export function checkExtraCss(css: string): ExtraCssIssue[] {
  const issues: ExtraCssIssue[] = [];
  const add = (code: ExtraCssIssueCode, text?: string) => {
    if (!issues.some((i) => i.code === code)) issues.push({ code, message: MESSAGES[code], ...(text ? { excerpt: excerpt(text) } : {}) });
  };
  if (utf8Length(css) > THEME_CSS_MAX_BYTES) {
    add('too_large');
    return issues;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(css)) add('control_character');
  // `<` never appears in CSS outside of strings; `>` only as the child combinator.
  if (/<|-->/.test(css)) add('html', /<[^\n]{0,40}|-->/.exec(css)?.[0]);

  // Comments removed first: /* */ between letters must not hide a word (ur/**/l, @im/**/port).
  if (/\/\*(?![\s\S]*?\*\/)/.test(css)) add('unterminated_comment');
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const decoded = decodeEscapes(withoutComments);
  const lower = decoded.toLowerCase();
  if (decoded !== withoutComments && /[<]/.test(decoded)) add('html');

  if (/@import\b/.test(lower)) add('import', /@import[^;\n]{0,40}/.exec(lower)?.[0]);
  if (/expression\s*\(/.test(lower)) add('expression');
  if (/(?:java|vb)script\s*:/.test(lower)) add('javascript');
  if (/-moz-binding|\bbehavior\s*:/.test(lower)) add('binding');
  if (/(?:^|[^\w-])(?:-webkit-)?image-set\s*\(|(?:^|[^\w-])src\s*\(/.test(lower)) add('image_set');
  for (const target of urlTargets(decoded)) {
    if (!isAllowedCssUrl(target)) add('url', `url(${target})`);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Management API shapes
// ---------------------------------------------------------------------------

/** A theme as the management API lists it (`themes`). */
export interface AdminTheme {
  id: string;
  name: string;
  author: string | null;
  description: string | null;
  source: ThemeSource;
  /** Built-in and folder themes cannot be changed or deleted here. */
  readOnly: boolean;
  active: boolean;
  /** The theme file (normalized). */
  definition: ThemeFile;
  /** Extra CSS (null: none). Only in the answer for one theme. */
  css?: string | null;
  cssBytes: number;
  /** Failed WCAG 2.2 AA checks with the current accent setting; empty: the theme passes. */
  contrastFailures: ContrastCheck[];
  updatedAt: string | null;
}

/** POST /api/admin/themes: import a theme file (and its extra CSS). */
export const ThemeImportInput = z.strictObject({
  definition: z.unknown(),
  css: z.string().max(THEME_CSS_MAX_BYTES * 2).nullish(),
});

/** PATCH /api/admin/themes/:id (database themes only). */
export const ThemeUpdateInput = z.strictObject({
  definition: z.unknown().optional(),
  css: z.string().max(THEME_CSS_MAX_BYTES * 2).nullish(),
  /** The theme is active and fails AA: keep it active anyway. */
  acceptContrastFailures: z.boolean().default(false),
});

/** POST /api/admin/themes/:id/activate. */
export const ThemeActivateInput = z.strictObject({
  /** Activate although the theme fails WCAG 2.2 AA (default: refused). */
  acceptContrastFailures: z.boolean().default(false),
});
