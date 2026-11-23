/**
 * Parsing of the CSS colours a theme file may use (themes.ts): hex (`#rgb`,
 * `#rrggbb`), `rgb()`, `hsl()` and `oklch()`, in the comma or the space
 * syntax, always opaque (no alpha: the contrast of a translucent colour
 * depends on what is behind it). Everything is converted to sRGB for the
 * contrast checks; oklch colours outside sRGB are clipped to it, which is
 * what a display without a wide gamut shows.
 */
import { toHex } from './color.js';

export type Rgb = [number, number, number];

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const FUNCTION = /^(rgb|hsl|oklch)\(\s*([^()]*)\)$/i;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** "50%" or "0.5" → number; percentages relative to `percentOf`. */
function component(value: string, percentOf: number, allowPlain = true): number | null {
  const m = new RegExp(`^(${NUMBER})(%?)$`).exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === '%') return (n / 100) * percentOf;
  return allowPlain ? n : null;
}

function hue(value: string): number | null {
  const m = new RegExp(`^(${NUMBER})(deg|turn|rad|grad)?$`, 'i').exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  switch ((m[2] ?? 'deg').toLowerCase()) {
    case 'turn':
      return n * 360;
    case 'rad':
      return (n * 180) / Math.PI;
    case 'grad':
      return n * 0.9;
    default:
      return n;
  }
}

/** The arguments of a colour function: three values, comma or space separated, no alpha. */
function args(body: string): string[] | null {
  const text = body.trim();
  if (text.includes('/')) return null;
  const parts = text.includes(',') ? text.split(',').map((p) => p.trim()) : text.split(/\s+/);
  return parts.length === 3 && parts.every((p) => p !== '') ? parts : null;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hh = (((h % 360) + 360) % 360) / 360;
  const f = (n: number) => {
    const k = (n + hh * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function oklchToRgb(l: number, c: number, h: number): Rgb {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const gamma = (v: number) => {
    const x = clamp(v, 0, 1);
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  };
  return lin.map((v) => gamma(v) * 255) as Rgb;
}

/** sRGB (0..255 per channel) of an opaque CSS colour in one of the theme syntaxes; null for anything else. */
export function parseCssColor(input: string): Rgb | null {
  const value = input.trim();
  if (value.length > 64) return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((d) => d + d).join('') : hex[1]!;
    const n = Number.parseInt(digits, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const fn = FUNCTION.exec(value);
  if (!fn) return null;
  const parts = args(fn[2]!);
  if (!parts) return null;
  switch (fn[1]!.toLowerCase()) {
    case 'rgb': {
      const rgb = parts.map((p) => component(p, 255));
      if (rgb.some((v) => v === null || v < 0 || v > 255)) return null;
      return rgb as Rgb;
    }
    case 'hsl': {
      const h = hue(parts[0]!);
      const s = component(parts[1]!, 1, false);
      const l = component(parts[2]!, 1, false);
      if (h === null || s === null || l === null || s < 0 || s > 1 || l < 0 || l > 1) return null;
      return hslToRgb(h, s, l);
    }
    default: {
      const l = component(parts[0]!, 1);
      const c = component(parts[1]!, 0.4);
      const h = hue(parts[2]!);
      if (l === null || c === null || h === null || l < 0 || l > 1 || c < 0 || c > 0.5) return null;
      return oklchToRgb(l, c, h);
    }
  }
}

/** `#rrggbb` of a theme colour (for the contrast helpers in color.ts); null when it is none. */
export function cssColorToHex(input: string): string | null {
  const rgb = parseCssColor(input);
  return rgb ? toHex(rgb.map((v) => clamp(v, 0, 255)) as Rgb) : null;
}
