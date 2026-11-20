import { CalendarClock, CircleCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { IncidentSummary, MaintenanceSummary } from '../components/Events';
import { FeedMenu } from '../components/Controls';
import { ServiceCatalog } from '../components/ServiceList';
import { StatusHero } from '../components/StatusHero';
import { EmptyState, ErrorState, PageTitle, SectionHeader, Skeleton, SkeletonList } from '../components/ui';
import { useSummary } from '../hooks/queries';
import { usePageHead } from '../head';

const UPCOMING_PREVIEW = 3;

export function OverviewPage() {
  const { t } = useTranslation('public');
  const { data, isPending, isError, refetch } = useSummary();
  // ?upcoming=all lists every upcoming maintenance (a link, so it works without JavaScript).
  const [params] = useSearchParams();
  const allUpcoming = params.get('upcoming') === 'all';
  usePageHead({});

  if (isPending) return <OverviewSkeleton />;
  if (isError) return <ErrorState onRetry={() => void refetch()} />;

  const upcoming = allUpcoming ? data.upcomingMaintenances : data.upcomingMaintenances.slice(0, UPCOMING_PREVIEW);
  const hasServices = data.groups.length > 0 || data.ungrouped.length > 0;

  return (
    <div className="space-y-10">
      <PageTitle title={data.page.siteName} subtitle={data.page.description}>
        <FeedMenu email={data.emailSubscriptions} />
      </PageTitle>

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
        <SectionHeader
          id="active-maintenance"
          title={t('overview.activeMaintenance')}
          to="/history?type=maintenance"
          count={data.activeMaintenances.length}
        />
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
          <SectionHeader
            id="upcoming-maintenance"
            title={t('overview.upcomingMaintenance')}
            count={data.upcomingMaintenances.length}
          />
          <div className="space-y-3">
            {upcoming.map((m) => (
              <MaintenanceSummary key={m.id} maintenance={m} />
            ))}
          </div>
          {data.upcomingMaintenances.length > UPCOMING_PREVIEW && (
            <Link
              to={allUpcoming ? '/#upcoming-maintenance' : '/?upcoming=all#upcoming-maintenance'}
              replace
              preventScrollReset
              className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-[color:var(--osp-accent-text,var(--accent))] hover:underline"
            >
              <CalendarClock aria-hidden className="size-4" />
              {allUpcoming
                ? t('overview.showFewerUpcoming')
                : t('overview.viewAllUpcoming', { count: data.upcomingMaintenances.length })}
            </Link>
          )}
        </section>
      )}

      <section aria-labelledby="recent-incidents">
        <SectionHeader id="recent-incidents" title={t('overview.recentIncidents')} to="/history?type=incident" />
        {data.recentIncidents.length > 0 ? (
          <div className="space-y-3">
            {data.recentIncidents.map((i) => (
              <IncidentSummary key={i.id} incident={i} />
            ))}
          </div>
        ) : (
          <EmptyState icon={<CircleCheck aria-hidden className="size-5 shrink-0 text-status-operational-text" />}>
            {t('overview.noRecentIncidents', { count: data.page.recentIncidentDays })}
          </EmptyState>
        )}
      </section>

      <section aria-labelledby="services-overview">
        <SectionHeader id="services-overview" title={t('overview.services')} to="/services" />
        {hasServices ? (
          <ServiceCatalog groups={data.groups} ungrouped={data.ungrouped} />
        ) : (
          <EmptyState>{t('services.empty')}</EmptyState>
        )}
      </section>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-10">
      <div className="flex flex-col items-center gap-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-4 w-80 max-w-full" />
        <Skeleton className="h-9 w-48 rounded-full" />
      </div>
      <Skeleton className="h-56 w-full rounded-2xl" />
      <SkeletonList rows={3} />
    </div>
  );
}
