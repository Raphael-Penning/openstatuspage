import { describe, expect, it } from 'vitest';
import { serviceDayPath } from './days.js';
import { isPrivatePageToken, privatePageBase, PrivatePageInput } from './private-pages.js';

describe('private page tokens and paths', () => {
  it('accepts only 32 characters of lower-case base32', () => {
    expect(isPrivatePageToken('abcdefghijklmnopqrstuvwxyz234567')).toBe(true);
    expect(isPrivatePageToken('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')).toBe(false);
    expect(isPrivatePageToken('abcdefghijklmnopqrstuvwxyz23456')).toBe(false);
    expect(isPrivatePageToken('abcdefghijklmnopqrstuvwxyz234568')).toBe(false);
    expect(isPrivatePageToken('')).toBe(false);
  });

  it('builds the link base of the service and day links', () => {
    const base = privatePageBase('abcdefghijklmnopqrstuvwxyz234567');
    expect(base).toBe('/p/abcdefghijklmnopqrstuvwxyz234567');
    expect(serviceDayPath({ id: 's1', slug: 'web' }, '2026-11-01', base)).toBe(
      '/p/abcdefghijklmnopqrstuvwxyz234567/services/web/days/2026-11-01',
    );
  });

  it('validates the admin input', () => {
    expect(PrivatePageInput.parse({ name: ' Partner ' })).toEqual({ name: 'Partner', serviceIds: [], enabled: true });
    expect(PrivatePageInput.safeParse({ name: '' }).success).toBe(false);
    expect(PrivatePageInput.safeParse({ name: 'x', expiresAt: 'tomorrow' }).success).toBe(false);
  });
});
