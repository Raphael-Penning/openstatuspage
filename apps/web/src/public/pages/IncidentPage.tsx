import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { BackToHistory, DetailSkeleton, Fact, LocationNames } from '../components/Detail';
import { ImpactBadge, IncidentIcon, IncidentStatusBadge, Timeline } from '../components/Events';
import { DateTime } from '../components/Time';
import { Card, ErrorState, StatusPill } from '../components/ui';
import { useServicePaths } from '../hooks/links';
import { useFormat } from '../hooks/preferences';
import { isNotFound, useIncident } from '../hooks/queries';
import { NotFoundState } from './NotFoundState';
import { absoluteUrl, useBaseUrl, usePageHead, useSiteName } from '../head';

export function IncidentPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation('public');
  const f = useFormat();
  const { data, isPending, isError, error, refetch } = useIncident(id);
  const site = useSiteName();
  // Below the link base: on a private page the service links stay on it.
  const paths = useServicePaths();
  const baseUrl = useBaseUrl();
  usePageHead({
    title: data?.title ?? t('incident.title'),
    // The latest update says best what the incident is about.
    description: data ? data.updates[0]?.message || t('seo.incident', { site, title: data.title }) : undefined,
    article: data
      ? {
          datePublished: data.startedAt,
          dateModified: data.updatedAt,
          about: data.affectedServices.map((s) => ({ name: s.name, url: absoluteUrl(paths.service({ id: s.id }), baseUrl) })),
        }
      : undefined,
    breadcrumbs: data ? [{ name: t('nav.history'), path: '/history' }, { name: data.title, path: `/incidents/${encodeURIComponent(data.id)}` }] : undefined,
  });

  if (isPending) return <DetailSkeleton />;
  if (isError) {
    return isNotFound(error) ? <NotFoundState message={t('incident.notFound')} /> : <ErrorState onRetry={() => void refetch()} />;
  }

  const resolved = data.status === 'resolved';

  return (
    <article className="space-y-8">
      <div>
        <BackToHistory />
        <div className="mt-4 flex items-start gap-3">
          <IncidentIcon incident={data} className="mt-2 size-6" />
          <div className="min-w-0">
            <p className="text-sm text-muted">{t('incident.title')}</p>
            <h1 className="text-3xl font-semibold tracking-tight break-words">{data.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <IncidentStatusBadge incident={data} />
              <ImpactBadge impact={data.impact} />
            </div>
          </div>
        </div>
      </div>

      <Card as="section" className="p-5 sm:p-6">
        <h2 className="sr-only">{t('detail.facts')}</h2>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Fact label={t('incident.started')}>
            <DateTime value={data.startedAt} />
          </Fact>
          <Fact label={resolved ? t('incident.resolved') : t('incident.lastUpdate')}>
            <DateTime value={resolved && data.resolvedAt ? data.resolvedAt : data.updatedAt} />
          </Fact>
          <Fact label={t('incident.duration')}>
            {f.durationSince(data.startedAt, resolved ? data.resolvedAt : null)}
            {!resolved && <span className="ml-1 font-normal text-muted">({t('incident.ongoing')})</span>}
          </Fact>
        </dl>

        {data.affectedServices.length > 0 && (
          <div className="mt-6 border-t border-border pt-5">
            <h3 className="mb-3 text-sm font-semibold">{t('detail.affectedServices')}</h3>
            <ul className="divide-y divide-border">
              {data.affectedServices.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                  <Link to={paths.service({ id: s.id })} className="min-w-0 text-sm break-words hover:text-[color:var(--osp-accent-text,var(--accent))] hover:underline">
                    {s.name}
                  </Link>
                  <StatusPill status={s.status} />
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-4">
          <LocationNames ids={data.locationIds} />
        </div>
      </Card>

      <section aria-labelledby="incident-updates">
        <h2 id="incident-updates" className="mb-4 text-lg font-semibold">
          {t('detail.updates')}
        </h2>
        <Card className="p-5 sm:p-6">
          <Timeline updates={data.updates} kind="incident" />
        </Card>
      </section>
    </article>
  );
}
