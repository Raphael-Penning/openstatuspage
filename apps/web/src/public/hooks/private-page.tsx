/**
 * The private page a part of the tree belongs to (/p/<token>). Pages that also
 * appear on a private page (service, day) read their data through the private
 * page API when a token is set (hooks/queries.ts); the page head is never
 * indexed there (head.tsx), and links stay below /p/<token> (hooks/links.tsx).
 */
import { privatePageBase } from '@openstatuspage/shared';
import { createContext, useContext, type ReactNode } from 'react';
import { LinkBaseProvider } from './links';

const PrivatePageContext = createContext<string | null>(null);

/** Wraps a private page: its token for the queries and its link base for every service and day link. */
export function PrivatePageProvider({ token, children }: { token: string; children: ReactNode }) {
  return (
    <PrivatePageContext.Provider value={token}>
      <LinkBaseProvider base={privatePageBase(token)}>{children}</LinkBaseProvider>
    </PrivatePageContext.Provider>
  );
}

/** The token of the private page around this component; null on the main pages. */
export function usePrivatePageToken(): string | null {
  return useContext(PrivatePageContext);
}
