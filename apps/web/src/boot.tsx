/**
 * Renders the app with the given routes on the client. Shared by the two entry
 * points: main.tsx (index.html: public pages and /admin) and main-public.tsx
 * (public.html: public pages only) when the page was not rendered by the server.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider, type RouteObject } from 'react-router';
import './lib/i18n';
import { ThemeProvider } from './lib/theme';
import { applyHead, HeadProvider, HeadStore } from './public/head';
import './styles.css';

export function boot(routes: RouteObject[]): void {
  const router = createBrowserRouter(routes);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: true,
      },
    },
  });

  // Public pages keep document.head in sync (usePageHead); the management UI sets its own title.
  const heads = new HeadStore(applyHead);

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <HeadProvider store={heads}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <RouterProvider router={router} />
          </ThemeProvider>
        </QueryClientProvider>
      </HeadProvider>
    </StrictMode>,
  );
}
