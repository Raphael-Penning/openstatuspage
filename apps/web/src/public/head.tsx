/**
 * Page head API of the public pages: title, description, canonical URL,
 * robots, language alternates, link previews (Open Graph, Twitter card),
 * JSON-LD and the HTTP status.
 *
 *   usePageHead({ title: service.name, description, breadcrumbs: [...] });
 *   usePageHead({ title: incident.title, article: { ... }, breadcrumbs: [...] });
 *   usePageHead({ title: t('notFound.title'), status: 404, robots: 'noindex' });
 *
 * Every page calls usePageHead once. On the server the calls are collected while
 * rendering and the result goes into the HTML head and the HTTP status
 * (entry-server.tsx). In the browser the active page keeps document.head in sync.
 * When several heads are active (a page renders <NotFoundState>, which sets its
 * own), an error status (>= 400) wins, otherwise the one registered last.
 *
 * Defaults from the page settings: site name (title suffix, og:site_name),
 * description, logo (og:image, Organization logo) and accent color (theme-color).
 * URLs are absolute with the public base URL (state.baseUrl; the page's origin
 * in a client-only render).
 */
import { canonicalPath, HEAD_ATTR, headElements, LANG_QUERY, type HeadElement, type PageHead } from '@openstatuspage/shared';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { DEFAULT_LANGUAGE, isLanguage, LANGUAGES } from '../lib/languages';
import { useSsr } from '../lib/ssr';
import { usePublicSettings } from './hooks/queries';
import {
  absoluteUrl,
  articleLd,
  breadcrumbLd,
  languageAlternates,
  organizationLd,
  summarize,
  websiteLd,
  withLang,
  type Crumb,
  type SiteInfo,
} from './seo';

export interface PageHeadInput {
  /** Page title without the site name; null/undefined: the site name alone (overview). */
  title?: string | null;
  /** Meta description (shortened to 160 characters); empty: the page description of the settings. */
  description?: string | null;
  /**
   * Canonical path of the page; default: the current path (lower case, without a
   * trailing slash). `?lang=` of the request
   * is kept (each language version is its own canonical page). null: none.
   */
  canonical?: string | null;
  /** Meta robots; default `index, follow`, or `noindex` for an error status. */
  robots?: string;
  /** Extra JSON-LD objects. */
  jsonLd?: Record<string, unknown>[];
  status?: number;
  /** Overview page: WebSite and Organization markup. */
  home?: boolean;
  /** Pages between the overview and this page, this page last (BreadcrumbList). */
  breadcrumbs?: Crumb[];
  /** Incident and maintenance reports: Article markup and og:type article. */
  article?: { datePublished: string; dateModified: string };
}

/** Collects the heads of the rendered pages; applies the winner in the browser. */
export class HeadStore {
  private readonly heads = new Map<number, PageHead>();
  private seq = 0;

  constructor(private readonly onChange?: (head: PageHead | null) => void) {}

  register(head: PageHead): () => void {
    const id = ++this.seq;
    this.heads.set(id, head);
    this.changed();
    return () => {
      this.heads.delete(id);
      this.changed();
    };
  }

  /** Head of the page: the last error head, else the last registered one. */
  current(): PageHead | null {
    let winner: PageHead | null = null;
    for (const head of this.heads.values()) {
      if (!winner || (head.status ?? 200) >= 400 || (winner.status ?? 200) < 400) winner = head;
    }
    return winner;
  }

  private changed(): void {
    this.onChange?.(this.current());
  }
}

const HeadContext = createContext<{ store: HeadStore; server: boolean } | null>(null);

/** `server`: collect during render (no effects run on the server); otherwise register in an effect. */
export function HeadProvider({ store, server = false, children }: { store: HeadStore; server?: boolean; children: ReactNode }) {
  const value = useMemo(() => ({ store, server }), [store, server]);
  return <HeadContext.Provider value={value}>{children}</HeadContext.Provider>;
}

/** Public base URL: the server's (render and hydration), else the page's origin. */
export function useBaseUrl(): string {
  const ssr = useSsr();
  if (ssr) return ssr.baseUrl;
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** Site name of the settings (page titles, descriptions). */
export function useSiteName(): string {
  const { t } = useTranslation('public');
  const { data: settings } = usePublicSettings();
  return settings?.siteName ?? t('fallbackSiteName');
}

/** Full head of a page: site name in the title, defaults from the settings. */
export function usePageHead(input: PageHeadInput): void {
  const { t, i18n } = useTranslation('public');
  const { data: settings } = usePublicSettings();
  const { pathname, search } = useLocation();
  const baseUrl = useBaseUrl();
  const context = useContext(HeadContext);

  const site = settings?.siteName ?? t('fallbackSiteName');
  const lang = isLanguage(i18n.language) ? i18n.language : DEFAULT_LANGUAGE;
  const status = input.status ?? 200;
  const indexable = status < 400 && !(input.robots ?? '').includes('noindex');
  const description = summarize(input.description || settings?.description || t('seo.default', { site }));
  // The page's path in its preferred spelling (/SERVICES/ → /services; a page with
  // several URLs passes its preferred one); null: no canonical URL.
  const path = input.canonical === undefined ? canonicalPath(pathname) : input.canonical;
  const queryLang = new URLSearchParams(search).get(LANG_QUERY);
  const canonical = path ? absoluteUrl(withLang(path, isLanguage(queryLang) ? queryLang : null), baseUrl) : null;
  const info: SiteInfo = {
    name: site,
    baseUrl,
    lang,
    ...(settings?.logoUrl ? { logo: absoluteUrl(settings.logoUrl, baseUrl) } : {}),
    ...(settings?.description ? { description: summarize(settings.description) } : {}),
  };

  const jsonLd: Record<string, unknown>[] = [];
  if (indexable) {
    if (input.home) jsonLd.push(websiteLd(info), organizationLd(info));
    if (input.article && canonical) {
      jsonLd.push(articleLd(info, { headline: input.title ?? site, description, url: canonical, ...input.article }));
    }
    if (input.breadcrumbs?.length) jsonLd.push(breadcrumbLd(info, input.breadcrumbs));
    if (input.jsonLd) jsonLd.push(...input.jsonLd);
  }

  const head: PageHead = {
    title: input.title ? `${input.title} · ${site}` : site,
    description,
    canonical,
    robots: input.robots ?? (indexable ? 'index, follow' : 'noindex'),
    ...(jsonLd.length ? { jsonLd } : {}),
    ...(input.status ? { status: input.status } : {}),
    siteName: site,
    type: input.article ? 'article' : 'website',
    locale: LANGUAGES.find((l) => l.code === lang)!.ogLocale,
    localeAlternates: LANGUAGES.filter((l) => l.code !== lang).map((l) => l.ogLocale),
    ...(info.logo ? { image: info.logo } : {}),
    ...(settings?.accentColor ? { themeColor: settings.accentColor } : {}),
    ...(indexable && path ? { alternates: languageAlternates(path, baseUrl) } : {}),
  };
  const key = JSON.stringify(head);

  if (context?.server) context.store.register(head);

  useEffect(() => {
    if (context && !context.server) return context.store.register(JSON.parse(key) as PageHead);
    // Without a provider (tests, admin preview): the title at least.
    document.title = (JSON.parse(key) as PageHead).title;
    return undefined;
  }, [context, key]);
}

function matches(el: Element, spec: HeadElement): boolean {
  if (el.tagName.toLowerCase() !== spec.tag) return false;
  const names = Object.keys(spec.attrs);
  if (el.attributes.length !== names.length || names.some((n) => el.getAttribute(n) !== spec.attrs[n])) return false;
  return spec.text === undefined || el.textContent === spec.text;
}

/**
 * Writes a head into document.head: the title and the elements the server
 * renders (marked with data-osp-head). Without a head (no public page shown any
 * more) the elements are removed.
 */
export function applyHead(head: PageHead | null): void {
  if (head && document.title !== head.title) document.title = head.title;
  const next = head ? headElements(head) : [];
  const current = [...document.head.querySelectorAll(`[${HEAD_ATTR}]`)];
  if (current.length === next.length && current.every((el, i) => matches(el, next[i]!))) return;
  for (const el of current) el.remove();
  // The description of the client-rendered template (no server render).
  for (const el of document.head.querySelectorAll('meta[name="description"]')) el.remove();
  for (const spec of next) {
    const el = document.createElement(spec.tag);
    for (const [name, value] of Object.entries(spec.attrs)) el.setAttribute(name, value);
    if (spec.text !== undefined) el.textContent = spec.text;
    document.head.appendChild(el);
  }
}

export { absoluteUrl, HEAD_ATTR };
