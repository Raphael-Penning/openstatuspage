/**
 * Providers around the public pages, the same on the server (entry-server.tsx)
 * and during hydration (hydrate.tsx), so both render the same tree.
 */
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import type { i18n as I18n } from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { SsrProvider, type SsrInfo } from '../lib/ssr';
import { ThemeProvider } from '../lib/theme';
import { HeadProvider, type HeadStore } from './head';

export interface PublicAppProps {
  queryClient: QueryClient;
  ssr: SsrInfo;
  head: HeadStore;
  /** Server: collect heads while rendering. */
  server?: boolean;
  /** i18next instance of the request (server); the browser uses the global one. */
  i18n?: I18n;
  children: ReactNode;
}

export function PublicApp({ queryClient, ssr, head, server = false, i18n, children }: PublicAppProps) {
  const app = (
    <SsrProvider value={ssr}>
      <HeadProvider store={head} server={server}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>{children}</ThemeProvider>
        </QueryClientProvider>
      </HeadProvider>
    </SsrProvider>
  );
  return i18n ? <I18nextProvider i18n={i18n}>{app}</I18nextProvider> : app;
}
