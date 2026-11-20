import { Search, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CounterCards } from '../components/CounterCards';
import { ServiceCatalog } from '../components/ServiceList';
import { EmptyState, ErrorState, PageTitle, Skeleton, SkeletonList } from '../components/ui';
import { useServices } from '../hooks/queries';
import { filterServices, toCounters, type CounterKey } from '../utils/status';
import { usePageHead } from '../head';

export function ServicesPage() {
  const { t } = useTranslation('public');
  const { data, isPending, isError, refetch } = useServices();
  const [query, setQuery] = useState('');
  const [counter, setCounter] = useState<CounterKey | null>(null);
  const searchId = useId();
  usePageHead({ title: t('nav.services') });

  const filtered = useMemo(
    () => (data ? filterServices(data.groups, data.ungrouped, { query, counter }) : null),
    [data, query, counter],
  );

  const total = data ? data.groups.reduce((n, g) => n + g.services.length, 0) + data.ungrouped.length : 0;
  const filtering = query.trim() !== '' || counter !== null;
  const empty = filtered && filtered.groups.length === 0 && filtered.ungrouped.length === 0;

  return (
    <div className="space-y-8">
      <PageTitle title={t('services.title')} subtitle={t('services.subtitle')} />

      {isPending ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 rounded-2xl" />
            ))}
          </div>
          <SkeletonList rows={4} />
        </>
      ) : isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : (
        <>
          <CounterCards
            counters={toCounters(data.counts)}
            selected={counter}
            onSelect={setCounter}
            label={t('services.countersLabel')}
          />

          <div className="relative">
            <label htmlFor={searchId} className="sr-only">
              {t('services.search')}
            </label>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted" />
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('services.search')}
              className="min-h-11 w-full rounded-full border border-border-strong bg-surface py-2 pr-10 pl-10 text-sm placeholder:text-muted focus:border-accent [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('services.clearSearch')}
                className="absolute top-1/2 right-3 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
              >
                <X aria-hidden className="size-4" />
              </button>
            )}
          </div>

          <p className="sr-only" aria-live="polite">
            {filtering && filtered
              ? t('services.results', {
                  count: filtered.groups.reduce((n, g) => n + g.services.length, 0) + filtered.ungrouped.length,
                })
              : ''}
          </p>

          {total === 0 ? (
            <EmptyState>{t('services.empty')}</EmptyState>
          ) : empty ? (
            <EmptyState icon={<Search aria-hidden className="size-5 shrink-0" />}>{t('services.noMatches')}</EmptyState>
          ) : (
            filtered && <ServiceCatalog groups={filtered.groups} ungrouped={filtered.ungrouped} forceOpen={filtering} headingLevel={2} />
          )}
        </>
      )}
    </div>
  );
}
