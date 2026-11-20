/**
 * Page head API of the public pages: title, description, canonical URL,
 * robots, JSON-LD and the HTTP status.
 *
 *   usePageHead({ title: incident.title, description: summary, jsonLd: [...] });
 *   usePageHead({ title: t('notFound.title'), status: 404, robots: 'noindex' });
 *
 * Every page calls usePageHead once. On the server the calls are collected while
 * rendering and the result goes into the HTML head and the HTTP status
 * (entry-server.tsx). In the browser the active page keeps document.head in sync.
 * When several heads are active (a page renders <NotFoundState>, which sets its
 * own), an error status (>= 400) wins, otherwise the one registered last.
 */
import { LANG_QUERY, type PageHead } from '@openstatuspage/shared';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { isLanguage } from '../lib/languages';
import { usePublicSettings } from './hooks/queries';

export interface PageHeadInput {
  /** Page title without the site name; null/undefined: the site name alone (overview). */
  title?: string | null;
  /** Meta description; default: the page description of the settings. */
  description?: string;
  /** Canonical path or URL; default: the current path without query (but with a valid ?lang=). null: none. */
  canonical?: string | null;
  robots?: string;
  jsonLd?: Record<string, unknown>[];
  status?: number;
}

/** Collects the heads of the rendered pages; applies the winner in the browser. */
export class HeadStore {
  private readonly heads = new Map<number, PageHead>();
  private seq = 0;

  constructor(private readonly onChange?: (head: PageHead) => void) {}

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
    const head = this.current();
    if (head && this.onChange) this.onChange(head);
  }
}

const HeadContext = createContext<{ store: HeadStore; server: boolean } | null>(null);

/** `server`: collect during render (no effects run on the server); otherwise register in an effect. */
export function HeadProvider({ store, server = false, children }: { store: HeadStore; server?: boolean; children: ReactNode }) {
  const value = useMemo(() => ({ store, server }), [store, server]);
  return <HeadContext.Provider value={value}>{children}</HeadContext.Provider>;
}

/** Full head of a page: site name in the title, defaults from the settings. */
export function usePageHead(input: PageHeadInput): void {
  const { t } = useTranslation('public');
  const { data: settings } = usePublicSettings();
  const { pathname, search } = useLocation();
  const context = useContext(HeadContext);
  const site = settings?.siteName ?? t('fallbackSiteName');

  const head: PageHead = {
    title: input.title ? `${input.title} · ${site}` : site,
    description: input.description ?? settings?.description ?? undefined,
    canonical: input.canonical === undefined ? languagePath(pathname, new URLSearchParams(search).get(LANG_QUERY)) : input.canonical,
    ...(input.robots ? { robots: input.robots } : {}),
    ...(input.jsonLd?.length ? { jsonLd: input.jsonLd } : {}),
    ...(input.status ? { status: input.status } : {}),
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

const HEAD_ATTR = 'data-osp-head';

function upsert(selector: string, create: () => HTMLElement): HTMLElement {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = create();
    document.head.appendChild(el);
  }
  return el;
}

function meta(name: string, content: string | undefined): void {
  const selector = `meta[name="${name}"]`;
  if (content === undefined) {
    document.head.querySelector(selector)?.remove();
    return;
  }
  upsert(selector, () => Object.assign(document.createElement('meta'), { name })).setAttribute('content', content);
}

/** Writes a head into document.head (the same elements the server renders). */
export function applyHead(head: PageHead, baseUrl: string): void {
  if (document.title !== head.title) document.title = head.title;
  meta('description', head.description);
  meta('robots', head.robots);
  const canonical = head.canonical ? absoluteUrl(head.canonical, baseUrl) : null;
  if (canonical) {
    upsert('link[rel="canonical"]', () => Object.assign(document.createElement('link'), { rel: 'canonical' })).setAttribute(
      'href',
      canonical,
    );
  } else {
    document.head.querySelector('link[rel="canonical"]')?.remove();
  }
  const ldSelector = `script[type="application/ld+json"][${HEAD_ATTR}]`;
  const next = (head.jsonLd ?? []).map((obj) => JSON.stringify(obj));
  const current = [...document.head.querySelectorAll(ldSelector)];
  if (current.map((el) => el.textContent).join('\n') !== next.join('\n')) {
    for (const el of current) el.remove();
    for (const json of next) {
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.setAttribute(HEAD_ATTR, '');
      script.textContent = json;
      document.head.appendChild(script);
    }
  }
}

/**
 * The page in one language (`?lang=de`, see the hreflang alternates of the
 * layout); without a supported language the path alone (x-default).
 */
export function languagePath(pathname: string, lang: string | null | undefined): string {
  return isLanguage(lang) ? `${pathname}?${LANG_QUERY}=${lang}` : pathname;
}

/** Absolute URL of a canonical path below the public base URL. */
export function absoluteUrl(pathOrUrl: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${baseUrl.replace(/\/+$/, '')}/${pathOrUrl.replace(/^\/+/, '')}`;
}

export { HEAD_ATTR };
