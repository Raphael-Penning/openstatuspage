import { Search, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { CounterCards } from '../components/CounterCards';
import { NoScript } from '../components/NoScript';
import { ServiceCatalog } from '../components/ServiceList';
import { EmptyState, ErrorState, PageTitle, Skeleton, SkeletonList } from '../components/ui';
import { useServices } from '../hooks/queries';
import { filterServices, toCounters, type CounterKey } from '../utils/status';
import { usePageHead } from '../head';

const COUNTER_KEYS: readonly CounterKey[] = ['operational', 'degraded', 'offline', 'maintenance'];
const parseCounter = (value: string | null): CounterKey | null =>
  COUNTER_KEYS.includes(value as CounterKey) ? (value as CounterKey) : null;

/** /services with the search (?q=) and the status filter (?status=), empty ones left out. */
function servicesHref(q: string, status: CounterKey | null): string {
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q);
  if (status) params.set('status', status);
  const qs = params.toString();
  return qs ? `/services?${qs}` : '/services';
}

/**
 * Search and status filter live in the URL: the server renders the filtered
 * list, the search is a GET form and the counters are links, so both work
 * without JavaScript. With JavaScript the list filters while typing.
 */
export function ServicesPage() {
  const { t } = useTranslation('public');
  const { data, isPending, isError, refetch } = useServices();
  const [params, setParams] = useSearchParams();
  const [query, setQueryState] = useState(() => params.get('q') ?? '');
  const counter = parseCounter(params.get('status'));
  const searchId = useId();
  usePageHead({ title: t('nav.services') });

  const setQuery = (value: string) => {
    setQueryState(value);
    const next = new URLSearchParams(params);
    if (value.trim()) next.set('q', value);
    else next.delete('q');
    setParams(next, { replace: true, preventScrollReset: true });
  };

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
            linkTo={(key) => servicesHref(query, key)}
            label={t('services.countersLabel')}
          />

          <form role="search" method="get" action="/services" className="relative" onSubmit={(e) => e.preventDefault()}>
            {counter && <input type="hidden" name="status" value={counter} />}
            <label htmlFor={searchId} className="sr-only">
              {t('services.search')}
            </label>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted" />
            <input
              id={searchId}
              type="search"
              name="q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('services.search')}
              className="min-h-11 w-full rounded-full border border-border-strong bg-surface py-2 pr-10 pl-10 text-sm placeholder:text-muted focus:border-accent [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <Link
                to={servicesHref('', counter)}
                replace
                preventScrollReset
                onClick={() => setQueryState('')}
                aria-label={t('services.clearSearch')}
                title={t('services.clearSearch')}
                className="absolute top-1/2 right-3 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
              >
                <X aria-hidden className="size-4" />
              </Link>
            )}
            <NoScript>
              <button type="submit" className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-4 py-1.5 text-sm font-medium hover:border-accent">
                <Search aria-hidden className="size-4" />
                {t('services.searchSubmit')}
              </button>
            </NoScript>
          </form>

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
