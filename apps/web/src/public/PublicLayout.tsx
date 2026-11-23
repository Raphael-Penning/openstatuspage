/**
 * Shared shell of all public pages: header with branding and visitor
 * preferences, pill navigation, content outlet and footer.
 */
import {
  analyticsActive,
  FORM_PATHS,
  formatCopyright,
  RETURN_QUERY,
  THEME_LINK_ATTR,
  localizedText,
  UMAMI_DISABLED_KEY,
  type PublicSitePageLink,
  type SystemPageKey,
} from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { Activity, Earth, FileText, Info, LayoutDashboard, LockKeyhole, RotateCcwClock, Server } from 'lucide-react';
import { useEffect, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, ScrollRestoration, useLocation } from 'react-router';
import { LANGUAGES } from '../lib/languages';
import { useAnalyticsOff, useSsr } from '../lib/ssr';
import { ThemeProvider, useTheme } from '../lib/theme';
import { LANG_CHOSEN_KEY, LanguageSwitcher, ThemeSwitcher, TimeZoneToggle, useReturnPath } from './components/Controls';
import { OutboundLink } from './components/OutboundLink';
import { Skeleton } from './components/ui';
import { useLinkBase } from './hooks/links';
import { PreferencesProvider, usePreferences } from './hooks/preferences';
import { usePrivatePageToken } from './hooks/private-page';
import { usePublicSettings, type PublicSiteSettings } from './hooks/queries';

export function PublicLayout() {
  const { data: settings } = usePublicSettings();
  return (
    <ThemeProvider defaultPreference={settings?.defaultTheme ?? 'system'}>
      <PreferencesProvider>
        <ThemeSync />
        <PageEffects settings={settings} />
        <Shell settings={settings} />
      </PreferencesProvider>
    </ThemeProvider>
  );
}

/**
 * The app-wide ThemeProvider (main.tsx) does not know the page default. This
 * nested provider does; re-apply its theme when the OS theme changes so the
 * outer provider cannot overwrite it.
 */
function ThemeSync() {
  const { preference, resolved } = useTheme();
  useEffect(() => {
    // The OS preference itself, not `resolved`: right after hydration that is still the server's guess.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = preference === 'system' ? (mq.matches ? 'dark' : 'light') : preference;
    };
    apply();
    const reapply = () => window.setTimeout(apply, 0);
    mq.addEventListener('change', reapply);
    return () => mq.removeEventListener('change', reapply);
  }, [preference, resolved]);
  return null;
}

/** Theme stylesheets, favicon, document language and the page default language. */
function PageEffects({ settings }: { settings: PublicSiteSettings | undefined }) {
  const { i18n } = useTranslation();
  const ssr = useSsr();

  // The theme (tokens with the accent in effect, extra CSS) is a stylesheet the server links
  // in a rendered page. A page rendered in the browser (no server rendering) adds it here.
  const stylesheets = settings?.theme?.stylesheets;
  useEffect(() => {
    if (!stylesheets || document.querySelector(`link[${THEME_LINK_ATTR}]`)) return;
    for (const href of stylesheets) {
      if (!/^\/theme\/[0-9a-f]+\.css$/.test(href)) continue;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.setAttribute(THEME_LINK_ATTR, '');
      document.head.appendChild(link);
    }
  }, [stylesheets]);

  useEffect(() => {
    const href = settings?.faviconUrl || '/favicon.svg';
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    if (link.getAttribute('href') !== href) {
      link.href = href;
      link.removeAttribute('type');
    }
  }, [settings?.faviconUrl]);

  // The page default language applies when the visitor neither picked a
  // language nor has a browser language we support. A server-rendered page
  // already is in the language the server picked by the same rules.
  useEffect(() => {
    const fallback = settings?.defaultLocale;
    if (ssr || !fallback || fallback === i18n.resolvedLanguage) return;
    let chosen = false;
    try {
      chosen = localStorage.getItem(LANG_CHOSEN_KEY) === '1';
    } catch {
      /* storage unavailable */
    }
    if (chosen) return;
    const supported = LANGUAGES.map((l) => l.code as string);
    const browserMatch = navigator.languages.some((l) => supported.includes(l.slice(0, 2).toLowerCase()));
    if (!browserMatch) void i18n.changeLanguage(fallback);
  }, [settings?.defaultLocale, i18n, ssr]);

  return null;
}

function Shell({ settings }: { settings: PublicSiteSettings | undefined }) {
  const { t } = useTranslation('public');
  const mainRef = useRef<HTMLElement>(null);
  useFocusOnNavigation(mainRef);
  // A private page (/p/<token>): no navigation to the main pages and no feeds of them.
  const isPrivate = usePrivatePageToken() !== null;
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      {/* React 19 hoists these into <head>. */}
      {!isPrivate && <link rel="alternate" type="application/rss+xml" title={t('feeds.rss')} href="/feed.rss" />}
      {!isPrivate && <link rel="alternate" type="application/atom+xml" title={t('feeds.atom')} href="/feed.atom" />}

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-[color:var(--osp-accent-solid,var(--accent))] focus:px-4 focus:py-2 focus:text-[color:var(--osp-accent-solid-fg,var(--accent-fg))]"
      >
        {t('skipToContent')}
      </a>

      <Header settings={settings} />
      {isPrivate ? (
        <PrivateNotice />
      ) : (
        <NavTabs showLocations={settings?.showLocations !== false} settings={settings} />
      )}

      <main ref={mainRef} id="main" tabIndex={-1} className="mx-auto w-full max-w-[1100px] flex-1 px-4 pt-8 pb-16 focus:outline-none sm:px-6">
        <Outlet />
      </main>

      <Footer settings={settings} />
      <ScrollRestoration getKey={(location) => location.pathname} />
    </div>
  );
}

/**
 * A client-side navigation does not reset focus like a page load does: move it
 * to the start of the new content so keyboard and screen reader users are not
 * left on a link that no longer exists (WCAG 2.4.3). Changes of the query
 * string only (history filters) keep the focus where it is.
 */
function useFocusOnNavigation(mainRef: RefObject<HTMLElement | null>) {
  const { pathname } = useLocation();
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname, mainRef]);
}

function Header({ settings }: { settings: PublicSiteSettings | undefined }) {
  const { t } = useTranslation('public');
  const { isError } = usePublicSettings();
  // The logo leads to the start of the private page when inside one.
  const base = useLinkBase();
  const home = base || '/';
  return (
    <header className="mx-auto flex w-full max-w-[1100px] flex-wrap items-center justify-between gap-3 px-4 pt-5 sm:px-6">
      <Link to={home} className="flex min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-focus">
        {settings?.logoUrl ? (
          <img
            src={settings.logoUrl}
            alt=""
            className="h-8 w-auto max-w-32 object-contain"
            {...(settings.logoSize ? { width: settings.logoSize.width, height: settings.logoSize.height } : {})}
          />
        ) : (
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-[color:var(--osp-accent-solid,var(--accent))] text-[color:var(--osp-accent-solid-fg,var(--accent-fg))]">
            <Activity className="size-5" />
          </span>
        )}
        {settings || isError ? (
          <span className="text-lg font-semibold break-words">{settings?.siteName ?? t('fallbackSiteName')}</span>
        ) : (
          <Skeleton className="h-5 w-32" />
        )}
        <span className="sr-only">{base ? t('private.home') : t('header.home')}</span>
      </Link>
      <div className="flex items-center gap-2">
        <TimeZoneToggle />
        <LanguageSwitcher />
        <ThemeSwitcher />
      </div>
    </header>
  );
}

/** In place of the navigation on a private page: what it is and that its link is not for everyone. */
function PrivateNotice() {
  const { t } = useTranslation('public');
  return (
    <aside aria-label={t('private.badge')} className="mx-auto mt-6 w-full max-w-[1100px] px-4 sm:px-6">
      <p className="mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-3xl border border-border bg-surface px-4 py-2 text-center text-sm text-muted">
        <LockKeyhole aria-hidden className="size-4 shrink-0" />
        <strong className="font-medium text-fg">{t('private.badge')}</strong>
        <span>{t('private.notice')}</span>
      </p>
    </aside>
  );
}

/** A published system page of the settings document, if any. */
const systemPageLink = (settings: PublicSiteSettings | undefined, key: SystemPageKey) => settings?.pages?.find((p) => p.systemKey === key);

/** Custom pages published for one place (footer or navigation), in their order. */
const customPages = (settings: PublicSiteSettings | undefined, place: 'showInFooter' | 'showInNav'): PublicSitePageLink[] =>
  (settings?.pages ?? []).filter((p) => p.systemKey === null && p[place]);

const navLinkClass =
  'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';

function NavTabs({ showLocations, settings }: { showLocations: boolean; settings: PublicSiteSettings | undefined }) {
  const { t, i18n } = useTranslation('public');
  const { pathname } = useLocation();
  // The about page, once published, is the info link (its label stays configurable);
  // otherwise the configured info link (an external page or a path on this site).
  const about = systemPageLink(settings, 'about');
  const info = about
    ? { url: about.path, label: settings?.infoLinkLabel || localizedText(about.title, i18n.language), internal: true }
    : settings?.infoLinkUrl
      ? { url: settings.infoLinkUrl, label: settings.infoLinkLabel || t('nav.info'), internal: false }
      : null;
  const pages = customPages(settings, 'showInNav');
  const items = [
    { to: '/', label: t('nav.overview'), Icon: LayoutDashboard, active: pathname === '/' },
    { to: '/services', label: t('nav.services'), Icon: Server, active: pathname.startsWith('/services') },
    ...(showLocations
      ? [{ to: '/locations', label: t('nav.locations'), Icon: Earth, active: pathname.startsWith('/locations') }]
      : []),
    {
      to: '/history',
      label: t('nav.history'),
      Icon: RotateCcwClock,
      active: ['/history', '/incidents/', '/maintenance/'].some((p) => pathname.startsWith(p)),
    },
  ];

  return (
    <nav aria-label={t('nav.label')} className="mx-auto mt-6 w-full max-w-[1100px] px-4 sm:px-6">
      {/* Wraps instead of scrolling sideways on narrow screens (reflow, WCAG 1.4.10). */}
      <div className="mx-auto w-fit max-w-full rounded-3xl border border-border bg-surface p-1">
        <ul className="flex flex-wrap justify-center gap-1">
          {items.map(({ to, label, Icon, active }) => (
            <li key={to} className="shrink-0">
              <Link
                to={to}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                  active ? 'bg-surface-2 text-fg shadow-sm' : 'text-muted hover:text-fg',
                )}
              >
                <Icon aria-hidden className="size-4" />
                {label}
              </Link>
            </li>
          ))}
          {/* Custom pages shown in the navigation. */}
          {pages.map((p) => (
            <li key={p.path} className="shrink-0">
              <Link
                to={p.path}
                aria-current={pathname === p.path ? 'page' : undefined}
                className={clsx(navLinkClass, pathname === p.path ? 'bg-surface-2 text-fg shadow-sm' : 'text-muted hover:text-fg')}
              >
                <FileText aria-hidden className="size-4" />
                {localizedText(p.title, i18n.language)}
              </Link>
            </li>
          ))}
          {/* The about page or the configured info link; hidden without either. */}
          {info &&
            (info.internal ? (
              <li className="shrink-0">
                <Link
                  to={info.url}
                  aria-current={pathname === info.url ? 'page' : undefined}
                  className={clsx(navLinkClass, pathname === info.url ? 'bg-surface-2 text-fg shadow-sm' : 'text-muted hover:text-fg')}
                >
                  <Info aria-hidden className="size-4" />
                  {info.label}
                </Link>
              </li>
            ) : (
              <li className="shrink-0">
                <OutboundLink href={info.url} className={clsx(navLinkClass, 'text-muted hover:text-fg')}>
                  <Info aria-hidden className="size-4" />
                  {info.label}
                </OutboundLink>
              </li>
            ))}
        </ul>
      </div>
    </nav>
  );
}

/**
 * Legal pages of the footer, in this order: the published internal page, else
 * the external link of the settings; hidden without either.
 */
const LEGAL_LINKS = [
  ['imprint', 'legal-notice', 'imprintUrl', 'imprintLabel'],
  ['privacy', 'privacy', 'privacyUrl', 'privacyLabel'],
  ['accessibility', 'accessibility', 'accessibilityUrl', 'accessibilityLabel'],
] as const;

const linkClass = 'rounded-sm underline-offset-2 hover:text-fg hover:underline';

function Footer({ settings }: { settings: PublicSiteSettings | undefined }) {
  const { t, i18n } = useTranslation('public');
  // The shared clock: the server's render time until hydration (no mismatch at New Year).
  const year = new Date(usePreferences().now).getUTCFullYear();
  const copyright = settings?.copyrightText
    ? formatCopyright(settings.copyrightText, year)
    : t('footer.copyright', { year, name: settings?.siteName ?? t('fallbackSiteName') });
  // Analytics never runs on private pages (entry-server.tsx), so there is nothing to choose there.
  const isPrivate = usePrivatePageToken() !== null;
  const analytics = !isPrivate && analyticsActive(settings);
  const legal = LEGAL_LINKS.flatMap(([key, pageKey, urlKey, labelKey]) => {
    const page = systemPageLink(settings, pageKey);
    const url = page?.path ?? settings?.[urlKey];
    return url ? [{ key, url, label: settings?.[labelKey] || t(`footer.${key}`), internal: Boolean(page) }] : [];
  });
  const pages = isPrivate ? [] : customPages(settings, 'showInFooter');
  // The statistics choice comes right after the privacy policy (or where it would be).
  const analyticsAt = legal.filter((l) => l.key === 'imprint' || l.key === 'privacy').length;
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-4 py-8 text-sm text-muted sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          {/* A private page has no status API or feeds of its own: those of the main page stay out. */}
          {(!isPrivate || settings?.supportUrl || (settings?.footerLinks.length ?? 0) > 0) && (
            <nav aria-label={t('footer.label')}>
              <ul className="flex flex-wrap gap-x-5 gap-y-2">
                {!isPrivate && (
                  <>
                    <li>
                      <a href="/api/public/status" className={linkClass}>
                        {t('footer.statusApi')}
                      </a>
                    </li>
                    <li>
                      <a href="/feed.rss" className={linkClass}>
                        {t('feeds.rss')}
                      </a>
                    </li>
                    <li>
                      <a href="/feed.atom" className={linkClass}>
                        {t('feeds.atom')}
                      </a>
                    </li>
                  </>
                )}
                {settings?.supportUrl && (
                  <li>
                    <OutboundLink href={settings.supportUrl} className={linkClass}>
                      {t('footer.support')}
                    </OutboundLink>
                  </li>
                )}
                {pages.map((p) => (
                  <li key={p.path}>
                    <Link to={p.path} className={linkClass}>
                      {localizedText(p.title, i18n.language)}
                    </Link>
                  </li>
                ))}
                {settings?.footerLinks.map((l) => (
                  <li key={`${l.label}-${l.url}`}>
                    <OutboundLink href={l.url} className={linkClass}>
                      {l.label}
                    </OutboundLink>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {/* Legal pages (internal pages or external links) and, when analytics runs, the visitor's statistics choice. */}
          {(legal.length > 0 || analytics) && (
            <nav aria-label={t('footer.legal')}>
              <ul className="flex flex-wrap gap-x-5 gap-y-2 sm:justify-end">
                {legal.slice(0, analyticsAt).map((l) => (
                  <LegalLink key={l.key} url={l.url} label={l.label} internal={l.internal} />
                ))}
                {analytics && (
                  <li>
                    <AnalyticsChoice />
                  </li>
                )}
                {legal.slice(analyticsAt).map((l) => (
                  <LegalLink key={l.key} url={l.url} label={l.label} internal={l.internal} />
                ))}
              </ul>
            </nav>
          )}
        </div>
        <p className="flex flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-5">
          <span>
            {settings?.brandUrl ? (
              <OutboundLink href={settings.brandUrl} className={linkClass} icon={false}>
                {copyright}
              </OutboundLink>
            ) : (
              copyright
            )}
          </span>
          {settings?.showPoweredBy !== false && <span className="text-xs">{t('footer.poweredBy')}</span>}
        </p>
      </div>
    </footer>
  );
}

function LegalLink({ url, label, internal }: { url: string; label: string; internal: boolean }) {
  return (
    <li>
      {internal ? (
        <Link to={url} className={linkClass}>
          {label}
        </Link>
      ) : (
        <OutboundLink href={url} className={linkClass}>
          {label}
        </OutboundLink>
      )}
    </li>
  );
}

/**
 * Turns the analytics of this browser off or on again: a form posting to the
 * preference handler, which sets (or removes) the opt-out cookie and comes back
 * here, so it works without JavaScript; the page then renders without (or with)
 * the analytics script. With JavaScript the tracker of the current page is
 * stopped at once through Umami's own switch (localStorage `umami.disabled`),
 * which otherwise always mirrors the cookie.
 */
function AnalyticsChoice() {
  const { t } = useTranslation('public');
  const off = useAnalyticsOff();
  const back = useReturnPath();

  // The cookie (as the server rendered the page) is the only source of truth:
  // Umami's switch follows it, so a lost cookie or a choice made without
  // JavaScript never leaves the tracker silently off (or on) against the footer.
  useEffect(() => {
    try {
      if (off) localStorage.setItem(UMAMI_DISABLED_KEY, '1');
      else localStorage.removeItem(UMAMI_DISABLED_KEY);
    } catch {
      /* storage unavailable */
    }
  }, [off]);

  const remember = () => {
    try {
      if (off) localStorage.removeItem(UMAMI_DISABLED_KEY);
      else localStorage.setItem(UMAMI_DISABLED_KEY, '1');
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <form method="post" action={FORM_PATHS.analytics} onSubmit={remember}>
      <input type="hidden" name={RETURN_QUERY} value={back} />
      <input type="hidden" name="analytics" value={off ? 'on' : 'off'} />
      {off && <span>{t('footer.analyticsDisabled')} </span>}
      <button type="submit" className={clsx(linkClass, 'cursor-pointer text-start')}>
        {off ? t('footer.analyticsEnable') : t('footer.analyticsDisable')}
      </button>
    </form>
  );
}
