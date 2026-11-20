import { describe, expect, it } from 'vitest';
import { scriptJson } from './ssr.js';

describe('scriptJson', () => {
  it('cannot close the script element or open a comment, and parses back', () => {
    const value = { title: '</script><script>alert(1)</script>', note: '<!-- & -->', lines: 'a\u2028b\u2029c' };
    const json = scriptJson(value);
    expect(json).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(json)).toEqual(value);
  });
});
