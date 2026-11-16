/**
 * Uptime bar made of thin day segments (oldest left, today right).
 *
 * One tab stop per bar: arrow keys / Home / End move through the days and the
 * tooltip shows date, status, uptime and non-operational minutes of that day.
 */
import type { DailyUptime } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { STATUS_BG } from '../../lib/status';
import { useFormat } from '../hooks/preferences';
import { formatUtcDay } from '../utils/time';
import { averageUptime, formatPercent, lastDays, statusMinutes, tooltipAlign } from '../utils/uptime';

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

export function UptimeBar({ uptime, days, label, percent, size = 'md', className }: UptimeBarProps) {
  const { t } = useTranslation('public');
  const f = useFormat();
  const shown = lastDays(uptime, days);
  const [active, setActive] = useState<number | null>(null);
  const tooltipId = useId();
  const avg = percent !== undefined && shown.length === uptime.length ? percent : averageUptime(shown);
  const avgText = avg === null ? t('uptime.noData') : t('uptime.percent', { value: formatPercent(avg, f.locale) });

  if (shown.length === 0) return null;
  const activeDay = active !== null ? shown[active] : undefined;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const last = shown.length - 1;
    const current = active ?? last;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = Math.max(0, current - 1);
    else if (e.key === 'ArrowRight') next = Math.min(last, current + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Escape') {
      setActive(null);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  }

  const align = active !== null ? tooltipAlign(active, shown.length) : 'center';
  const left = active !== null ? ((active + 0.5) / shown.length) * 100 : 50;

  return (
    <div className={clsx('relative', className)}>
      <div
        tabIndex={0}
        role="group"
        aria-roledescription={t('uptime.roleDescription')}
        aria-label={t('uptime.ariaLabel', { name: label, days: shown.length, uptime: avgText })}
        aria-describedby={activeDay ? tooltipId : undefined}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((a) => a ?? shown.length - 1)}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
        className={clsx(
          'flex w-full items-stretch gap-px rounded-md outline-offset-4 focus-visible:outline-2 focus-visible:outline-accent sm:gap-[2px]',
          size === 'lg' ? 'h-12' : 'h-8',
        )}
      >
        {shown.map((d, i) => (
          <div
            key={d.date}
            onMouseEnter={() => setActive(i)}
            onClick={() => setActive(i)}
            className={clsx(
              'min-w-0 flex-1 rounded-[2px] motion-safe:transition-opacity',
              d.status ? STATUS_BG[d.status] : 'bg-status-nodata',
              active !== null && active !== i && 'opacity-60',
            )}
          />
        ))}
      </div>

      {activeDay && (
        <div
          id={tooltipId}
          role="tooltip"
          className={clsx(
            'pointer-events-none absolute bottom-full z-20 mb-2 w-max max-w-64 min-w-44 rounded-xl border border-border bg-surface px-3 py-2 text-xs shadow-lg',
            align === 'center' && '-translate-x-1/2',
            align === 'end' && '-translate-x-full',
          )}
          style={{ left: align === 'start' ? 0 : align === 'end' ? '100%' : `${left}%` }}
        >
          <DayDetails day={activeDay} />
        </div>
      )}

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
