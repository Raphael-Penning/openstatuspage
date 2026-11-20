/**
 * Shared shell of all public pages: header with branding and visitor
 * preferences, pill navigation, content outlet and footer.
 */
import type { PublicPageSettings } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { Activity, Earth, LayoutDashboard, RotateCcwClock, Server } from 'lucide-react';
import { useEffect, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, ScrollRestoration, useLocation } from 'react-router';
import { LANGUAGES } from '../lib/languages';
import { useSsr } from '../lib/ssr';
import { ThemeProvider, useAccentColor, useTheme } from '../lib/theme';
import { LANG_CHOSEN_KEY, LanguageSwitcher, ThemeSwitcher, TimeZoneToggle } from './components/Controls';
import { Skeleton } from './components/ui';
import { PreferencesProvider, usePreferences } from './hooks/preferences';
import { usePublicSettings } from './hooks/queries';
import { readableOnAll, solidAccent } from './utils/color';

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
  const { resolved } = useTheme();
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const reapply = () => window.setTimeout(() => (document.documentElement.dataset.theme = resolved), 0);
    mq.addEventListener('change', reapply);
    return () => mq.removeEventListener('change', reapply);
  }, [resolved]);
  return null;
}

/** Accent color, favicon, document language and the page default language. */
function PageEffects({ settings }: { settings: PublicPageSettings | undefined }) {
  const { i18n } = useTranslation();
  const ssr = useSsr();
  const { resolved } = useTheme();
  useAccentColor(settings?.accentColor);

  // Contrast-safe accent variants for text and solid buttons (any accent can be configured).
  useEffect(() => {
    const accent = settings?.accentColor;
    if (!accent) return;
    const root = document.documentElement;
    // Accent text and focus rings appear on the page, card and inset backgrounds: readable on all of them.
    const style = getComputedStyle(root);
    const backgrounds = ['--bg', '--surface', '--surface-2']
      .map((name) => style.getPropertyValue(name).trim())
      .filter((v) => v !== '');
    const solid = solidAccent(accent);
    root.style.setProperty('--osp-accent-text', readableOnAll(accent, backgrounds.length > 0 ? backgrounds : ['#ffffff']));
    root.style.setProperty('--osp-accent-solid', solid.background);
    root.style.setProperty('--osp-accent-solid-fg', solid.foreground);
  }, [settings?.accentColor, resolved]);

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

function Shell({ settings }: { settings: PublicPageSettings | undefined }) {
  const { t } = useTranslation('public');
  const mainRef = useRef<HTMLElement>(null);
  useFocusOnNavigation(mainRef);
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      {/* React 19 hoists these into <head>. */}
      <link rel="alternate" type="application/rss+xml" title={t('feeds.rss')} href="/feed.rss" />
      <link rel="alternate" type="application/atom+xml" title={t('feeds.atom')} href="/feed.atom" />

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-[color:var(--osp-accent-solid,var(--accent))] focus:px-4 focus:py-2 focus:text-[color:var(--osp-accent-solid-fg,var(--accent-fg))]"
      >
        {t('skipToContent')}
      </a>

      <Header settings={settings} />
      <NavTabs showLocations={settings?.showLocations !== false} />

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

function Header({ settings }: { settings: PublicPageSettings | undefined }) {
  const { t } = useTranslation('public');
  const { isError } = usePublicSettings();
  return (
    <header className="mx-auto flex w-full max-w-[1100px] flex-wrap items-center justify-between gap-3 px-4 pt-5 sm:px-6">
      <Link to="/" className="flex min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-focus">
        {settings?.logoUrl ? (
          <img src={settings.logoUrl} alt="" className="h-8 w-auto max-w-32 object-contain" />
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
        <span className="sr-only">{t('header.home')}</span>
      </Link>
      <div className="flex items-center gap-2">
        <TimeZoneToggle />
        <LanguageSwitcher />
        <ThemeSwitcher />
      </div>
    </header>
  );
}

function NavTabs({ showLocations }: { showLocations: boolean }) {
  const { t } = useTranslation('public');
  const { pathname } = useLocation();
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
        </ul>
      </div>
    </nav>
  );
}

function Footer({ settings }: { settings: PublicPageSettings | undefined }) {
  const { t } = useTranslation('public');
  // The shared clock: the server's render time until hydration (no mismatch at New Year).
  const year = new Date(usePreferences().now).getUTCFullYear();
  const linkClass = 'hover:text-fg hover:underline';
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <nav aria-label={t('footer.label')}>
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
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
            {settings?.supportUrl && (
              <li>
                <a href={settings.supportUrl} className={linkClass} rel="noopener noreferrer" target="_blank">
                  {t('footer.support')}
                </a>
              </li>
            )}
            {settings?.footerLinks.map((l) => (
              <li key={`${l.label}-${l.url}`}>
                <a href={l.url} className={linkClass} rel="noopener noreferrer" target="_blank">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <p className="flex flex-col gap-0.5 sm:items-end">
          <span>{t('footer.copyright', { year, name: settings?.siteName ?? t('fallbackSiteName') })}</span>
          <span className="text-xs">{t('footer.poweredBy')}</span>
        </p>
      </div>
    </footer>
  );
}
