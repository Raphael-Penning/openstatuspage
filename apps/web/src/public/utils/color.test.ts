import { describe, expect, it } from 'vitest';
import { contrastRatio, parseHex, readableOn, solidAccent } from './color';

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
  });

  it('rejects invalid colors', () => {
    expect(parseHex('red')).toBeNull();
    expect(contrastRatio('red', '#ffffff')).toBe(1);
  });
});

describe('readableOn', () => {
  it('keeps colors that are readable already', () => {
    expect(readableOn('#1d4ed8', '#ffffff')).toBe('#1d4ed8');
  });

  it('darkens on light and lightens on dark backgrounds', () => {
    const light = readableOn('#7c6cf2', '#ffffff');
    expect(contrastRatio(light, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    const dark = readableOn('#3b2fa0', '#1e1e21');
    expect(contrastRatio(dark, '#1e1e21')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('solidAccent', () => {
  it('keeps white text on saturated accents', () => {
    const s = solidAccent('#7c6cf2');
    expect(s.foreground).toBe('#ffffff');
    expect(contrastRatio(s.background, s.foreground)).toBeGreaterThanOrEqual(4.5);
  });

  it('uses dark text on light accents', () => {
    const s = solidAccent('#facc15');
    expect(s.foreground).toBe('#18181b');
    expect(contrastRatio(s.background, s.foreground)).toBeGreaterThanOrEqual(4.5);
  });
});
