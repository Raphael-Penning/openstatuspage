import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { BackToHistory, DetailSkeleton, Fact, LocationNames } from '../components/Detail';
import { ImpactBadge, IncidentIcon, IncidentStatusBadge, Timeline } from '../components/Events';
import { DateTime } from '../components/Time';
import { Card, ErrorState, StatusPill } from '../components/ui';
import { useDocumentTitle } from '../hooks/dom';
import { useFormat } from '../hooks/preferences';
import { isNotFound, useIncident } from '../hooks/queries';
import { NotFoundState } from './NotFoundState';

export function IncidentPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation('public');
  const f = useFormat();
  const { data, isPending, isError, error, refetch } = useIncident(id);
  useDocumentTitle(data?.title ?? t('incident.title'));

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
                  <Link to={`/services/${s.id}`} className="min-w-0 text-sm break-words hover:text-[color:var(--osp-accent-text,var(--accent))] hover:underline">
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
