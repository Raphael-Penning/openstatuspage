/**
 * Server-side rendering of the public pages (built with `vite build --ssr` to
 * dist/.ssr/entry-server.mjs, loaded lazily by the server, see the server's
 * ssr/ directory). Public route tree only: never import ./admin here.
 *
 * render():
 *   1. loads the page settings and resolves language and theme (cookie, ?lang=,
 *      Accept-Language, page default),
 *   2. prefetches the queries of the matched routes (`handle.prefetch` in
 *      public/routes.tsx) from the in-process document source,
 *   3. renders the route tree with react-router's static router and collects
 *      the page head (usePageHead),
 *   4. dehydrates the query cache into the state block the browser hydrates from.
 */
import {
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
 * Part of the cache key of a rendered page that depends on the request (with the
 * URL): the language and theme inputs. The page default language is the same
 * for every request, so it is not part of it.
 */
export function cacheKey(input: Pick<SsrRenderInput, 'url' | 'cookie' | 'acceptLanguage'>): string {
  const cookieLang = readCookie(input.cookie, LANG_COOKIE);
  const theme = readCookie(input.cookie, THEME_COOKIE);
  return [
    input.url,
    isLanguage(cookieLang) ? cookieLang : '',
    fromAcceptLanguage(input.acceptLanguage) ?? '',
    isThemePreference(theme) ? theme : '',
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

    const ssr = { now, theme, baseUrl: input.baseUrl };
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
      queries: encodeQueries(
        dehydrate(queryClient, {
          shouldDehydrateQuery: (q) => q.state.status === 'success' || isNotFound(q.state.error),
        }),
      ),
    };

    return {
      status: head.status ?? 200,
      html,
      hoisted,
      head,
      lang,
      dir: languageDir(lang),
      theme,
      state: scriptJson(state),
    };
  } finally {
    queryClient.clear();
  }
}
