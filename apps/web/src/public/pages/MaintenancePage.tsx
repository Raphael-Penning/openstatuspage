import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { BackToHistory, DetailSkeleton, Fact, LocationNames } from '../components/Detail';
import { MaintenanceIcon, MaintenanceStatusBadge, Timeline } from '../components/Events';
import { DateTime, TimeRange } from '../components/Time';
import { Card, ErrorState } from '../components/ui';
import { useFormat } from '../hooks/preferences';
import { isNotFound, useMaintenance } from '../hooks/queries';
import { NotFoundState } from './NotFoundState';
import { usePageHead, useSiteName } from '../head';

export function MaintenancePage() {
  const { id = '' } = useParams();
  const { t } = useTranslation('public');
  const f = useFormat();
  const { data, isPending, isError, error, refetch } = useMaintenance(id);
  const site = useSiteName();
  usePageHead({
    title: data?.title ?? t('maintenance.title'),
    description: data ? data.description || data.updates[0]?.message || t('seo.maintenance', { site, title: data.title }) : undefined,
    article: data ? { datePublished: data.createdAt, dateModified: data.updatedAt } : undefined,
    breadcrumbs: data
      ? [{ name: t('nav.history'), path: '/history' }, { name: data.title, path: `/maintenance/${encodeURIComponent(data.id)}` }]
      : undefined,
  });

  if (isPending) return <DetailSkeleton />;
  if (isError) {
    return isNotFound(error) ? (
      <NotFoundState message={t('maintenance.notFound')} />
    ) : (
      <ErrorState onRetry={() => void refetch()} />
    );
  }

  const ended = data.status === 'completed' || data.status === 'cancelled';

  return (
    <article className="space-y-8">
      <div>
        <BackToHistory />
        <div className="mt-4 flex items-start gap-3">
          <MaintenanceIcon status={data.status} className="mt-2 size-6" />
          <div className="min-w-0">
            <p className="text-sm text-muted">{t('maintenance.title')}</p>
            <h1 className="text-3xl font-semibold tracking-tight break-words">{data.title}</h1>
            <div className="mt-3">
              <MaintenanceStatusBadge status={data.status} />
            </div>
          </div>
        </div>
        {data.description && <p className="prose-update mt-4 max-w-3xl text-muted">{data.description}</p>}
      </div>

      <Card as="section" className="p-5 sm:p-6">
        <h2 className="sr-only">{t('detail.facts')}</h2>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Fact label={t('maintenance.window')}>
            <TimeRange start={data.scheduledStart} end={data.scheduledEnd} />
          </Fact>
          {data.actualStart && (
            <Fact label={t('maintenance.actualStart')}>
              <DateTime value={data.actualStart} />
            </Fact>
          )}
          {data.actualEnd ? (
            <Fact label={t('maintenance.actualEnd')}>
              <DateTime value={data.actualEnd} />
            </Fact>
          ) : (
            data.status === 'in_progress' && (
              <Fact label={t('maintenance.runningFor')}>{f.durationSince(data.actualStart ?? data.scheduledStart, null)}</Fact>
            )
          )}
          {ended && data.actualStart && data.actualEnd && (
            <Fact label={t('incident.duration')}>{f.durationSince(data.actualStart, data.actualEnd)}</Fact>
          )}
        </dl>

        {data.affectedServices.length > 0 && (
          <div className="mt-6 border-t border-border pt-5">
            <h3 className="mb-3 text-sm font-semibold">{t('detail.affectedServices')}</h3>
            <ul className="flex flex-wrap gap-2">
              {data.affectedServices.map((s) => (
                <li key={s.id}>
                  <Link
                    to={`/services/${s.id}`}
                    className="inline-flex min-h-6 items-center rounded-full border border-border bg-surface-2 px-3 py-1 text-sm hover:border-accent"
                  >
                    {s.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-4">
          <LocationNames ids={data.locationIds} />
        </div>
      </Card>

      <section aria-labelledby="maintenance-updates">
        <h2 id="maintenance-updates" className="mb-4 text-lg font-semibold">
          {t('detail.updates')}
        </h2>
        <Card className="p-5 sm:p-6">
          <Timeline updates={data.updates} kind="maintenance" />
        </Card>
      </section>
    </article>
  );
}
