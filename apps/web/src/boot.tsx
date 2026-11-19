/**
 * Renders the app with the given routes. Shared by the two entry points:
 * main.tsx (index.html: public pages and /admin) and main-public.tsx
 * (public.html: public pages only, served by APP_ROLE=public instances).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider, type RouteObject } from 'react-router';
import './lib/i18n';
import { ThemeProvider } from './lib/theme';
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

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
