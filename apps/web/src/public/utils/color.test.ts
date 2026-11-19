import { describe, expect, it } from 'vitest';
import { contrastRatio, parseHex, readableOn, readableOnAll, solidAccent } from './color';

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

describe('readableOnAll', () => {
  const lightBackgrounds = ['#f7f7f8', '#ffffff', '#f1f1f3'];
  const darkBackgrounds = ['#161618', '#1e1e21', '#26262a'];

  it.each(['#7c6cf2', '#ffd400', '#00ff00', '#ff0000', '#00bcd4', '#ffffff', '#000000'])(
    'makes the accent %s readable on every background of a theme',
    (accent) => {
      for (const backgrounds of [lightBackgrounds, darkBackgrounds]) {
        const color = readableOnAll(accent, backgrounds);
        for (const bg of backgrounds) expect(contrastRatio(color, bg)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it('keeps an accent that is readable everywhere', () => {
    expect(readableOnAll('#1d4ed8', lightBackgrounds)).toBe('#1d4ed8');
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
