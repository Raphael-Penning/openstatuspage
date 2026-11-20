/**
 * Route loaders of the public pages: which queries a page needs, so the server
 * can prefetch them before rendering (entry-server.tsx). Each route of
 * routes.tsx names its loader in `handle.prefetch`; the layout's settings query
 * is always loaded first.
 *
 * Add a loader for a route: list the queries its page reads on the first
 * render, built with `publicQueries.<name>(…, get)` so the key is exactly the
 * one the page's hook uses. Queries that depend on another result can await it:
 *
 *   prefetch: async ({ params, load, get }) => {
 *     const service = await load(publicQueries.service(params.slug ?? '', get));
 *     if (service?.locationIds.length) await load(publicQueries.locations(get));
 *   }
 */
import type { PublicPageSettings } from '@openstatuspage/shared';
import type { FetchQueryOptions } from '@tanstack/react-query';
import type { Params } from 'react-router';
import type { GetDocument } from './hooks/queries';

export interface LoaderArgs {
  params: Params;
  search: URLSearchParams;
  /** Public page settings (already loaded). */
  settings: PublicPageSettings;
  /** Document source to pass to publicQueries. */
  get: GetDocument;
  /**
   * Fetches a query into the cache that is dehydrated into the page. Resolves the
   * data, or undefined when the API answers 404 (the page then renders its "not
   * found" state, and the response gets status 404). Other errors reject.
   */
  // Any query key and error type.
  load: <T>(options: FetchQueryOptions<T, any, T, any>) => Promise<T | undefined>;
}

export type RouteLoader = (args: LoaderArgs) => Promise<unknown>;

/** `handle` of a public route. */
export interface PublicRouteHandle {
  prefetch?: RouteLoader;
}
