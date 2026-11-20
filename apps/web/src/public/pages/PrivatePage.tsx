/**
 * Private status pages at /p/<token>: the chosen services of the page (also
 * ones hidden from the main page) with their uptime bars, the overall status,
 * active incidents and running and upcoming maintenance that affect them.
 * Service and day pages below it reuse the main pages (ServiceDetailPage,
 * ServiceDayPage), which read the private page API inside PrivatePageProvider.
 *
 * Server-rendered for every request (never cached), complete without
 * JavaScript, never indexed (head.tsx) and without analytics (entry-server.tsx).
 * A wrong, disabled or expired link is "not found", like a malformed one.
 */
import { isPrivatePageToken, normalizePrivatePageToken } from '@openstatuspage/shared';
import { CircleCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { MaintenanceSummary, IncidentSummary } from '../components/Events';
import { ServiceCatalog } from '../components/ServiceList';
import { StatusHero } from '../components/StatusHero';
import { EmptyState, ErrorState, PageTitle, SectionHeader, Skeleton, SkeletonList } from '../components/ui';
import { usePageHead } from '../head';
import { PrivatePageProvider, usePrivatePageToken } from '../hooks/private-page';
import { isNotFound, usePrivatePage } from '../hooks/queries';
import { PublicLayout } from '../PublicLayout';
import { NotFoundState } from './NotFoundState';

/** Route element of /p/:token: the public layout with the token (lower case) and link base of the page. */
export function PrivatePageRoot() {
  const { token = '' } = useParams();
  return (
    <PrivatePageProvider token={normalizePrivatePageToken(token)}>
      <PublicLayout />
    </PrivatePageProvider>
  );
}


export function PrivateOverviewPage() {
  const token = usePrivatePageToken() ?? '';
  const valid = isPrivatePageToken(token);
  const { t } = useTranslation('public');
  const { data, isPending, isError, error, refetch } = usePrivatePage(token, valid);
  usePageHead({ title: data?.name ?? t('private.badge'), description: data?.description });

  if (!valid || (isError && isNotFound(error))) return <NotFoundState message={t('private.notFound')} />;
  if (isPending) {
    return (
      <div className="space-y-10">
        <div className="flex flex-col items-center gap-3">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-56 w-full rounded-2xl" />
        <SkeletonList rows={3} />
      </div>
    );
  }
  if (isError) return <ErrorState onRetry={() => void refetch()} />;

  return (
    <div className="space-y-10">
      <PageTitle title={data.name} subtitle={data.description} />

      <StatusHero
        overall={data.overall}
        activeIncidents={data.activeIncidents.length}
        activeMaintenances={data.activeMaintenances.length}
        updatedAt={data.generatedAt}
      />

      {data.activeIncidents.length > 0 && (
        <section aria-labelledby="active-incidents">
          <SectionHeader id="active-incidents" title={t('overview.activeIncidents')} count={data.activeIncidents.length} />
          <div className="space-y-3">
            {data.activeIncidents.map((i) => (
              <IncidentSummary key={i.id} incident={i} />
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="active-maintenance">
        <SectionHeader id="active-maintenance" title={t('overview.activeMaintenance')} count={data.activeMaintenances.length} />
        {data.activeMaintenances.length > 0 ? (
          <div className="space-y-3">
            {data.activeMaintenances.map((m) => (
              <MaintenanceSummary key={m.id} maintenance={m} />
            ))}
          </div>
        ) : (
          <EmptyState icon={<CircleCheck aria-hidden className="size-5 shrink-0 text-status-operational-text" />}>
            {t('overview.noActiveMaintenance')}
          </EmptyState>
        )}
      </section>

      {data.upcomingMaintenances.length > 0 && (
        <section aria-labelledby="upcoming-maintenance">
          <SectionHeader id="upcoming-maintenance" title={t('overview.upcomingMaintenance')} count={data.upcomingMaintenances.length} />
          <div className="space-y-3">
            {data.upcomingMaintenances.map((m) => (
              <MaintenanceSummary key={m.id} maintenance={m} />
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="private-services">
        <SectionHeader id="private-services" title={t('private.services')} />
        {data.services.length > 0 ? (
          <ServiceCatalog groups={[]} ungrouped={data.services} />
        ) : (
          <EmptyState>{t('private.empty')}</EmptyState>
        )}
      </section>
    </div>
  );
}
