import { clsx } from 'clsx';
import { MapPin } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CounterCards } from '../components/CounterCards';
import { Card, EmptyState, ErrorState, PageTitle, Skeleton, SkeletonList, StatusPill } from '../components/ui';
import { useCountryName } from '../hooks/countries';
import { useDocumentTitle } from '../hooks/dom';
import { useLocations, usePublicSettings } from '../hooks/queries';
import { groupByRegion, toCounters } from '../utils/status';
import { NotFoundState } from './NotFoundState';

const WorldMap = lazy(() => import('../components/WorldMap'));

export function LocationsPage() {
  const { t } = useTranslation('public');
  const { data: settings, isError: settingsError, refetch: refetchSettings } = usePublicSettings();
  // Wait for the settings so a hidden locations page never flashes its content.
  const enabled = settings?.showLocations === true;
  const { data, isPending, isError, refetch } = useLocations(enabled);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const countryName = useCountryName();
  useDocumentTitle(t('nav.locations'));

  if (settings && !settings.showLocations) return <NotFoundState />;
  if (!settings && settingsError) return <ErrorState onRetry={() => void refetchSettings()} />;

  return (
    <div className="space-y-8">
      <PageTitle title={t('locations.title')} subtitle={t('locations.subtitle')} />

      {isPending ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="aspect-[2/1] w-full rounded-2xl" />
          <SkeletonList rows={3} />
        </>
      ) : isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : data.locations.length === 0 ? (
        <EmptyState icon={<MapPin aria-hidden className="size-5 shrink-0" />}>{t('locations.empty')}</EmptyState>
      ) : (
        <>
          <CounterCards counters={toCounters(data.counts)} label={t('locations.countersLabel')} />

          <Card as="section" className="overflow-hidden p-2 sm:p-4">
            <h2 className="sr-only">{t('locations.map')}</h2>
            <Suspense fallback={<Skeleton className="aspect-[2/1] w-full rounded-xl" />}>
              <WorldMap locations={data.locations} selectedId={selectedId} onSelect={setSelectedId} />
            </Suspense>
            <MapLegend />
          </Card>

          <div className="space-y-6">
            {groupByRegion(data.locations).map((g) => (
              <section key={g.region} aria-labelledby={`region-${g.region}`}>
                <h2 id={`region-${g.region}`} className="mb-3 flex items-baseline gap-2 text-lg font-semibold">
                  {t(`common:region.${g.region}`)}
                  <span className="text-sm font-normal text-muted">{g.locations.length}</span>
                </h2>
                <Card className="overflow-hidden">
                  <ul className="divide-y divide-border">
                    {g.locations.map((l) => {
                      const onMap = l.latitude !== null && l.longitude !== null;
                      const place = [l.city, countryName(l.country)].filter(Boolean).join(', ');
                      return (
                        <li key={l.id}>
                          <button
                            type="button"
                            disabled={!onMap}
                            aria-pressed={onMap ? selectedId === l.id : undefined}
                            onClick={() => setSelectedId(selectedId === l.id ? null : l.id)}
                            className={clsx(
                              'flex w-full items-center gap-3 px-4 py-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-default sm:px-5',
                              onMap && 'hover:bg-surface-2',
                              selectedId === l.id && 'bg-surface-2',
                            )}
                          >
                            <MapPin aria-hidden className="size-4 shrink-0 text-muted" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">
                                {l.name}
                                {l.code && <span className="ml-2 text-xs font-normal text-muted">{l.code}</span>}
                              </span>
                              {place && <span className="block truncate text-xs text-muted">{place}</span>}
                              {l.description && <span className="mt-0.5 block text-xs text-muted">{l.description}</span>}
                            </span>
                            <StatusPill status={l.status} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MapLegend() {
  const { t } = useTranslation();
  const items = ['operational', 'maintenance', 'degraded', 'partial_outage', 'major_outage'] as const;
  return (
    <ul className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 px-2 text-xs text-muted" aria-label={t('public:locations.legend')}>
      {items.map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-full" style={{ background: `var(--status-${s.replace('_', '-')})` }} />
          {t(`status.${s}`)}
        </li>
      ))}
    </ul>
  );
}
