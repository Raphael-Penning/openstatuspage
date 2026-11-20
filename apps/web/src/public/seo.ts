/**
 * Search engine and link preview data of the public pages: meta descriptions,
 * language alternates and the schema.org JSON-LD (https://schema.org). Pure
 * functions; usePageHead (head.tsx) calls them with the page's data.
 *
 * Markup used, and only where it describes the page truthfully:
 *   - WebSite and Organization on the overview (name, URL, logo of the page settings),
 *   - BreadcrumbList on every other indexable page,
 *   - Article on incident and maintenance pages (a dated report of what happened).
 * No Event markup: an outage or a maintenance window is not an event people attend.
 */
import { LANG_QUERY } from '@openstatuspage/shared';
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

/** An incident or maintenance report, written and published by the organization. */
export function articleLd(site: SiteInfo, article: ArticleInput): Record<string, unknown> {
  const organization = {
    '@type': 'Organization',
    '@id': organizationId(site),
    name: site.name,
    url: homeUrl(site),
  };
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
    author: organization,
    publisher: site.logo ? { ...organization, logo: { '@type': 'ImageObject', url: site.logo } } : organization,
  };
}
