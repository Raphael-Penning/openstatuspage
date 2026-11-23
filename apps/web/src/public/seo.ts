/**
 * Search engine and link preview data of the public pages: meta descriptions,
 * language alternates and the schema.org JSON-LD (https://schema.org). Pure
 * functions; usePageHead (head.tsx) calls them with the page's data.
 *
 * Markup used, and only where it describes the page truthfully:
 *   - WebSite and Organization on the overview (name, URL, logo of the page settings),
 *   - BreadcrumbList on every other indexable page,
 *   - Article on incident pages (a dated report of what happened, about the
 *     affected services),
 *   - Event on maintenance pages: a scheduled window with start and end, held
 *     online (VirtualLocation: the status page), organized by the organization,
 *     EventCancelled when it was cancelled,
 *   - Service on service pages (name, description, URL, provider). schema.org
 *     has no property for the current status of a Service, so it is not marked up,
 *   - AboutPage (the about page) or WebPage (legal notice, privacy policy,
 *     accessibility statement, custom pages) on the content pages.
 * Not SpecialAnnouncement for incidents: schema.org defines it for public
 * health and emergency announcements, and Google no longer shows it.
 * Pages that are not indexed (private pages, day pages, variants, errors)
 * carry no JSON-LD at all (head.tsx).
 */
import { LANG_QUERY, type MaintenanceStatus } from '@openstatuspage/shared';
import { LANGUAGES } from '../lib/languages';

/** Longest meta description; search engines cut longer ones. */
export const DESCRIPTION_MAX = 160;
/** Longest Article headline Google shows. */
export const HEADLINE_MAX = 110;

const SCHEMA = 'https://schema.org';

/** Single line, at most `max` characters, cut at a word boundary with an ellipsis. */
export function summarize(text: string, max = DESCRIPTION_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:–-]+$/, '')}…`;
}

/** Absolute URL of a path below the public base URL (absolute URLs stay as they are). */
export function absoluteUrl(pathOrUrl: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${baseUrl.replace(/\/+$/, '')}/${pathOrUrl.replace(/^\/+/, '')}`;
}

/** Path of a page in one language (`/history?lang=de`); null: the language negotiated page. */
export function withLang(pathname: string, lang: string | null): string {
  return lang ? `${pathname}?${LANG_QUERY}=${encodeURIComponent(lang)}` : pathname;
}

/**
 * hreflang alternates of a page: every language as `?lang=xx` and the plain
 * path (language from cookie, Accept-Language or the page default) as x-default.
 */
export function languageAlternates(pathname: string, baseUrl: string): { hreflang: string; href: string }[] {
  return [
    ...LANGUAGES.map((l) => ({ hreflang: l.code, href: absoluteUrl(withLang(pathname, l.code), baseUrl) })),
    { hreflang: 'x-default', href: absoluteUrl(pathname, baseUrl) },
  ];
}

export interface SiteInfo {
  /** Site name of the settings. */
  name: string;
  /** Effective public base URL without trailing slash. */
  baseUrl: string;
  /** Website of the organisation (the brand link of the settings), as Organization sameAs. */
  sameAs?: string[];
  /** Absolute logo URL, if the settings have one. */
  logo?: string;
  description?: string;
  /** Language of the page (BCP 47). */
  lang: string;
}

const homeUrl = (site: SiteInfo) => `${site.baseUrl}/`;
const organizationId = (site: SiteInfo) => `${homeUrl(site)}#organization`;

/** The organization behind the status page (also author and publisher of the reports). */
export function organizationLd(site: SiteInfo): Record<string, unknown> {
  return {
    '@context': SCHEMA,
    '@type': 'Organization',
    '@id': organizationId(site),
    name: site.name,
    url: homeUrl(site),
    ...(site.logo ? { logo: site.logo } : {}),
    ...(site.sameAs?.length ? { sameAs: site.sameAs } : {}),
  };
}

export function websiteLd(site: SiteInfo): Record<string, unknown> {
  return {
    '@context': SCHEMA,
    '@type': 'WebSite',
    '@id': `${homeUrl(site)}#website`,
    name: site.name,
    url: homeUrl(site),
    ...(site.description ? { description: site.description } : {}),
    inLanguage: site.lang,
    publisher: { '@id': organizationId(site) },
  };
}

export interface Crumb {
  name: string;
  /** Path of the page (`/services`). */
  path: string;
}

/** Breadcrumbs from the overview (named after the site) to the page itself (the last crumb). */
export function breadcrumbLd(site: SiteInfo, trail: Crumb[]): Record<string, unknown> {
  const items = [{ name: site.name, path: '/' }, ...trail];
  return {
    '@context': SCHEMA,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: absoluteUrl(crumb.path, site.baseUrl),
    })),
  };
}

export interface ArticleInput {
  headline: string;
  description: string;
  /** ISO 8601 timestamps. */
  datePublished: string;
  dateModified: string;
  /** Absolute URL of the page. */
  url: string;
}

/** The organization as a nested object (self-contained: other pages define it fully). */
const organizationRef = (site: SiteInfo) => ({
  '@type': 'Organization',
  '@id': organizationId(site),
  name: site.name,
  url: homeUrl(site),
});

/** The organization as publisher: with its logo when there is one. */
const publisherOf = (site: SiteInfo) =>
  site.logo ? { ...organizationRef(site), logo: { '@type': 'ImageObject', url: site.logo } } : organizationRef(site);

/** A thing a page is about (a service), with its page. */
export interface AboutRef {
  name: string;
  /** Absolute URL of its page. */
  url: string;
}

/** An incident report, written and published by the organization. */
export function articleLd(site: SiteInfo, article: ArticleInput & { about?: AboutRef[] }): Record<string, unknown> {
  return {
    '@context': SCHEMA,
    '@type': 'Article',
    headline: summarize(article.headline, HEADLINE_MAX),
    description: article.description,
    datePublished: article.datePublished,
    dateModified: article.dateModified < article.datePublished ? article.datePublished : article.dateModified,
    inLanguage: site.lang,
    url: article.url,
    mainEntityOfPage: article.url,
    ...(site.logo ? { image: site.logo } : {}),
    author: organizationRef(site),
    publisher: publisherOf(site),
    ...(article.about?.length ? { about: article.about.map((a) => ({ '@type': 'Service', name: a.name, url: a.url })) } : {}),
  };
}

export interface EventInput {
  name: string;
  description: string;
  /** ISO 8601 timestamps. */
  startDate: string;
  endDate: string;
  status: MaintenanceStatus;
  /** Absolute URL of the page. */
  url: string;
}

/** A maintenance window: a scheduled event held online on the status page, organized by the organization. */
export function eventLd(site: SiteInfo, event: EventInput): Record<string, unknown> {
  return {
    '@context': SCHEMA,
    '@type': 'Event',
    '@id': `${event.url}#event`,
    name: summarize(event.name, HEADLINE_MAX),
    description: event.description,
    startDate: event.startDate,
    endDate: event.endDate < event.startDate ? event.startDate : event.endDate,
    eventStatus: `${SCHEMA}/${event.status === 'cancelled' ? 'EventCancelled' : 'EventScheduled'}`,
    eventAttendanceMode: `${SCHEMA}/OnlineEventAttendanceMode`,
    location: { '@type': 'VirtualLocation', url: homeUrl(site) },
    organizer: organizationRef(site),
    url: event.url,
    inLanguage: site.lang,
    ...(site.logo ? { image: site.logo } : {}),
  };
}

export interface ServiceInput {
  name: string;
  description?: string;
  /** Absolute URL of the service page. */
  url: string;
}

/** A service of the organization (its page on the status page). No status: schema.org has no property for it. */
export function serviceLd(site: SiteInfo, service: ServiceInput): Record<string, unknown> {
  return {
    '@context': SCHEMA,
    '@type': 'Service',
    '@id': `${service.url}#service`,
    name: service.name,
    ...(service.description ? { description: service.description } : {}),
    url: service.url,
    provider: organizationRef(site),
  };
}

/** schema.org types of the content pages. */
export type WebPageType = 'WebPage' | 'AboutPage' | 'ContactPage';

export interface WebPageInput {
  type: WebPageType;
  name: string;
  description: string;
  /** Absolute URL of the page. */
  url: string;
  /** ISO 8601 timestamps. */
  datePublished: string;
  dateModified: string;
}

/** A content page (about page, legal pages, custom pages) of the status page, published by the organization. */
export function webPageLd(site: SiteInfo, page: WebPageInput): Record<string, unknown> {
  return {
    '@context': SCHEMA,
    '@type': page.type,
    '@id': `${page.url}#webpage`,
    name: page.name,
    description: page.description,
    url: page.url,
    inLanguage: site.lang,
    datePublished: page.datePublished,
    dateModified: page.dateModified < page.datePublished ? page.datePublished : page.dateModified,
    isPartOf: { '@type': 'WebSite', '@id': `${homeUrl(site)}#website`, name: site.name, url: homeUrl(site) },
    publisher: publisherOf(site),
    ...(page.type === 'AboutPage' ? { about: organizationRef(site) } : {}),
  };
}

/**
 * Characters of Markdown markdownText reads. A meta description is cut to
 * DESCRIPTION_MAX anyway; reading only the start keeps the cost of a render
 * bounded for long or unbalanced bodies (up to 50,000 characters).
 */
export const MARKDOWN_TEXT_SCAN_MAX = 2000;

/** Plain text of Markdown for a meta description: no markup, no image or link targets. */
export function markdownText(markdown: string): string {
  return markdown
    .slice(0, MARKDOWN_TEXT_SCAN_MAX)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)/g, ' ')
    .replace(/\[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~|]+/g, '')
    .replace(/<[^>\n]{0,200}>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
