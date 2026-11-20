/**
 * Header controls: time zone toggle, language switcher, theme switcher and
 * the subscribe menu (email, feeds, status API).
 *
 * They work without JavaScript (docs/accessibility.md): the language switcher
 * is a disclosure with one link per language (a form on personal pages), the theme switcher a form that
 * sets the theme cookie, the subscribe menu a disclosure of links. With
 * JavaScript the same markup switches in place without a page load.
 */
import { FORM_PATHS, isPersonalPath, LANG_COOKIE, LANG_QUERY, RETURN_QUERY } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { Braces, ChevronDown, Clock, Globe, Mail, Monitor, Moon, Rss, Sun } from 'lucide-react';
import { useCallback, useRef, useState, type MouseEvent, type ReactNode, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useSearchParams } from 'react-router';
import { LANGUAGES, writePreferenceCookie } from '../../lib/languages';
import { useHydrated } from '../../lib/ssr';
import { useTheme, type ThemePreference } from '../../lib/theme';
import { useDismiss } from '../hooks/dom';
import { usePreferences } from '../hooks/preferences';

/** Remembers that the visitor picked a language, so the page default no longer applies. */
export const LANG_CHOSEN_KEY = 'osp-lang-chosen';

const control =
  'inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-focus';

const menuItem =
  'flex items-center gap-2 px-4 py-2 text-sm hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';

/** <summary> without the browser's disclosure triangle. */
const summaryReset = 'cursor-pointer list-none [&::-webkit-details-marker]:hidden';

/** The current page as a local path to come back to, without ?lang= (the choice replaces it). */
export function useReturnPath(): string {
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  params.delete(LANG_QUERY);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * A <details> disclosure (works without JavaScript) that also closes on Escape,
 * with the focus back on its summary, on a click outside and when one of its
 * links is used.
 */
export function Disclosure({
  className,
  summary,
  summaryClassName,
  children,
}: {
  className?: string;
  summary: ReactNode;
  summaryClassName: string;
  children: (close: () => void) => ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    const details = ref.current;
    if (!details?.open) return;
    details.open = false;
    setOpen(false);
    if (details.contains(document.activeElement)) details.querySelector('summary')?.focus();
  }, []);
  useDismiss(open, ref, close);
  return (
    <details
      ref={ref}
      className={clsx('relative', className)}
      onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => setOpen(e.currentTarget.open)}
    >
      <summary className={clsx(summaryReset, summaryClassName)}>{summary}</summary>
      {children(close)}
    </details>
  );
}

/**
 * Before hydration (and without JavaScript) times are in UTC and cannot be
 * switched: a label. Afterwards a toggle between UTC and the visitor's time
 * zone. Both labels reserve the width of the longer one, so nothing moves.
 */
export function TimeZoneToggle() {
  const { t } = useTranslation('public');
  const { timeZone, setTimeZone } = usePreferences();
  const hydrated = useHydrated();
  const current = timeZone === 'utc' ? t('common:time.utc') : t('common:time.local');
  const other = timeZone === 'utc' ? t('common:time.local') : t('common:time.utc');
  const label = (
    <span className="grid max-sm:sr-only">
      <span className="col-start-1 row-start-1">{current}</span>
      <span aria-hidden className="invisible col-start-1 row-start-1">
        {other}
      </span>
    </span>
  );
  if (!hydrated) {
    return (
      <span className={clsx(control, 'hover:border-border')} title={t('header.timeZoneUtc')}>
        <Clock aria-hidden className="size-4 text-muted" />
        <span className="sr-only">{t('header.timeZoneUtc')}</span>
        <span aria-hidden>{label}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setTimeZone(timeZone === 'utc' ? 'local' : 'utc')}
      aria-label={t('header.timeZone', { current })}
      title={t('header.timeZone', { current })}
      className={control}
    >
      <Clock aria-hidden className="size-4 text-muted" />
      {label}
    </button>
  );
}

/**
 * One link per language (/preferences/language sets the cookie and comes back
 * here). With JavaScript the page switches in place.
 *
 * Personal pages (subscription links) carry their token in the URL: there the
 * choices are buttons of a form that posts the way back, so the token never
 * ends up in a URL of its own (server logs, proxies, browser history).
 */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation('public');
  const back = useReturnPath();
  const personal = isPersonalPath(useLocation().pathname);
  const [params, setParams] = useSearchParams();
  const current = i18n.resolvedLanguage ?? 'en';
  const currentLabel = LANGUAGES.find((l) => l.code === current)?.label ?? current;

  const choose = (e: MouseEvent<HTMLElement>, code: string, close: () => void) => {
    e.preventDefault();
    try {
      localStorage.setItem(LANG_CHOSEN_KEY, '1');
    } catch {
      /* storage unavailable */
    }
    // Server-rendered pages read the choice from the cookie.
    writePreferenceCookie(LANG_COOKIE, code);
    // ?lang= would win over the choice on the next load: the URL becomes the plain page.
    if (params.has(LANG_QUERY)) {
      const next = new URLSearchParams(params);
      next.delete(LANG_QUERY);
      setParams(next, { replace: true, preventScrollReset: true });
    }
    void i18n.changeLanguage(code);
    close();
  };

  return (
    <Disclosure
      summaryClassName={clsx(control, 'border-border-strong')}
      summary={
        <>
          <Globe aria-hidden className="size-4 text-muted" />
          <span className="sr-only">{t('header.language')}: </span>
          <span lang={current}>{currentLabel}</span>
          <ChevronDown aria-hidden className="size-3.5 text-muted" />
        </>
      }
    >
      {(close) => {
        const list = (
          <ul className="absolute right-0 z-30 mt-2 w-40 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-lg">
            {LANGUAGES.map((l) => (
              <li key={l.code}>
                {personal ? (
                  <button
                    type="submit"
                    name="lang"
                    value={l.code}
                    lang={l.code}
                    aria-current={l.code === current ? 'true' : undefined}
                    onClick={(e) => choose(e, l.code, close)}
                    className={clsx(menuItem, 'w-full text-start', l.code === current && 'font-semibold')}
                  >
                    {l.label}
                  </button>
                ) : (
                  <a
                    href={`${FORM_PATHS.language}?lang=${l.code}&${RETURN_QUERY}=${encodeURIComponent(back)}`}
                    // Language names are shown in their own language (WCAG 3.1.2).
                    lang={l.code}
                    hrefLang={l.code}
                    rel="nofollow"
                    aria-current={l.code === current ? 'true' : undefined}
                    onClick={(e) => choose(e, l.code, close)}
                    className={clsx(menuItem, l.code === current && 'font-semibold')}
                  >
                    {l.label}
                  </a>
                )}
              </li>
            ))}
          </ul>
        );
        if (!personal) return list;
        return (
          <form method="post" action={FORM_PATHS.language}>
            <input type="hidden" name={RETURN_QUERY} value={back} />
            {list}
          </form>
        );
      }}
    </Disclosure>
  );
}

const THEMES: { value: ThemePreference; Icon: typeof Sun }[] = [
  { value: 'system', Icon: Monitor },
  { value: 'light', Icon: Sun },
  { value: 'dark', Icon: Moon },
];

/** A form posting the theme (it sets the cookie); with JavaScript it switches in place. */
export function ThemeSwitcher() {
  const { t } = useTranslation('public');
  const { preference, setPreference } = useTheme();
  const back = useReturnPath();
  return (
    <form method="post" action={FORM_PATHS.theme} className="inline-flex">
      <input type="hidden" name={RETURN_QUERY} value={back} />
      <div role="group" aria-label={t('header.theme')} className="inline-flex min-h-9 items-center rounded-full border border-border bg-surface p-0.5">
      {THEMES.map(({ value, Icon }) => (
        <button
          key={value}
          type="submit"
          name="theme"
          value={value}
          aria-pressed={preference === value}
          aria-label={t(`common:theme.${value}`)}
          title={t(`common:theme.${value}`)}
          onClick={(e) => {
            e.preventDefault();
            setPreference(value);
          }}
          className={clsx(
            'grid size-8 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-focus',
            preference === value ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg',
          )}
        >
          <Icon aria-hidden className="size-4" />
        </button>
      ))}
      </div>
    </form>
  );
}

/**
 * Accent button opening a small menu with email notifications (when offered),
 * the RSS/Atom feeds and the status API: a disclosure of links.
 */
export function FeedMenu({ email = false }: { email?: boolean }) {
  const { t } = useTranslation('public');
  const items = [
    { href: '/feed.rss', label: t('feeds.rss'), Icon: Rss },
    { href: '/feed.atom', label: t('feeds.atom'), Icon: Rss },
    { href: '/api/public/status', label: t('feeds.json'), Icon: Braces },
  ];

  return (
    <Disclosure
      className="inline-block [&[open]_.feed-chevron]:rotate-180"
      summaryClassName="inline-flex items-center gap-2 rounded-full bg-[color:var(--osp-accent-solid,var(--accent))] px-5 py-2 text-sm font-medium text-[color:var(--osp-accent-solid-fg,var(--accent-fg))] shadow-sm hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      summary={
        <>
          <Rss aria-hidden className="size-4" />
          {t('feeds.subscribe')}
          <ChevronDown aria-hidden className="feed-chevron size-4 motion-safe:transition-transform" />
        </>
      }
    >
      {(close) => (
        <ul className="absolute left-1/2 z-30 mt-2 w-60 -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface py-1 text-left shadow-lg">
          {email && (
            <li>
              <Link to="/subscribe" className={menuItem} onClick={close}>
                <Mail aria-hidden className="size-4 text-muted" />
                {t('feeds.email')}
              </Link>
            </li>
          )}
          {items.map(({ href, label, Icon }) => (
            <li key={href}>
              <a href={href} className={menuItem} onClick={close}>
                <Icon aria-hidden className="size-4 text-muted" />
                {label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Disclosure>
  );
}
