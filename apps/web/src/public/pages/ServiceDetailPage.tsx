import { ArrowLeft, CircleCheck, ExternalLink, MapPin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { IncidentSummary, MaintenanceSummary } from '../components/Events';
import { RelativeTime } from '../components/Time';
import { UptimeBar, UptimeDayTable } from '../components/UptimeBar';
import { Card, EmptyState, ErrorState, SectionHeader, Skeleton, SkeletonList, StatusPill } from '../components/ui';
import { useFormat } from '../hooks/preferences';
import { isNotFound, useLocations, usePublicSettings, useService } from '../hooks/queries';
import { averageUptime, correctedDays, lastDays } from '../utils/uptime';
import { NotFoundState } from './NotFoundState';
import { usePageHead, useSiteName } from '../head';
import { useOutboundHref } from '../components/OutboundLink';
import { useServicePaths } from '../hooks/links';
import { usePrivatePageToken } from '../hooks/private-page';

export function ServiceDetailPage() {
  const { slug = '' } = useParams();
  const { t } = useTranslation('public');
  const f = useFormat();
  const { data: settings } = usePublicSettings();
  const outbound = useOutboundHref();
  // On a private page (/p/<token>) the service links back to it; the main pages' history and locations stay out.
  const isPrivate = usePrivatePageToken() !== null;
  const showLocations = settings?.showLocations !== false && !isPrivate;
  const { data, isPending, isError, error, refetch, dataUpdatedAt } = useService(slug);
  const { data: locations } = useLocations(showLocations && (data?.locationIds.length ?? 0) > 0);
  const site = useSiteName();
  const paths = useServicePaths();
  const path = data ? paths.service(data) : undefined;
  usePageHead({
    title: data?.name ?? t('nav.services'),
    description: data ? data.description || t('seo.service', { name: data.name, site }) : undefined,
    // A service is reachable by id and by slug: the slug is canonical.
    canonical: path,
    breadcrumbs: data && path ? [{ name: t('nav.services'), path: '/services' }, { name: data.name, path }] : undefined,
    service: data ? { name: data.name, ...(data.description ? { description: data.description } : {}) } : undefined,
  });

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="h-48 w-full rounded-2xl" />
        <SkeletonList rows={2} />
      </div>
    );
  }
  if (isError) {
    return isNotFound(error) ? (
      <NotFoundState message={t('service.notFound')} />
    ) : (
      <ErrorState onRetry={() => void refetch()} />
    );
  }

  const serviceLocations = (locations?.locations ?? []).filter((l) => data.locationIds.includes(l.id));
  const stats = [7, 30]
    .filter((n) => n < data.uptime.length)
    .map((n) => ({ label: t('service.lastDays', { count: n }), value: averageUptime(lastDays(data.uptime, n)) }));
  stats.push({ label: t('service.lastDays', { count: data.uptime.length }), value: data.uptimePercent });
  const corrected = correctedDays(data.uptime);
  const dayHref = (date: string) => paths.day(data, date);

  return (
    <div className="space-y-10">
      <div>
        <Link to={isPrivate ? paths.home : '/services'} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <ArrowLeft aria-hidden className="size-4" />
          {isPrivate ? t('private.back') : t('service.back')}
        </Link>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-muted">{t(`common:kind.${data.kind}`)}</p>
            <h1 className="text-3xl font-semibold tracking-tight break-words">{data.name}</h1>
          </div>
          <StatusPill status={data.status} className="px-3 py-1 text-sm" />
        </div>
        {data.description && <p className="mt-3 max-w-3xl text-muted">{data.description}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          {data.kind === 'site' && data.url && (
            <a href={outbound(data.url)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[color:var(--osp-accent-text,var(--accent))] hover:underline">
              <ExternalLink aria-hidden className="size-4" />
              {data.url.replace(/^https?:\/\//, '')}
              <span className="sr-only"> {t('link.newTab')}</span>
            </a>
          )}
          {serviceLocations.length > 0 && (
            <span className="inline-flex items-start gap-1.5">
              <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
              <span>
                <span className="sr-only">{t('service.locations')}: </span>
                {serviceLocations.map((l, i) => (
                  <span key={l.id}>
                    <Link to="/locations" className="hover:text-[color:var(--osp-accent-text,var(--accent))] hover:underline">
                      {l.name}
                    </Link>
                    {i < serviceLocations.length - 1 && ', '}
                  </span>
                ))}
              </span>
            </span>
          )}
        </div>
      </div>

      {settings?.showUptime !== false && data.uptime.length > 0 && (
        <Card as="section" className="p-5 sm:p-6">
          <h2 className="mb-4 font-semibold">{t('service.uptime')}</h2>
          {/* Every day on wide and medium screens, at most 90 on phones. */}
          <UptimeBar
            uptime={data.uptime}
            days={data.uptime.length}
            tabletDays={data.uptime.length}
            phoneDays={90}
            label={data.name}
            dayHref={dayHref}
            percent={data.uptimePercent}
            size="lg"
          />
          <UptimeDayTable uptime={data.uptime} label={data.name} dayHref={dayHref} />
          <dl className="mt-6 grid grid-cols-3 gap-2 sm:gap-3">
            {stats.map((s) => (
              <div key={s.label} className="rounded-xl bg-surface-2 px-3 py-3 sm:px-4">
                <dt className="text-xs text-muted">{s.label}</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums sm:text-xl">
                  {s.value === null ? t('uptime.noData') : f.percent(s.value)}
                </dd>
              </div>
            ))}
          </dl>
          {corrected.length > 0 && (
            <section aria-labelledby="service-corrections" className="mt-6">
              <h3 id="service-corrections" className="text-sm font-semibold">
                {t('service.corrections')}
              </h3>
              <p className="mt-1 text-sm text-muted">{t('service.correctionsIntro')}</p>
              <ul className="mt-3 space-y-2 text-sm">
                {corrected.map((d) => (
                  <li key={d.date} className="rounded-xl bg-surface-2 px-3 py-2">
                    <Link to={dayHref(d.date)} className="font-medium text-[color:var(--osp-accent-text,var(--accent))] hover:underline">
                      {f.utcDay(d.date)}
                    </Link>
                    {d.correctionNotes && d.correctionNotes.length > 0 ? (
                      d.correctionNotes.map((note) => (
                        <span key={note} className="block text-muted">
                          {note}
                        </span>
                      ))
                    ) : (
                      <span className="block text-muted">{t('uptime.corrected')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </Card>
      )}

      {data.maintenances.length > 0 && (
        <section aria-labelledby="service-maintenance">
          <SectionHeader id="service-maintenance" title={t('service.maintenance')} count={data.maintenances.length} />
          <div className="space-y-3">
            {data.maintenances.map((m) => (
              <MaintenanceSummary key={m.id} maintenance={m} />
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="service-incidents">
        <SectionHeader
          id="service-incidents"
          title={t('service.incidents')}
          to={isPrivate ? undefined : `/history?service=${encodeURIComponent(data.id)}`}
          linkLabel={t('service.fullHistory')}
        />
        {data.incidents.length > 0 ? (
          <div className="space-y-3">
            {data.incidents.map((i) => (
              <IncidentSummary key={i.id} incident={i} />
            ))}
          </div>
        ) : (
          <EmptyState icon={<CircleCheck aria-hidden className="size-5 shrink-0 text-status-operational-text" />}>
            {t('service.noIncidents')}
          </EmptyState>
        )}
      </section>

      <p className="text-xs text-muted">
        {t('lastRefreshed')} <RelativeTime value={new Date(dataUpdatedAt).toISOString()} />
      </p>
    </div>
  );
}
