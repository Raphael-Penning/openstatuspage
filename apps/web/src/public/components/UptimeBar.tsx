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
 */
import type { DailyUptime } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { useCallback, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { STATUS_BG } from '../../lib/status';
import { useDismiss } from '../hooks/dom';
import { useFormat } from '../hooks/preferences';
import { formatUtcDay } from '../utils/time';
import { averageUptime, dayIndexAt, dayPattern, formatPercent, lastDays, statusMinutes, tooltipAlign } from '../utils/uptime';

interface UptimeBarProps {
  /** All buckets from the API, oldest first. */
  uptime: DailyUptime[];
  /** Number of newest days to show. */
  days: number;
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

export function UptimeBar({ uptime, days, label, percent, size = 'md', className }: UptimeBarProps) {
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
  const avg = percent !== undefined && shown.length === uptime.length ? percent : averageUptime(shown);
  const avgText = avg === null ? t('uptime.noData') : t('uptime.percent', { value: formatPercent(avg, f.locale) });

  const hide = useCallback(() => {
    setActive(null);
    setDismissed(false);
  }, []);
  const dismiss = useCallback(() => setDismissed(true), []);
  // Escape anywhere and clicks / taps outside the bar hide the tooltip.
  useDismiss(active !== null && !dismissed, wrapperRef, dismiss);

  if (shown.length === 0) return null;
  const visible = active !== null && !dismissed ? shown[active] : undefined;

  function describe(day: DailyUptime): string {
    const parts = [formatUtcDay(day.date, f.locale)];
    if (day.status === null) parts.push(t('uptime.noData'));
    else {
      parts.push(t(`common:status.${day.status}`));
      if (day.uptime !== null) parts.push(t('uptime.percent', { value: formatPercent(day.uptime, f.locale) }));
      for (const m of statusMinutes(day)) parts.push(`${t(`common:status.${m.status}`)}: ${f.duration(m.minutes * 60_000)}`);
    }
    return parts.join(', ');
  }

  function select(index: number, announce: boolean) {
    setActive(index);
    setDismissed(false);
    if (announce) setAnnouncement(describe(shown[index]!));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const last = shown.length - 1;
    const current = active ?? last;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = Math.max(0, current - 1);
    else if (e.key === 'ArrowRight') next = Math.min(last, current + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next !== null) {
      e.preventDefault();
      select(next, true);
    }
  }

  function indexAt(e: { clientX: number; currentTarget: HTMLElement }): number {
    const rect = e.currentTarget.getBoundingClientRect();
    return dayIndexAt(e.clientX - rect.left, rect.width, shown.length);
  }

  const align = active !== null ? tooltipAlign(active, shown.length) : 'center';
  const left = active !== null ? ((active + 0.5) / shown.length) * 100 : 50;

  return (
    <div
      ref={wrapperRef}
      className={clsx('relative', className)}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') hide();
      }}
    >
      <div
        tabIndex={0}
        role="group"
        aria-roledescription={t('uptime.roleDescription')}
        aria-label={t('uptime.ariaLabel', { name: label, days: shown.length, uptime: avgText })}
        aria-describedby={visible ? tooltipId : undefined}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((a) => a ?? shown.length - 1)}
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
          'flex w-full cursor-default items-stretch gap-px rounded-md outline-offset-4 focus-visible:outline-2 focus-visible:outline-focus sm:gap-[2px]',
          size === 'lg' ? 'h-12' : 'h-8',
        )}
      >
        {shown.map((d, i) => (
          <div
            key={d.date}
            className={clsx(
              'min-w-0 flex-1 rounded-[2px] motion-safe:transition-opacity',
              d.status ? STATUS_BG[d.status] : undefined,
              PATTERN_CLASS[dayPattern(d.status)],
              visible && active !== i && 'opacity-60',
            )}
          />
        ))}
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

      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted" aria-hidden>
        <span>{t('uptime.daysAgo', { count: shown.length })}</span>
        <span className="h-px flex-1 bg-border" />
        <span className="font-medium text-fg">{avgText}</span>
        <span className="h-px flex-1 bg-border" />
        <span>{t('uptime.today')}</span>
      </div>
    </div>
  );
}

function DayDetails({ day }: { day: DailyUptime }) {
  const { t } = useTranslation('public');
  const f = useFormat();
  const minutes = statusMinutes(day);
  return (
    <div aria-live="polite">
      <p className="font-semibold">{formatUtcDay(day.date, f.locale)}</p>
      {day.status === null ? (
        <p className="mt-1 text-muted">{t('uptime.noData')}</p>
      ) : (
        <>
          <p className="mt-1 flex items-center gap-1.5">
            <span aria-hidden className={clsx('size-2 shrink-0 rounded-full', STATUS_BG[day.status])} />
            {t(`common:status.${day.status}`)}
          </p>
          {day.uptime !== null && (
            <p className="text-muted">{t('uptime.percent', { value: formatPercent(day.uptime, f.locale) })}</p>
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
    </div>
  );
}
