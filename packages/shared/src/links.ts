/**
 * Outbound links of the public pages (footer, header info link, service
 * websites): pure helpers the server render and the browser share, so both
 * produce the same href (no hydration mismatch, same links without JavaScript).
 */

/** UTM settings of the page (a subset of PublicPageSettings). */
export interface UtmSettings {
  utmEnabled?: boolean;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
}

/** The WHATWG URL of Node.js and browsers (this package compiles without DOM or Node types). */
interface WhatwgUrl {
  readonly protocol: string;
  readonly origin: string;
  readonly searchParams: { keys(): Iterable<string>; append(name: string, value: string): void };
  toString(): string;
}
const Url = (globalThis as unknown as { URL: new (input: string) => WhatwgUrl }).URL;

const UTM_KEYS = [
  ['utm_source', 'utmSource'],
  ['utm_medium', 'utmMedium'],
  ['utm_campaign', 'utmCampaign'],
] as const;

/** The origin of an absolute http(s) URL; null for anything else. */
function httpOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new Url(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * True for an absolute http(s) URL on another origin than `siteOrigin` (the
 * public base URL of the page). Relative links, same-origin URLs, mailto: and
 * other schemes are not outbound.
 */
export function isOutboundUrl(href: string, siteOrigin?: string | null): boolean {
  const origin = httpOrigin(href);
  if (!origin) return false;
  const site = httpOrigin(siteOrigin);
  return site === null || origin !== site;
}

/**
 * The href of a configured link with the page's UTM parameters appended
 * (utm_source, utm_medium, utm_campaign; empty ones are left out). Unchanged
 * when UTM is off, when the link is not outbound ({@link isOutboundUrl}) or
 * when it already carries any utm_ parameter (they are never overwritten or
 * mixed). Keeps the fragment.
 */
export function outboundHref(href: string, utm: UtmSettings | null | undefined, siteOrigin?: string | null): string {
  if (!utm?.utmEnabled || !isOutboundUrl(href, siteOrigin)) return href;
  const params = UTM_KEYS.map(([param, key]) => [param, (utm[key] ?? '').trim()] as const).filter(([, v]) => v !== '');
  if (params.length === 0) return href;
  const url = new Url(href);
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase().startsWith('utm_')) return href;
  }
  for (const [param, value] of params) url.searchParams.append(param, value);
  return url.toString();
}

/**
 * Replaces `{year}` in a copyright notice (plain text; the caller escapes it
 * like any other text).
 */
export function formatCopyright(text: string, year: number): string {
  return text.replace(/\{year\}/g, String(year));
}
