/**
 * One day of a service's uptime bar in detail (/services/:slug/days/:date):
 * status and uptime of the day, its status periods, corrections with their
 * public notes, the incidents and maintenance windows of that day, and links
 * to the neighbouring days. Server-rendered and complete without JavaScript.
 *
 * Days are UTC days, like the buckets of the bar (utils/uptime.ts and the
 * server's services/uptime.ts). Not indexed (thin, many pages), links followed.
 * Links are built below the current link base (hooks/links.tsx), so the page
 * also works below a prefix such as a secret page.
 */
import { isUptimeDay, type ServiceDaySegment } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { ArrowLeft, ChevronLeft, ChevronRight, CircleCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { STATUS_BG } from '../../lib/status';
import { IncidentSummary, MaintenanceSummary } from '../components/Events';
import { TimeRange } from '../components/Time';
import { Badge, Card, EmptyState, ErrorState, Skeleton, SkeletonList } from '../components/ui';
import { usePageHead, useSiteName, VARIANT_HEAD } from '../head';
import { useServicePaths } from '../hooks/links';
import { useFormat } from '../hooks/preferences';
import { isNotFound, useServiceDay } from '../hooks/queries';
import { dayPattern, statusMinutes } from '../utils/uptime';
import { NotFoundState } from './NotFoundState';

const DAY_MS = 86_400_000;

const PATTERN_CLASS = {
  solid: '',
  striped: 'uptime-issue',
  outline: 'bg-transparent ring-1 ring-status-nodata ring-inset',
} as const;

export function ServiceDayPage() {
  const { slug = '', date = '' } = useParams();
  const valid = isUptimeDay(date);
  const { t } = useTranslation('public');
  const f = useFormat();
  const site = useSiteName();
  const paths = useServicePaths();
  const { data, isPending, isError, error, refetch } = useServiceDay(slug, date, valid);
  const name = data?.service.name;
  usePageHead({
    title: name ? t('day.title', { name, date: f.utcDay(date) }) : t('day.timeline'),
    description: name ? t('seo.day', { name, date: f.utcDay(date), site }) : undefined,
    // Thin pages, one per service and day: not indexed, their links are followed. No
    // canonical URL: it would point a noindex page at itself (conflicting signals).
    ...VARIANT_HEAD,
  });

  if (!valid || (isError && isNotFound(error))) return <NotFoundState message={t('day.notFound')} />;
  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="h-32 w-full rounded-2xl" />
        <SkeletonList rows={2} />
      </div>
    );
  }
  if (isError) return <ErrorState onRetry={() => void refetch()} />;

  const service = data.service;
  const minutes = statusMinutes(data);
  const dayStart = Date.parse(data.startsAt);
  const until = data.complete ? dayStart + DAY_MS : Math.min(dayStart + DAY_MS, f.now);

  return (
    <div className="space-y-10">
      <div>
        <Link to={paths.service(service)} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <ArrowLeft aria-hidden className="size-4" />
          {t('day.back', { name: service.name })}
        </Link>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-muted break-words">{service.name}</p>
            <h1 className="text-3xl font-semibold tracking-tight">
              <time dateTime={data.date}>{f.utcDay(data.date)}</time>
            </h1>
          </div>
          <Badge tone={data.status} className="px-3 py-1 text-sm">
            {data.status ? t(`common:status.${data.status}`) : t('uptime.noData')}
          </Badge>
        </div>
        <p className="mt-3 text-sm text-muted">{t('day.utcNote')}</p>
        {!data.complete && <p className="mt-1 text-sm text-muted">{t('day.incomplete')}</p>}
      </div>

      <Card as="section" className="p-5 sm:p-6">
        <h2 className="sr-only">{t('day.summary')}</h2>
        <dl className="grid gap-2 sm:grid-cols-3 sm:gap-3">
          <div className="rounded-xl bg-surface-2 px-4 py-3">
            <dt className="text-xs text-muted">{t('day.status')}</dt>
            <dd className="mt-0.5 font-semibold">{data.status ? t(`common:status.${data.status}`) : t('uptime.noData')}</dd>
          </div>
          <div className="rounded-xl bg-surface-2 px-4 py-3">
            <dt className="text-xs text-muted">{t('day.uptime')}</dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums">{data.uptime === null ? t('uptime.noData') : f.percent(data.uptime)}</dd>
          </div>
          <div className="rounded-xl bg-surface-2 px-4 py-3">
            <dt className="text-xs text-muted">{t('day.notOperational')}</dt>
            <dd className="mt-0.5 font-semibold">
              {minutes.length === 0
                ? t('day.none')
                : minutes.map((m) => (
                    <span key={m.status} className="block">
                      {t(`common:status.${m.status}`)}: {f.duration(m.minutes * 60_000)}
                    </span>
                  ))}
            </dd>
          </div>
        </dl>
      </Card>

      <section aria-labelledby="day-timeline">
        <h2 id="day-timeline" className="mb-3 text-lg font-semibold">
          {t('day.timeline')}
        </h2>
        {data.segments.length === 0 ? (
          <EmptyState>{t('day.noData')}</EmptyState>
        ) : (
          <Card className="p-5 sm:p-6">
            <DayStrip segments={data.segments} dayStart={dayStart} until={until} label={t('day.timelineLabel', { name: service.name })} />
            <ol className="mt-5 divide-y divide-border text-sm">
              {data.segments.map((s) => (
                <SegmentRow key={s.startedAt} segment={s} until={until} />
              ))}
            </ol>
          </Card>
        )}
      </section>

      {data.corrected && (
        <section aria-labelledby="day-corrections">
          <h2 id="day-corrections" className="text-lg font-semibold">
            {t('day.corrections')}
          </h2>
          <p className="mt-1 text-sm text-muted">{t('day.correctionsIntro')}</p>
          {(data.correctionNotes?.length ?? 0) > 0 && (
            <ul className="mt-3 space-y-2 text-sm">
              {data.correctionNotes!.map((note) => (
                <li key={note} className="rounded-xl bg-surface-2 px-3 py-2">
                  {note}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="day-incidents">
        <h2 id="day-incidents" className="mb-3 text-lg font-semibold">
          {t('day.incidents')}
        </h2>
        {data.incidents.length > 0 ? (
          <div className="space-y-3">
            {data.incidents.map((i) => (
              <IncidentSummary key={i.id} incident={i} />
            ))}
          </div>
        ) : (
          <EmptyState icon={<CircleCheck aria-hidden className="size-5 shrink-0 text-status-operational-text" />}>
            {t('day.noIncidents')}
          </EmptyState>
        )}
      </section>

      <section aria-labelledby="day-maintenance">
        <h2 id="day-maintenance" className="mb-3 text-lg font-semibold">
          {t('day.maintenance')}
        </h2>
        {data.maintenances.length > 0 ? (
          <div className="space-y-3">
            {data.maintenances.map((m) => (
              <MaintenanceSummary key={m.id} maintenance={m} />
            ))}
          </div>
        ) : (
          <EmptyState>{t('day.noMaintenance')}</EmptyState>
        )}
      </section>

      <nav aria-label={t('day.navigation')} className="flex flex-wrap justify-between gap-3 text-sm">
        {data.previousDate ? (
          <Link
            to={paths.day(service, data.previousDate)}
            rel="prev"
            className="inline-flex min-h-6 items-center gap-1 font-medium text-[color:var(--osp-accent-text,var(--accent))] hover:underline"
          >
            <ChevronLeft aria-hidden className="size-4" />
            {t('day.previous')}: {f.utcDay(data.previousDate)}
          </Link>
        ) : (
          <span />
        )}
        {data.nextDate && (
          <Link
            to={paths.day(service, data.nextDate)}
            rel="next"
            className="inline-flex min-h-6 items-center gap-1 font-medium text-[color:var(--osp-accent-text,var(--accent))] hover:underline"
          >
            {t('day.next')}: {f.utcDay(data.nextDate)}
            <ChevronRight aria-hidden className="size-4" />
          </Link>
        )}
      </nav>
    </div>
  );
}

/** End of a period for display and duration: its end, or the time up to which the day is known. */
const endOf = (segment: ServiceDaySegment, until: number) => (segment.endedAt ? Date.parse(segment.endedAt) : until);

/**
 * The periods as a strip over the day (00:00 to 24:00 UTC), a picture of the
 * list below it (which says the same in text). Patterns as in the uptime bar,
 * so it does not rely on color alone.
 */
function DayStrip({ segments, dayStart, until, label }: { segments: ServiceDaySegment[]; dayStart: number; until: number; label: string }) {
  const pct = (ms: number) => `${Math.max(0, Math.min(100, ((ms - dayStart) / DAY_MS) * 100))}%`;
  return (
    <div role="img" aria-label={label} className="relative h-8 overflow-hidden rounded-md bg-surface-2">
      {segments.map((s) => {
        const start = Date.parse(s.startedAt);
        const end = endOf(s, until);
        return (
          <span
            key={s.startedAt}
            className={clsx('absolute inset-y-0', STATUS_BG[s.status], PATTERN_CLASS[dayPattern(s.status)])}
            style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }}
          />
        );
      })}
    </div>
  );
}

function SegmentRow({ segment, until }: { segment: ServiceDaySegment; until: number }) {
  const { t } = useTranslation('public');
  const f = useFormat();
  const end = endOf(segment, until);
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
      <span className="flex items-center gap-2 font-medium">
        <span aria-hidden className={clsx('size-2.5 shrink-0 rounded-full', STATUS_BG[segment.status])} />
        {t(`common:status.${segment.status}`)}
        {segment.corrected && <span className="text-xs font-normal text-muted">({t('day.corrected')})</span>}
      </span>
      <span className="text-muted">
        <span className="sr-only">{t('day.period')}: </span>
        {/* With the date: in the visitor's time zone a UTC day can span two dates. */}
        {segment.endedAt ? (
          <TimeRange start={segment.startedAt} end={segment.endedAt} />
        ) : (
          <>
            <time dateTime={segment.startedAt}>{f.dateTime(segment.startedAt)}</time> – {t('day.ongoing')}
          </>
        )}
        {' · '}
        <span className="sr-only">{t('day.duration')}: </span>
        {f.duration(end - Date.parse(segment.startedAt))}
      </span>
    </li>
  );
}
