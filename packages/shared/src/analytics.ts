/**
 * Umami analytics of the public pages (docs/configuration.md#analytics), shared
 * by the server (proxy routes, opt-out form, the script tag of rendered pages)
 * and the web client (footer opt-out, render cache key).
 *
 * The browser only ever talks to this site: the script and the events go
 * through the server's own proxy paths below, which forward to UMAMI_URL. So the
 * Content-Security-Policy stays `script-src 'self'; connect-src 'self'`, and the
 * Umami server is neither visible to visitors nor reachable through the page.
 * The paths avoid the names blocking lists look for (`umami`, `script.js`,
 * `analytics`, `stats`).
 */

/** Proxy paths of the analytics script and of the event endpoint. */
export const ANALYTICS_PATHS = {
  /** GET: Umami's tracker script (UMAMI_URL/script.js), cached by the server. */
  script: '/pulse/p.js',
  /** `data-host-url` of the script tag: the tracker sends its events to `<host>/api/send`. */
  host: '/pulse',
  /** POST: one tracker event, forwarded to UMAMI_URL/api/send. */
  send: '/pulse/api/send',
} as const;

/** Cookie of the visitor's choice: `off` disables analytics for this browser (set by the footer form). */
export const ANALYTICS_COOKIE = 'osp-analytics';
/** Value of {@link ANALYTICS_COOKIE} that turns analytics off. */
export const ANALYTICS_OFF = 'off';
/**
 * localStorage key Umami's tracker checks before sending anything. The footer
 * keeps it in line with {@link ANALYTICS_COOKIE} when JavaScript runs (set when
 * opted out, removed otherwise), so the tracker of the current page stops at
 * once and the cookie stays the single source of truth.
 */
export const UMAMI_DISABLED_KEY = 'umami.disabled';

/** Analytics settings of the page (a subset of PublicPageSettings). */
export interface AnalyticsSettings {
  analyticsEnabled?: boolean;
  analyticsWebsiteId?: string | null;
  analyticsDomains?: string | null;
  analyticsRespectDnt?: boolean;
}

/** What the script tag of a page carries. */
export interface AnalyticsTag {
  websiteId: string;
  /** Comma separated host names (`data-domains`); empty: every host. */
  domains: string;
  /** `data-do-not-track`: the tracker sends nothing when the browser asks not to be tracked. */
  doNotTrack: boolean;
}

/**
 * Whether the page settings turn analytics on. The public settings document
 * carries `analyticsEnabled: true` only when the instance also has UMAMI_URL.
 */
export function analyticsActive(settings: AnalyticsSettings | null | undefined): boolean {
  return Boolean(settings?.analyticsEnabled && settings.analyticsWebsiteId);
}

/** Value of a cookie in a Cookie header; null when it is missing or malformed. */
function cookieValue(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

/** Whether the visitor turned analytics off (the {@link ANALYTICS_COOKIE} cookie of a Cookie header). */
export function analyticsOptedOut(cookieHeader: string | null | undefined): boolean {
  return cookieValue(cookieHeader, ANALYTICS_COOKIE) === ANALYTICS_OFF;
}

/**
 * The script tag of a rendered page, or null when there is none: analytics off
 * in the settings (or no UMAMI_URL), the visitor opted out, or a personal page
 * (a subscription link with its token).
 */
export function analyticsTag(
  settings: AnalyticsSettings | null | undefined,
  options: { optedOut: boolean; personal: boolean },
): AnalyticsTag | null {
  if (!analyticsActive(settings) || options.optedOut || options.personal) return null;
  return {
    websiteId: settings!.analyticsWebsiteId!,
    domains: settings!.analyticsDomains ?? '',
    doNotTrack: settings!.analyticsRespectDnt !== false,
  };
}
