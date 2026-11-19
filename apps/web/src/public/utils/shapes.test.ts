import { SERVICE_STATUSES } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import { STATUS_SHAPE, statusShapePath } from './shapes';

describe('status marker shapes', () => {
  it('gives every status its own shape, so the map does not rely on color alone', () => {
    const shapes = SERVICE_STATUSES.map((s) => STATUS_SHAPE[s]);
    expect(new Set(shapes).size).toBe(SERVICE_STATUSES.length);
  });

  it('returns closed paths that stay within the marker size', () => {
    for (const status of SERVICE_STATUSES) {
      const d = statusShapePath(status, 6);
      expect(d).toMatch(/^M.*Z$/);
      const numbers = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      for (const n of numbers) expect(Math.abs(n)).toBeLessThanOrEqual(12);
    }
  });
});
