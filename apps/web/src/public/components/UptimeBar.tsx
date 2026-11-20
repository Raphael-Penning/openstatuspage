/**
 * Uptime bar made of thin day segments (oldest left, today right).
 *
 * One tab stop per bar: arrow keys / Home / End move through the days and the
 * tooltip shows date, status, uptime and non-operational minutes of that day.
 *
 * Accessibility (docs/accessibility.md):
 * - The whole bar is a single pointer target; the day follows from the pointer
 *   position, so thin segments do not have to be 24 px wide (WCAG 2.5.8).
 * - Days that were not fully operational are striped and days without data
 *   are outlined, so the bar does not rely on color alone (WCAG 1.4.1).
 * - The tooltip can be hovered, stays until the pointer or focus leaves, and
 *   Escape hides it (WCAG 1.4.13). Tapping a day shows it on touch screens.
 * - Keyboard navigation announces the selected day through a polite live
 *   region; pointer movement does not, so screen readers are not flooded.
 *
 * Days corrected afterwards carry a small marker below the segment and say so
 * (with the public notes) in the tooltip.
 *
 * Without JavaScript (and before hydration) the bar is a picture with its
 * summary as label and takes no tab stop; the day details are in the table of
 * the service page (UptimeDayTable), which needs no JavaScript.
 */
import type { DailyUptime } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { useCallback, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useHydrated } from '../../lib/ssr';
import { STATUS_BG } from '../../lib/status';
import { useDismiss, useViewportWidth } from '../hooks/dom';
import { useFormat } from '../hooks/preferences';
import { averageUptime, dayIndexAt, dayPattern, lastDays, statusMinutes, tooltipAlign } from '../utils/uptime';

interface UptimeBarProps {
  /** All buckets from the API, oldest first. */
  uptime: DailyUptime[];
  /** Number of newest days to show on wide screens. */
  days: number;
  /** Days shown below 640 px (default 30) and below 1024 px (default 60); never more than `days`. */
  phoneDays?: number;
  tabletDays?: number;
  /** Name of the service, used for the accessible label. */
  label: string;
  /** Uptime over the full API range; when omitted it is computed from the shown days. */
  percent?: number | null;
  size?: 'md' | 'lg';
  className?: string;
}

const PATTERN_CLASS = {
  solid: '',
  striped: 'uptime-issue',
  outline: 'bg-transparent ring-1 ring-status-nodata ring-inset',
} as const;

/** Media query classes per screen width: phone (< 640 px), tablet (< 1024 px), wide. */
const ONLY = { phone: 'sm:hidden', tablet: 'max-sm:hidden lg:hidden', wide: 'max-lg:hidden' } as const;
type Width = keyof typeof ONLY;

/**
 * How many days a bar shows depends on the screen width. The server cannot know
 * it, so the bar always renders the days of a wide screen and hides the older
 * ones with media queries (no JavaScript, nothing moves on hydration); the
 * pointer and keyboard handling use the days the screen shows.
 */
export function UptimeBar({ uptime, days, phoneDays = 30, tabletDays = 60, label, percent, size = 'md', className }: UptimeBarProps) {
  const { t } = useTranslation('public');
  const f = useFormat();
  const shown = lastDays(uptime, days);
  const [active, setActive] = useState<number | null>(null);
  /** Hidden with Escape: stays hidden until the pointer leaves or the visitor picks another day. */
  const [dismissed, setDismissed] = useState(false);
  /** Text for the live region; only set by keyboard navigation. */
  const [announcement, setAnnouncement] = useState('');
  const tooltipId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const hydrated = useHydrated();
  const viewport = useViewportWidth();

  const counts: Record<Width, number> = {
    phone: Math.min(phoneDays, shown.length),
    tablet: Math.min(tabletDays, shown.length),
    wide: shown.length,
  };
  /** Width class of the current screen (the wide layout until hydration, like the server). */
  const current: Width = !hydrated ? 'wide' : viewport < 640 ? 'phone' : viewport < 1024 ? 'tablet' : 'wide';
  const visibleCount = counts[current];
  /** Index of the oldest day the screen shows. */
  const first = shown.length - visibleCount;

  const averageText = (count: number) => {
    const avg = percent !== undefined && count === uptime.length ? percent : averageUptime(shown.slice(shown.length - count));
    return avg === null ? t('uptime.noData') : t('uptime.percent', { value: f.percent(avg) });
  };
  const avgText = averageText(visibleCount);
  const correctedCount = shown.slice(first).filter((d) => d.corrected).length;
  const anyCorrected = shown.some((d) => d.corrected);

  const hide = useCallback(() => {
    setActive(null);
    setDismissed(false);
  }, []);
  const dismiss = useCallback(() => setDismissed(true), []);
  // Escape anywhere and clicks / taps outside the bar hide the tooltip.
  useDismiss(active !== null && !dismissed, wrapperRef, dismiss);

  if (shown.length === 0) return null;
  const visible = active !== null && !dismissed && active >= first ? shown[active] : undefined;

  function describe(day: DailyUptime): string {
    const parts = [f.utcDay(day.date)];
    if (day.status === null) parts.push(t('uptime.noData'));
    else {
      parts.push(t(`common:status.${day.status}`));
      if (day.uptime !== null) parts.push(t('uptime.percent', { value: f.percent(day.uptime) }));
      for (const m of statusMinutes(day)) parts.push(`${t(`common:status.${m.status}`)}: ${f.duration(m.minutes * 60_000)}`);
    }
    if (day.corrected) parts.push(t('uptime.corrected'), ...(day.correctionNotes ?? []));
    return parts.join(', ');
  }

  function select(index: number, announce: boolean) {
    setActive(index);
    setDismissed(false);
    if (announce) setAnnouncement(describe(shown[index]!));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const last = shown.length - 1;
    const current = active !== null && active >= first ? active : last;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = Math.max(first, current - 1);
    else if (e.key === 'ArrowRight') next = Math.min(last, current + 1);
    else if (e.key === 'Home') next = first;
    else if (e.key === 'End') next = last;
    if (next !== null) {
      e.preventDefault();
      select(next, true);
    }
  }

  function indexAt(e: { clientX: number; currentTarget: HTMLElement }): number {
    const rect = e.currentTarget.getBoundingClientRect();
    return first + dayIndexAt(e.clientX - rect.left, rect.width, visibleCount);
  }

  const align = active !== null ? tooltipAlign(active - first, visibleCount) : 'center';
  const left = active !== null ? ((active - first + 0.5) / visibleCount) * 100 : 50;
  /** A text per screen width; only the one for the current width is displayed. */
  const perWidth = (text: (count: number) => string) =>
    (Object.keys(ONLY) as Width[]).map((w) => (
      <span key={w} className={ONLY[w]}>
        {text(counts[w])}
      </span>
    ));

  return (
    <div
      ref={wrapperRef}
      className={clsx('relative', className)}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') hide();
      }}
    >
      <div
        tabIndex={hydrated ? 0 : undefined}
        role="group"
        aria-roledescription={t('uptime.roleDescription')}
        aria-label={
          t(hydrated ? 'uptime.ariaLabel' : 'uptime.ariaLabelStatic', { name: label, days: visibleCount, uptime: avgText }) +
          (correctedCount > 0 ? ` ${t('uptime.correctedCount', { count: correctedCount })}` : '')
        }
        aria-describedby={visible ? tooltipId : undefined}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((a) => (a !== null && a >= first ? a : shown.length - 1))}
        onBlur={(e) => {
          if (!wrapperRef.current?.contains(e.relatedTarget as Node | null)) hide();
        }}
        onPointerMove={(e) => {
          if (e.pointerType !== 'mouse') return;
          const index = indexAt(e);
          if (index !== active && !dismissed) select(index, false);
        }}
        onClick={(e) => select(indexAt(e), false)}
        className={clsx(
          'osp-bar flex w-full cursor-default items-stretch gap-px rounded-md outline-offset-4 focus-visible:outline-2 focus-visible:outline-focus sm:gap-[2px]',
          size === 'lg' ? 'h-12' : 'h-8',
        )}
      >
        {shown.map((d, i) => {
          const age = shown.length - 1 - i;
          return (
            // Layout of the segments: .osp-bar in styles.css (up to 90 per bar, every class counts).
            <div
              key={d.date}
              className={clsx(
                age >= counts.phone && 'max-sm:hidden',
                age >= counts.tablet && 'max-lg:hidden',
                d.status ? STATUS_BG[d.status] : undefined,
                PATTERN_CLASS[dayPattern(d.status)],
                visible && active !== i && 'opacity-60',
              )}
            >
              {d.corrected && <span aria-hidden className="absolute inset-x-0 -bottom-1.5 h-[3px] rounded-full bg-fg" />}
            </div>
          );
        })}
      </div>

      {visible && (
        // The padding (not a margin) bridges the gap to the bar, so the pointer
        // can move onto the tooltip without it disappearing. The content is
        // announced through aria-describedby and the live region below.
        <div
          id={tooltipId}
          aria-hidden
          className={clsx(
            'absolute bottom-full z-20 w-max max-w-64 min-w-44 pb-2',
            align === 'center' && '-translate-x-1/2',
            align === 'end' && '-translate-x-full',
          )}
          style={{ left: align === 'start' ? 0 : align === 'end' ? '100%' : `${left}%` }}
        >
          <div className="rounded-xl border border-border bg-surface px-3 py-2 text-xs shadow-lg">
            <DayDetails day={visible} />
          </div>
        </div>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic>
        {announcement}
      </p>

      <div className={clsx('flex items-center justify-between gap-2 text-xs text-muted', anyCorrected ? 'mt-3' : 'mt-1.5')} aria-hidden>
        <span>{perWidth((count) => t('uptime.daysAgo', { count }))}</span>
        <span className="h-px flex-1 bg-border" />
        <span className="font-medium text-fg">{perWidth(averageText)}</span>
        <span className="h-px flex-1 bg-border" />
        <span>{t('uptime.today')}</span>
      </div>
      {anyCorrected && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted" aria-hidden>
          <span className="inline-block h-[3px] w-3 rounded-full bg-fg" />
          {t('uptime.correctedLegend')}
        </p>
      )}
    </div>
  );
}

function DayDetails({ day }: { day: DailyUptime }) {
  const { t } = useTranslation('public');
  const f = useFormat();
  const minutes = statusMinutes(day);
  return (
    <div aria-live="polite">
      <p className="font-semibold">{f.utcDay(day.date)}</p>
      {day.status === null ? (
        <p className="mt-1 text-muted">{t('uptime.noData')}</p>
      ) : (
        <>
          <p className="mt-1 flex items-center gap-1.5">
            <span aria-hidden className={clsx('size-2 shrink-0 rounded-full', STATUS_BG[day.status])} />
            {t(`common:status.${day.status}`)}
          </p>
          {day.uptime !== null && (
            <p className="text-muted">{t('uptime.percent', { value: f.percent(day.uptime) })}</p>
          )}
          {minutes.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-muted">
              {minutes.map((m) => (
                <li key={m.status}>
                  {t(`common:status.${m.status}`)}: {f.duration(m.minutes * 60_000)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-muted">{t('uptime.noDowntime')}</p>
          )}
        </>
      )}
      {day.corrected && (
        <div className="mt-1.5 border-t border-border pt-1.5">
          <p className="font-medium">{t('uptime.corrected')}</p>
          {day.correctionNotes?.map((note) => (
            <p key={note} className="text-muted">
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Every day of an uptime bar as a table, newest first, in a disclosure: what
 * the bar's tooltip shows, without JavaScript and without a pointer. Cell
 * styles are in styles.css (.osp-days), so up to a year of rows stays small.
 */
export function UptimeDayTable({ uptime, label }: { uptime: DailyUptime[]; label: string }) {
  const { t } = useTranslation('public');
  const f = useFormat();
  if (uptime.length === 0) return null;
  const days = [...uptime].reverse();
  return (
    <details className="mt-4">
      <summary className="inline-flex cursor-pointer items-center gap-1.5 rounded text-sm font-medium text-[color:var(--osp-accent-text,var(--accent))] hover:underline">
        {t('uptime.dailyDetails')}
      </summary>
      <div className="mt-3 overflow-x-auto rounded-xl border border-border">
        <table className="osp-days w-full text-sm">
          <caption className="sr-only">{t('uptime.dailyCaption', { name: label, count: days.length })}</caption>
          <thead className="bg-surface-2 text-xs text-muted">
            <tr>
              <th scope="col">{t('uptime.day')}</th>
              <th scope="col">{t('uptime.status')}</th>
              <th scope="col">{t('service.uptime')}</th>
              <th scope="col">{t('uptime.notOperational')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {days.map((day) => {
              const minutes = statusMinutes(day);
              const notes = day.corrected ? [t('uptime.corrected'), ...(day.correctionNotes ?? [])].join(': ') : null;
              return (
                <tr key={day.date}>
                  <th scope="row">{f.utcDay(day.date)}</th>
                  <td>
                    {day.status === null ? (
                      t('uptime.noData')
                    ) : (
                      <>
                        <i aria-hidden className={STATUS_BG[day.status]} />
                        {t(`common:status.${day.status}`)}
                      </>
                    )}
                  </td>
                  <td>{day.uptime === null ? '–' : f.percent(day.uptime)}</td>
                  <td>
                    {minutes.length === 0
                      ? '–'
                      : minutes.map((m) => `${t(`common:status.${m.status}`)}: ${f.duration(m.minutes * 60_000)}`).join(', ')}
                    {notes && <span>{notes}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
