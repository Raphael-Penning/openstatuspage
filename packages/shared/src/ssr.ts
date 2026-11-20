/**
 * Contract between the server and the server-side rendering bundle of the web
 * client (apps/web/src/entry-server.tsx, built to apps/web/dist/.ssr/). The
 * server loads the bundle lazily and calls `render` for every public page; the
 * bundle never talks HTTP to its own server but reads the public JSON:API
 * documents through the `source` the server passes in.
 */
import type { DataDocument } from './jsonapi.js';

/** Visitor theme preference (cookie `osp-theme`, falls back to the page default). */
export type ThemePreference = 'system' | 'light' | 'dark';

/** Cookie with the visitor's language choice (set by the language switcher). */
export const LANG_COOKIE = 'osp-lang';
/** Cookie with the visitor's theme choice (set by the theme switcher). */
export const THEME_COOKIE = 'osp-theme';
/** Query parameter that selects the language of a page (`?lang=de`). */
export const LANG_QUERY = 'lang';
/** Id of the non-executable JSON block with the dehydrated state (`<script type="application/json">`). */
export const SSR_STATE_ID = 'osp-state';

/**
 * Head data of one page. Pages set it with `usePageHead` (apps/web/src/public/head.tsx);
 * the server writes it into the HTML head, the client keeps document.head in
 * sync after navigations.
 */
export interface PageHead {
  /** Full document title ("Incident · Example Status"). */
  title: string;
  /** Meta description. */
  description?: string;
  /** Canonical URL: an absolute URL or a path below the public base URL. null: none. */
  canonical?: string | null;
  /** Meta robots, e.g. "noindex". Omitted: indexable. */
  robots?: string;
  /** JSON-LD objects, each written as its own `<script type="application/ld+json">`. */
  jsonLd?: Record<string, unknown>[];
  /** HTTP status of the page (404 for unknown pages and entities). Default 200. */
  status?: number;
}

/** Error of a {@link PublicDocumentSource}: the HTTP status the API would answer with. */
export interface SourceError extends Error {
  status: number;
}

/**
 * Read access to the public JSON:API, in-process on the server. `get` takes the
 * API path (`/api/public/services/web`) and the JSON:API query parameters
 * (`{ 'page[number]': '2' }`) exactly as the client sends them, and resolves the
 * document the API would answer with, or rejects with a {@link SourceError}.
 */
export interface PublicDocumentSource {
  get(path: string, query?: Record<string, string>): Promise<DataDocument>;
}

export interface SsrRenderInput {
  /** Requested path with query string ("/history?type=incident"). */
  url: string;
  source: PublicDocumentSource;
  /** Raw Cookie header (language and theme choice). */
  cookie?: string;
  /** Raw Accept-Language header. */
  acceptLanguage?: string;
  /** Effective public base URL without trailing slash (canonical links, JSON-LD). */
  baseUrl: string;
  /** Render time (ms since epoch). Relative times render against it on server and hydration. */
  now?: number;
}

export interface SsrRenderResult {
  /** HTTP status: 404 when the page or its entity does not exist. */
  status: number;
  /** Markup of the app (the content of `<div id="root">`). */
  html: string;
  /** Head data of the page, canonical already absolute. */
  head: PageHead;
  /** UI language of the page (`<html lang>`). */
  lang: string;
  /** Text direction of the language (`<html dir>`). */
  dir: 'ltr' | 'rtl';
  /** Theme preference the page rendered with; `light`/`dark` go to `<html data-theme>`. */
  theme: ThemePreference;
  /** Dehydrated state, JSON escaped for embedding in `<script type="application/json">`. */
  state: string;
}

/** Module interface of the SSR bundle. */
export interface SsrModule {
  render(input: SsrRenderInput): Promise<SsrRenderResult>;
}

/** Serializes a value as JSON that is safe inside a `<script>` element (no `</script>`, `<!--`, line separators). */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
