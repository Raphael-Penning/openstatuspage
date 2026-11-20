/**
 * Hydrates a server-rendered public page (entry-server.tsx): same providers,
 * same language, theme, clock and query cache as the server, then the browser
 * takes over (visitor time zone and preferences, refetching every 60 s).
 */
import { hydrate, QueryClient } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { hydrateRoot, type RootOptions } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import i18n, { i18nReady } from './lib/i18n';
import { publicOnlyRoutes } from './public-router';
import { PublicApp } from './public/app';
import { applyHead, HeadStore } from './public/head';
import { decodeQueries, type SsrState } from './public/ssr-state';

/** Query defaults of the browser; errors from the server (404) are not retried on mount. */
export function browserQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true, retryOnMount: false },
    },
  });
}

export async function hydratePublic(
  container: HTMLElement,
  state: SsrState,
  options: Pick<RootOptions, 'onRecoverableError'> = {},
): Promise<void> {
  await i18nReady;
  if (i18n.resolvedLanguage !== state.lang) await i18n.changeLanguage(state.lang);

  const queryClient = browserQueryClient();
  hydrate(queryClient, decodeQueries(state.queries));
  const router = createBrowserRouter(publicOnlyRoutes);
  const heads = new HeadStore(applyHead);

  hydrateRoot(
    container,
    <StrictMode>
      <PublicApp queryClient={queryClient} ssr={{ now: state.now, theme: state.theme, baseUrl: state.baseUrl, form: state.form, analyticsOff: state.analyticsOff }} head={heads}>
        <RouterProvider router={router} />
      </PublicApp>
    </StrictMode>,
    options,
  );
}
