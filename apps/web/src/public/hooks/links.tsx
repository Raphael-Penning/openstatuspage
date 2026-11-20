/**
 * Internal links of the public pages that have to work below another base
 * path, too: the day links of the uptime bars and the day pages.
 *
 * The public pages live at "/" (base ""). Pages served below a prefix, such as
 * a secret page at /p/<token>, wrap their tree in <LinkBaseProvider base="/p/<token>">;
 * every path built with useServicePaths() then starts with that prefix. The
 * path builders themselves are pure (servicePath, serviceDayPath in
 * @openstatuspage/shared), so the server builds the same paths.
 */
import { serviceDayPath, servicePath } from '@openstatuspage/shared';
import { createContext, useCallback, useContext, useMemo, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

const LinkBaseContext = createContext('');

/** Prefix (without trailing slash) of the internal links below it, e.g. "/p/<token>". */
export function LinkBaseProvider({ base, children }: { base: string; children: ReactNode }) {
  return <LinkBaseContext.Provider value={base.replace(/\/+$/, '')}>{children}</LinkBaseContext.Provider>;
}

/** The current link base ("" on the public pages). */
export function useLinkBase(): string {
  return useContext(LinkBaseContext);
}

export interface ServicePaths {
  /** Start page below the link base: "/" on the public pages, "/p/<token>" on a private page. */
  home: string;
  service: (service: { slug?: string | null; id: string }) => string;
  day: (service: { slug?: string | null; id: string }, day: string) => string;
}

/** Path builders of service and day pages below the current link base. */
export function useServicePaths(): ServicePaths {
  const base = useLinkBase();
  return useMemo(
    () => ({
      home: base || '/',
      service: (service) => servicePath(service, base),
      day: (service, day) => serviceDayPath(service, day, base),
    }),
    [base],
  );
}

/**
 * Click handler for a container of plain `<a href>` links (up to hundreds of
 * day links, cheaper than as many <Link> components): a plain click on a link
 * to a path of this site navigates in the client; clicks with a modifier key,
 * other buttons and links with a target keep the browser's behaviour. Without
 * JavaScript the links simply load the page.
 */
export function useClientLinks(): (e: MouseEvent<HTMLElement>) => void {
  const navigate = useNavigate();
  return useCallback(
    (e: MouseEvent<HTMLElement>) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.('a[href]');
      if (!link || !e.currentTarget.contains(link) || link.getAttribute('target')) return;
      const href = link.getAttribute('href') ?? '';
      if (!href.startsWith('/') || href.startsWith('//')) return;
      e.preventDefault();
      void navigate(href);
    },
    [navigate],
  );
}
