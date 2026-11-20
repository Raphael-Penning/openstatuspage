import { describe, expect, it } from 'vitest';
import { analyticsActive, analyticsOptedOut, analyticsTag } from './analytics.js';
import { SettingsInput } from './schemas.js';

const ID = '4f3c2b1a-1234-4abc-8def-0123456789ab';
const base = { siteName: 'Status' };

describe('analytics settings', () => {
  it('are off by default and respect Do Not Track', () => {
    const s = SettingsInput.parse(base);
    expect(s).toMatchObject({
      analyticsEnabled: false,
      analyticsDomains: '',
      analyticsRespectDnt: true,
      analyticsForwardIp: false,
    });
    expect(s.analyticsWebsiteId).toBeUndefined();
  });

  it('need a website ID when enabled', () => {
    const r = SettingsInput.safeParse({ ...base, analyticsEnabled: true });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['analyticsWebsiteId']);
    expect(SettingsInput.safeParse({ ...base, analyticsEnabled: true, analyticsWebsiteId: ID }).success).toBe(true);
  });

  it('accept only a UUID as website ID', () => {
    for (const id of ['abc', `${ID}x`, `../${ID}`, `${ID}\n`, '']) {
      expect(SettingsInput.safeParse({ ...base, analyticsWebsiteId: id }).success, id).toBe(false);
    }
    expect(SettingsInput.safeParse({ ...base, analyticsWebsiteId: ID.toUpperCase() }).success).toBe(true);
  });

  it('normalize the domain list and reject anything but host names', () => {
    expect(SettingsInput.parse({ ...base, analyticsDomains: ' Status.Example.com, ,status.example.org ' }).analyticsDomains).toBe(
      'status.example.com,status.example.org',
    );
    for (const d of ['https://example.com', 'example.com/path', 'exa mple.com', 'example.com:8080', '"><script>', '-x.com']) {
      expect(SettingsInput.safeParse({ ...base, analyticsDomains: d }).success, d).toBe(false);
    }
  });
});

describe('analyticsTag', () => {
  const on = { analyticsEnabled: true, analyticsWebsiteId: ID, analyticsDomains: 'status.example.com', analyticsRespectDnt: true };

  it('is only rendered when enabled with a website ID', () => {
    expect(analyticsActive(on)).toBe(true);
    expect(analyticsActive({ ...on, analyticsEnabled: false })).toBe(false);
    expect(analyticsActive({ ...on, analyticsWebsiteId: null })).toBe(false);
    expect(analyticsActive(undefined)).toBe(false);
    expect(analyticsTag(on, { optedOut: false, personal: false })).toEqual({
      websiteId: ID,
      domains: 'status.example.com',
      doNotTrack: true,
    });
    expect(analyticsTag({ ...on, analyticsRespectDnt: false }, { optedOut: false, personal: false })?.doNotTrack).toBe(false);
  });

  it('is never rendered for visitors who opted out or on personal pages', () => {
    expect(analyticsTag(on, { optedOut: true, personal: false })).toBeNull();
    expect(analyticsTag(on, { optedOut: false, personal: true })).toBeNull();
  });

  it('reads the opt-out cookie', () => {
    expect(analyticsOptedOut('osp-theme=dark; osp-analytics=off')).toBe(true);
    expect(analyticsOptedOut('osp-analytics=on')).toBe(false);
    expect(analyticsOptedOut('x-osp-analytics=off')).toBe(false);
    expect(analyticsOptedOut(undefined)).toBe(false);
  });
});
