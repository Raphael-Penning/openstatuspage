/**
 * Header controls: time zone toggle, language switcher, theme switcher and
 * the feeds menu.
 */
import { clsx } from 'clsx';
import { Braces, ChevronDown, Clock, Globe, Monitor, Moon, Rss, Sun } from 'lucide-react';
import { useCallback, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES } from '../../lib/i18n';
import { useTheme, type ThemePreference } from '../../lib/theme';
import { useDismiss } from '../hooks/dom';
import { usePreferences } from '../hooks/preferences';

/** Remembers that the visitor picked a language, so the page default no longer applies. */
export const LANG_CHOSEN_KEY = 'osp-lang-chosen';

const control =
  'inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-accent';

export function TimeZoneToggle() {
  const { t } = useTranslation('public');
  const { timeZone, setTimeZone } = usePreferences();
  const current = timeZone === 'utc' ? t('common:time.utc') : t('common:time.local');
  return (
    <button
      type="button"
      onClick={() => setTimeZone(timeZone === 'utc' ? 'local' : 'utc')}
      aria-label={t('header.timeZone', { current })}
      title={t('header.timeZone', { current })}
      className={control}
    >
      <Clock aria-hidden className="size-4 text-muted" />
      <span className="max-sm:sr-only">{current}</span>
    </button>
  );
}

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation('public');
  const id = useId();
  const current = i18n.resolvedLanguage ?? 'en';
  return (
    <div className={clsx(control, 'relative pr-2')}>
      <Globe aria-hidden className="size-4 text-muted" />
      <label htmlFor={id} className="sr-only">
        {t('header.language')}
      </label>
      <select
        id={id}
        value={current}
        onChange={(e) => {
          try {
            localStorage.setItem(LANG_CHOSEN_KEY, '1');
          } catch {
            /* storage unavailable */
          }
          void i18n.changeLanguage(e.target.value);
        }}
        className="cursor-pointer appearance-none bg-transparent pr-4 text-sm focus:outline-none"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} className="bg-surface text-fg">
            {l.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2 size-3.5 text-muted" />
    </div>
  );
}

const THEMES: { value: ThemePreference; Icon: typeof Sun }[] = [
  { value: 'system', Icon: Monitor },
  { value: 'light', Icon: Sun },
  { value: 'dark', Icon: Moon },
];

export function ThemeSwitcher() {
  const { t } = useTranslation('public');
  const { preference, setPreference } = useTheme();
  return (
    <div role="group" aria-label={t('header.theme')} className="inline-flex h-9 items-center rounded-full border border-border bg-surface p-0.5">
      {THEMES.map(({ value, Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={preference === value}
          aria-label={t(`common:theme.${value}`)}
          title={t(`common:theme.${value}`)}
          onClick={() => setPreference(value)}
          className={clsx(
            'grid size-8 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-accent',
            preference === value ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg',
          )}
        >
          <Icon aria-hidden className="size-4" />
        </button>
      ))}
    </div>
  );
}

/** Accent button opening a small menu with the RSS/Atom feeds and the status API. */
export function FeedMenu() {
  const { t } = useTranslation('public');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);

  const items = [
    { href: '/feed.rss', label: t('feeds.rss'), Icon: Rss },
    { href: '/feed.atom', label: t('feeds.atom'), Icon: Rss },
    { href: '/api/public/status.json', label: t('feeds.json'), Icon: Braces },
  ];

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-full bg-[color:var(--osp-accent-solid,var(--accent))] px-5 py-2 text-sm font-medium text-[color:var(--osp-accent-solid-fg,var(--accent-fg))] shadow-sm hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <Rss aria-hidden className="size-4" />
        {t('feeds.subscribe')}
        <ChevronDown aria-hidden className={clsx('size-4 motion-safe:transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul
          id={menuId}
          className="absolute left-1/2 z-30 mt-2 w-60 -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface py-1 text-left shadow-lg"
        >
          {items.map(({ href, label, Icon }) => (
            <li key={href}>
              <a
                href={href}
                className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                onClick={close}
              >
                <Icon aria-hidden className="size-4 text-muted" />
                {label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
