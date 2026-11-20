import { clsx } from 'clsx';
import { MapPin } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CounterCards } from '../components/CounterCards';
import { StatusMarkerIcon } from '../components/StatusMarker';
import { Card, EmptyState, ErrorState, PageTitle, Skeleton, SkeletonList, StatusPill } from '../components/ui';
import { useHydrated } from '../../lib/ssr';
import { useCountryName } from '../hooks/countries';
import { useLocations, usePublicSettings } from '../hooks/queries';
import { groupByRegion, toCounters } from '../utils/status';
import { NotFoundState } from './NotFoundState';
import { usePageHead, useSiteName } from '../head';

const WorldMap = lazy(() => import('../components/WorldMap'));

export function LocationsPage() {
  const { t } = useTranslation('public');
  const { data: settings, isError: settingsError, refetch: refetchSettings } = usePublicSettings();
  // Wait for the settings so a hidden locations page never flashes its content.
  const enabled = settings?.showLocations === true;
  const { data, isPending, isError, refetch } = useLocations(enabled);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const countryName = useCountryName();
  const hydrated = useHydrated();
  const mapPlaceholder = <Skeleton className="aspect-[2/1] w-full rounded-xl" />;
  const site = useSiteName();
  usePageHead({
    title: t('nav.locations'),
    description: t('seo.locations', { site }),
    breadcrumbs: [{ name: t('nav.locations'), path: '/locations' }],
  });

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
            {/* The map is loaded lazily in the browser; the server renders its placeholder. */}
            {hydrated ? (
              <Suspense fallback={mapPlaceholder}>
                <WorldMap locations={data.locations} selectedId={selectedId} onSelect={setSelectedId} />
              </Suspense>
            ) : (
              mapPlaceholder
            )}
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
                      const content = (
                        <>
                          <MapPin aria-hidden className="size-4 shrink-0 text-muted" />
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium break-words">
                              {l.name}
                              {l.code && <span className="ml-2 text-xs font-normal text-muted">{l.code}</span>}
                            </span>
                            {place && <span className="block text-xs break-words text-muted">{place}</span>}
                            {l.description && <span className="mt-0.5 block text-xs text-muted">{l.description}</span>}
                          </span>
                          <StatusPill status={l.status} />
                        </>
                      );
                      const row = 'flex w-full items-center gap-3 px-4 py-3 text-left sm:px-5';
                      // This list is the text alternative of the map: every location with its status.
                      // Locations with coordinates can be highlighted on the map.
                      return (
                        <li key={l.id}>
                          {onMap ? (
                            <button
                              type="button"
                              aria-pressed={selectedId === l.id}
                              onClick={() => setSelectedId(selectedId === l.id ? null : l.id)}
                              className={clsx(
                                row,
                                'hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                                selectedId === l.id && 'bg-surface-2',
                              )}
                            >
                              {content}
                            </button>
                          ) : (
                            <div className={row}>{content}</div>
                          )}
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
          <StatusMarkerIcon status={s} className="size-3" />
          {t(`status.${s}`)}
        </li>
      ))}
    </ul>
  );
}
