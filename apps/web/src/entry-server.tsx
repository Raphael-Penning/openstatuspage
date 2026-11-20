/**
 * Server-side rendering of the public pages (built with `vite build --ssr` to
 * dist/.ssr/entry-server.mjs, loaded lazily by the server, see the server's
 * ssr/ directory). Public route tree only: never import ./admin here.
 *
 * render():
 *   1. loads the page settings and resolves language and theme (?lang=, cookie,
 *      Accept-Language, page default),
 *   2. prefetches the queries of the matched routes (`handle.prefetch` in
 *      public/routes.tsx) from the in-process document source,
 *   3. renders the route tree with react-router's static router and collects
 *      the page head (usePageHead),
 *   4. dehydrates the query cache into the state block the browser hydrates from.
 */
import {
  analyticsOptedOut,
  analyticsTag,
  isPersonalPath,
  LANG_COOKIE,
  LANG_QUERY,
  scriptJson,
  THEME_COOKIE,
  type PageHead,
  type PublicDocumentSource,
  type SsrRenderInput,
  type SsrRenderResult,
} from '@openstatuspage/shared';
import { dehydrate, QueryClient, type FetchQueryOptions } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { createStaticHandler, createStaticRouter, matchRoutes, StaticRouterProvider } from 'react-router';
import { ApiError } from './lib/api';
import { publicI18n } from './lib/i18n-public';
import { fromAcceptLanguage, isLanguage, languageDir, readCookie, resolveLanguage } from './lib/languages';
import { isThemePreference } from './lib/theme';
import { publicOnlyRoutes } from './public-router';
import { PublicApp } from './public/app';
import { absoluteUrl, HeadStore } from './public/head';
import { isNotFound, publicQueries, type GetDocument } from './public/hooks/queries';
import type { LoaderArgs, PublicRouteHandle } from './public/loaders';
import { encodeQueries, type SsrState } from './public/ssr-state';
import { accentCss } from './public/utils/accent';

export type { SsrRenderInput, SsrRenderResult } from '@openstatuspage/shared';

/** Leading `<link>`, `<meta>` and `<title>` elements of the markup. */
const HOISTED = /^(?:<(?:link|meta)\b[^>]*>|<title>[^<]*<\/title>)+/;

/** The source's errors as the ApiError the hooks expect (status 404 → "not found" state). */
function documentGetter(source: PublicDocumentSource): GetDocument {
  return async (path, query) => {
    try {
      return await source.get(path, query);
    } catch (err) {
      const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 0;
      if (status >= 400 && status < 500) {
        const message = err instanceof Error ? err.message : 'Request failed';
        throw new ApiError(status, { error: status === 404 ? 'not_found' : `http_${status}`, message });
      }
      throw err;
    }
  };
}

/**
 * Query parameters the public pages read (?lang= and the filters, pages and
 * states of the routes). Personal pages are rendered with their whole URL and
 * never cached; the server does not call pageUrl for them.
 */
const PAGE_PARAMS = [LANG_QUERY, 'upcoming', 'q', 'status', 'type', 'service', 'location', 'month', 'page', 'sent', 'error'];

/**
 * The URL a public page is rendered with: the path and only the query
 * parameters the pages read, in a fixed order. Other parameters (tracking,
 * cache busting) change nothing on the page, so they share its cached render.
 */
export function pageUrl(url: string): string {
  const parsed = new URL(url, 'http://ssr.invalid');
  const kept = new URLSearchParams();
  for (const name of PAGE_PARAMS) {
    const value = parsed.searchParams.get(name);
    if (value !== null) kept.set(name, value);
  }
  const query = kept.toString();
  return query ? `${parsed.pathname}?${query}` : parsed.pathname;
}

/**
 * Cache key of a rendered page: its URL as pageUrl() gives it, the language
 * and theme inputs and the analytics opt-out (pages with and without the
 * analytics script never share a render). The page default language is the
 * same for every request, so it is not part of it.
 */
export function cacheKey(input: Pick<SsrRenderInput, 'url' | 'cookie' | 'acceptLanguage'>): string {
  const cookieLang = readCookie(input.cookie, LANG_COOKIE);
  const theme = readCookie(input.cookie, THEME_COOKIE);
  return [
    pageUrl(input.url),
    isLanguage(cookieLang) ? cookieLang : '',
    fromAcceptLanguage(input.acceptLanguage) ?? '',
    isThemePreference(theme) ? theme : '',
    analyticsOptedOut(input.cookie) ? 'analytics-off' : '',
  ].join('\n');
}

export async function render(input: SsrRenderInput): Promise<SsrRenderResult> {
  const now = input.now ?? Date.now();
  const url = new URL(input.url, 'http://ssr.invalid');
  const get = documentGetter(input.source);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });

  try {
    // Data errors other than 404 reject (the server then sends the plain page).
    const load: LoaderArgs['load'] = async <T,>(options: FetchQueryOptions<T, any, T, any>) => {
      try {
        return await queryClient.fetchQuery({ ...options, retry: false });
      } catch (err) {
        if (isNotFound(err)) return undefined;
        throw err;
      }
    };

    const settings = await queryClient.fetchQuery({ ...publicQueries.settings(get), retry: false });
    const lang = resolveLanguage({
      cookie: input.cookie,
      query: url.searchParams.get(LANG_QUERY),
      acceptLanguage: input.acceptLanguage,
      fallback: settings.defaultLocale,
    });
    const cookieTheme = readCookie(input.cookie, THEME_COOKIE);
    const theme = isThemePreference(cookieTheme) ? cookieTheme : settings.defaultTheme;

    const matches = matchRoutes(publicOnlyRoutes, url.pathname) ?? [];
    await Promise.all(
      matches.map((m) =>
        (m.route.handle as PublicRouteHandle | undefined)?.prefetch?.({
          params: m.params,
          search: url.searchParams,
          settings,
          get,
          load,
        }),
      ),
    );

    const handler = createStaticHandler(publicOnlyRoutes);
    const context = await handler.query(new Request(url.href));
    if (context instanceof Response) throw new Error(`Unexpected response ${context.status} from the static handler`);
    const router = createStaticRouter(handler.dataRoutes, context);

    const analyticsOff = analyticsOptedOut(input.cookie);
    const ssr = { now, theme, baseUrl: input.baseUrl, form: input.form, analyticsOff };
    const heads = new HeadStore();
    const markup = renderToString(
      <PublicApp queryClient={queryClient} ssr={ssr} head={heads} server i18n={publicI18n(lang)}>
        <StaticRouterProvider router={router} context={context} hydrate={false} />
      </PublicApp>,
    );

    // React emits hoistable elements (link, meta, title) of the pages first; they go into <head>.
    const hoisted = HOISTED.exec(markup)?.[0] ?? '';
    const html = markup.slice(hoisted.length);

    const collected: PageHead = heads.current() ?? { title: settings.siteName };
    const head: PageHead = {
      ...collected,
      canonical: collected.canonical ? absoluteUrl(collected.canonical, input.baseUrl) : null,
    };

    const state: SsrState = {
      v: 1,
      lang,
      theme,
      now,
      baseUrl: input.baseUrl,
      ...(analyticsOff ? { analyticsOff } : {}),
      ...(input.form ? { form: input.form } : {}),
      queries: encodeQueries(
        dehydrate(queryClient, {
          shouldDehydrateQuery: (q) => q.state.status === 'success' || isNotFound(q.state.error),
        }),
      ),
    };

    // Never on personal pages (subscription links carry a token) nor for visitors who opted out.
    const analytics = analyticsTag(settings, { optedOut: analyticsOff, personal: isPersonalPath(input.url) });

    return {
      status: head.status ?? 200,
      html,
      hoisted,
      head,
      lang,
      dir: languageDir(lang),
      theme,
      state: scriptJson(state),
      css: accentCss(settings.accentColor),
      ...(analytics ? { analytics } : {}),
    };
  } finally {
    queryClient.clear();
  }
}
