/**
 * Contract between the server and the server-side rendering bundle of the web
 * client (apps/web/src/entry-server.tsx, built to apps/web/dist/.ssr/). The
 * server loads the bundle lazily and calls `render` for every public page; the
 * bundle never talks HTTP to its own server but reads the public JSON:API
 * documents through the `source` the server passes in.
 */
import type { AnalyticsTag } from './analytics.js';
import type { DataDocument } from './jsonapi.js';

/** Visitor theme preference (cookie `osp-theme`, falls back to the page default). */
export type ThemePreference = 'system' | 'light' | 'dark';

/** Cookie with the visitor's language choice (set by the language switcher). */
export const LANG_COOKIE = 'osp-lang';
/** Cookie with the visitor's theme choice (set by the theme switcher). */
export const THEME_COOKIE = 'osp-theme';
/** UI languages of the public pages (apps/web/src/lib/languages.ts has their names). */
export const PAGE_LANGUAGES = ['en', 'de'] as const;
/** Query parameter that selects the language of a page (`?lang=de`). */
export const LANG_QUERY = 'lang';
/**
 * Request path as the client router sees it: percent-decoded, lower-cased,
 * with repeated slashes collapsed (react-router matches routes case-insensitively)
 * and dot segments resolved ("/./p/x", "/a/../p/x" and "/%2e/p/x" are "/p/x",
 * as for the router and every browser). A backslash is a path separator, as
 * the WHATWG URL parser (and so the server-side renderer) treats it in http
 * URLs: "/p\\abc" and "/p%5cabc" are "/p/abc". Malformed escapes keep the raw
 * path, which the router does not decode either.
 */
export function normalizePath(url: string): string {
  const raw = url.split(/[?#]/)[0] ?? '';
  let path = raw;
  try {
    path = decodeURIComponent(raw);
  } catch {
    // keep the raw path
  }
  return resolveDotSegments(path.replace(/\\/g, '/').toLowerCase().replace(/\/{2,}/g, '/'));
}

/**
 * True when a path has a "." or ".." segment, also percent-encoded ("%2e",
 * "..%2f", also between backslashes). Browsers resolve them before sending a request, so only hand-made
 * requests carry them.
 */
export function hasDotSegments(url: string): boolean {
  const raw = url.split(/[?#]/)[0] ?? '';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw.replace(/%2e/gi, '.').replace(/%2f/gi, '/');
  }
  return [raw.replace(/%2e/gi, '.'), decoded].some((path) => path.split(/[\\/]/).some((part) => part === '.' || part === '..'));
}

/** RFC 3986 remove_dot_segments for an absolute path (never above "/"). */
function resolveDotSegments(path: string): string {
  if (!path.split('/').some((part) => part === '.' || part === '..')) return path;
  const parts = path.split('/');
  const out: string[] = [];
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    if (part === '.' || part === '..') {
      if (part === '..' && out.length > 1) out.pop();
      if (last) out.push('');
    } else {
      out.push(part);
    }
  }
  const resolved = out.join('/');
  return resolved.startsWith('/') ? resolved : `/${resolved}`;
}

/**
 * Preferred spelling of a page path (canonical URL, redirect target): lower
 * case, single slashes, no trailing slash. Percent escapes stay as they are.
 * Slugs and ids of public pages are lower case, so nothing distinct is merged.
 */
export function canonicalPath(pathname: string): string {
  const path = pathname.toLowerCase().replace(/\/{2,}/g, '/');
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * Pages with a personal link token in their URL (subscription confirm and
 * manage, private pages at /p/<token>), in any spelling of the path: never
 * cached, never served stale, never indexed, without analytics, and their path
 * and query never copied into other URLs.
 */
export function isPersonalPath(url: string): boolean {
  const path = normalizePath(url);
  return path.startsWith('/subscription/') || path === '/p' || path.startsWith('/p/');
}

/**
 * Themes (themes.ts; kept here, apart from the theme schemas, so the public
 * client does not bundle them): the preview query parameter (signed-in admins
 * only), the path prefix of the theme stylesheets and the attribute of their
 * link elements (the browser adds them only when the server did not).
 */
export const THEME_PREVIEW_QUERY = 'theme';
export const THEME_CSS_PREFIX = '/theme/';
export const THEME_LINK_ATTR = 'data-osp-theme';

/** The theme part of the public settings: the stylesheets the pages load. */
export interface PublicThemeInfo {
  id: string;
  /** Same-origin stylesheet URLs (`/theme/<hash>.css`): tokens, then the extra CSS. */
  stylesheets: string[];
}

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
  /** Site name (`og:site_name`). */
  siteName?: string;
  /** `og:type`: `article` for incidents and maintenance windows, otherwise `website`. */
  type?: 'website' | 'article';
  /** Open Graph locale of the page (`en_US`) and of its other languages. */
  locale?: string;
  localeAlternates?: string[];
  /** Absolute image URL for link previews (the logo); omitted: no image tags. */
  image?: string;
  /** `meta[name=theme-color]` (the accent color). */
  themeColor?: string;
  /** Language versions of the page (`hreflang` incl. `x-default`); hrefs like `canonical`. */
  alternates?: { hreflang: string; href: string }[];
}

/** One element of the page head besides `<title>` (see {@link headElements}). */
export interface HeadElement {
  tag: 'meta' | 'link' | 'script';
  attrs: Record<string, string>;
  /** Content of a script element: JSON, already escaped with {@link scriptJson}. */
  text?: string;
}

/** Attribute that marks the head elements of a page; the browser replaces exactly these after a navigation. */
export const HEAD_ATTR = 'data-osp-head';

/**
 * The head elements of a page in document order, the same on the server (as
 * HTML) and in the browser (as DOM elements). URLs (canonical, alternates,
 * image) must already be absolute. Every element carries {@link HEAD_ATTR}.
 */
export function headElements(head: PageHead): HeadElement[] {
  const out: HeadElement[] = [];
  const meta = (key: 'name' | 'property', name: string, content: string | undefined) => {
    if (content) out.push({ tag: 'meta', attrs: { [key]: name, content, [HEAD_ATTR]: '' } });
  };
  meta('name', 'description', head.description);
  meta('name', 'robots', head.robots);
  if (head.canonical) out.push({ tag: 'link', attrs: { rel: 'canonical', href: head.canonical, [HEAD_ATTR]: '' } });
  for (const alt of head.alternates ?? []) {
    out.push({ tag: 'link', attrs: { rel: 'alternate', hreflang: alt.hreflang, href: alt.href, [HEAD_ATTR]: '' } });
  }
  meta('name', 'theme-color', head.themeColor);
  // Open Graph (link previews in chats and social networks); Twitter/X reads it as well.
  meta('property', 'og:type', head.type ?? 'website');
  meta('property', 'og:site_name', head.siteName);
  meta('property', 'og:title', head.title);
  meta('property', 'og:description', head.description);
  meta('property', 'og:url', head.canonical ?? undefined);
  meta('property', 'og:locale', head.locale);
  for (const locale of head.localeAlternates ?? []) meta('property', 'og:locale:alternate', locale);
  meta('property', 'og:image', head.image);
  meta('name', 'twitter:card', 'summary');
  meta('name', 'twitter:title', head.title);
  meta('name', 'twitter:description', head.description);
  meta('name', 'twitter:image', head.image);
  for (const obj of head.jsonLd ?? []) {
    out.push({ tag: 'script', attrs: { type: 'application/ld+json', [HEAD_ATTR]: '' }, text: scriptJson(obj) });
  }
  return out;
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

/** Paths of the HTML form handlers (outside /api, form-urlencoded, Post/Redirect/Get). */
export const FORM_PATHS = {
  /** POST: theme=system|light|dark, return=<path>; sets the theme cookie. */
  theme: '/preferences/theme',
  /**
   * GET (a link) or POST (the form on personal pages, so their token never ends up in a
   * URL): lang=<code>, return=<path>; sets the language cookie (see LanguageSwitcher).
   */
  language: '/preferences/language',
  /** POST: analytics=off|on, return=<path>; sets or clears the analytics opt-out cookie (osp-analytics). */
  analytics: '/preferences/analytics',
  /** POST: email, locale, scope=all|selected, service=<id>…, group=<id>…, website (honeypot). */
  subscribe: '/subscribe',
  /** POST: id, token (the confirm token). */
  confirm: '/subscription/confirm',
  /** POST: id, token (the manage token), locale, scope, service…, group…. */
  manage: '/subscription/manage',
  /** POST: id, token (the manage token). */
  unsubscribe: '/subscription/unsubscribe',
  /** POST: kind=discord|slack|teams|generic, url, locale, scope, service…, group…, website → the code page. */
  subscribeWebhook: '/subscribe/webhook',
  /** POST: phone, locale, scope, service…, group…, website → the code page. */
  subscribeSms: '/subscribe/sms',
  /** POST: ref, code, channel → the manage page of the webhook or SMS subscription. */
  verify: '/subscription/verify',
  /** POST: id, token, locale, scope, service…, group… (webhook or SMS subscription). */
  channelManage: '/subscription/channel',
  /** POST: id, token (webhook or SMS subscription). */
  channelUnsubscribe: '/subscription/channel/unsubscribe',
} as const;

/** Query parameter of the preference handlers with the path to return to. */
export const RETURN_QUERY = 'return';

/** Validation issue of a form submission (the shape of a zod issue the pages map to messages). */
export interface FormIssue {
  path: (string | number)[];
  code: string;
}

/**
 * A form submission the server answers with the page itself instead of a redirect
 * (validation failed, rate limited): the page renders the submitted values, the
 * error summary and the field errors.
 */
export interface SsrFormState {
  /** Submitted fields (name → value, or all values of a repeated name). */
  values: Record<string, string | string[]>;
  /** Field problems (path[0] is the field: email, serviceIds, …). */
  issues?: FormIssue[];
  /** Problem with the whole submission. */
  error?: 'invalid' | 'rate_limited' | 'generic';
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
  /** Answer to a form submission: the page renders this form state (never cached). */
  form?: SsrFormState;
}

export interface SsrRenderResult {
  /** HTTP status: 404 when the page or its entity does not exist. */
  status: number;
  /** Markup of the app (the content of `<div id="root">`). */
  html: string;
  /**
   * Elements React hoists into the document head (`<link rel="alternate">`,
   * `<meta name="referrer">`, ...) that the pages render; they belong into `<head>`.
   */
  hoisted: string;
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
  /** The analytics script tag of the page (see analyticsTag); omitted: none. */
  analytics?: AnalyticsTag;
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
