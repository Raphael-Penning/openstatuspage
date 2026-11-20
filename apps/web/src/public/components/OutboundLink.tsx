/**
 * Links the admin configured (footer, header info link, service websites).
 * Outbound http(s) links get the page's UTM parameters through the shared
 * `outboundHref` helper, with the same inputs on the server and in the browser
 * (the public base URL, the settings), so the server-rendered href is final.
 */
import { isOutboundUrl, outboundHref } from '@openstatuspage/shared';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useBaseUrl } from '../head';
import { usePublicSettings } from '../hooks/queries';

/** Resolves a configured href: UTM parameters on outbound links, everything else unchanged. */
export function useOutboundHref(): (href: string) => string {
  const { data: settings } = usePublicSettings();
  const baseUrl = useBaseUrl();
  return (href) => outboundHref(href, settings, baseUrl);
}

/** True when a configured href leaves the site (opens in a new tab). */
export function useIsOutbound(): (href: string) => boolean {
  const baseUrl = useBaseUrl();
  return (href) => isOutboundUrl(href, baseUrl);
}

/**
 * A configured link. Outbound links open in a new tab (like the other external
 * links of the pages) with rel="noopener noreferrer", an icon and a text for
 * screen readers saying so. Paths on this site are plain links: they may be
 * served outside the app (a reverse proxy), so no client-side routing.
 */
export function OutboundLink({ href, className, children, icon = true }: { href: string; className?: string; children: ReactNode; icon?: boolean }) {
  const { t } = useTranslation('public');
  const resolve = useOutboundHref();
  const outbound = useIsOutbound()(href);
  if (!outbound) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <a href={resolve(href)} className={className} target="_blank" rel="noopener noreferrer">
      {children}
      {icon && <ExternalLink aria-hidden className="ml-1 inline size-3.5 align-[-2px]" />}
      <span className="sr-only"> {t('link.newTab')}</span>
    </a>
  );
}
