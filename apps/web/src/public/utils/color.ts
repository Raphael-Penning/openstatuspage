/**
 * Contrast helpers for the configurable accent color. The page owner can pick
 * any accent; these functions derive variants that keep text readable
 * (WCAG AA, 4.5:1) in both themes.
 */

type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two hex colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return 1;
  const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * The accent, darkened (light background) or lightened (dark background) in
 * small steps until it reaches `min` contrast against `background`.
 */
export function readableOn(accent: string, background: string, min = 4.5): string {
  const a = parseHex(accent);
  const bg = parseHex(background);
  if (!a || !bg) return accent;
  if (contrastRatio(accent, background) >= min) return toHex(a);
  const target: Rgb = luminance(bg) > 0.5 ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0.05; t <= 1; t += 0.05) {
    const candidate = toHex(mix(a, target, t));
    if (contrastRatio(candidate, background) >= min) return candidate;
  }
  return toHex(target);
}

const WHITE = '#ffffff';
const DARK = '#18181b';

/**
 * Background and text color for solid accent buttons. Saturated accents keep
 * white text and are darkened just enough; light accents get dark text.
 */
export function solidAccent(accent: string): { background: string; foreground: string } {
  if (!parseHex(accent)) return { background: accent, foreground: WHITE };
  if (contrastRatio(accent, WHITE) >= 3) return { background: readableOn(accent, WHITE), foreground: WHITE };
  return { background: readableOn(accent, DARK), foreground: DARK };
}
