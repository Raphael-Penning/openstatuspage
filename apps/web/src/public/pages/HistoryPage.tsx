import type { HistoryItem, HistoryQuery } from '@openstatuspage/shared';
import { ChevronDown, ChevronLeft, ChevronRight, RotateCcwClock, X } from 'lucide-react';
import { useId, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import {
  IncidentIcon,
  IncidentStatusBadge,
  MaintenanceIcon,
  MaintenanceStatusBadge,
} from '../components/Events';
import { DateTime } from '../components/Time';
import { Card, EmptyState, ErrorState, PageTitle, SkeletonList } from '../components/ui';
import { useFormat } from '../hooks/preferences';
import { useHistory, useLocations, usePublicSettings, useServices } from '../hooks/queries';
import { flattenServices, maintenanceEnd, maintenanceStart } from '../utils/status';
import { monthKey, recentMonths } from '../utils/time';
import { usePageHead } from '../head';

const PAGE_SIZE = 20;
const TYPES = ['all', 'incident', 'maintenance'] as const;
type HistoryType = (typeof TYPES)[number];

function parseType(value: string | null): HistoryType {
  return TYPES.includes(value as HistoryType) ? (value as HistoryType) : 'all';
}

/**
 * Query of the history list from the URL (?type, ?service, ?location, ?month,
 * ?page). Shared with the route loader so the server prefetches the same key.
 */
export function historyQuery(params: URLSearchParams, showLocations: boolean): Partial<HistoryQuery> {
  const location = showLocations ? (params.get('location') ?? '') : '';
  const month = /^\d{4}-\d{2}$/.test(params.get('month') ?? '') ? params.get('month')! : '';
  return {
    type: parseType(params.get('type')),
    serviceId: params.get('service') || undefined,
    locationId: location || undefined,
    month: month || undefined,
    page: Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1),
    pageSize: PAGE_SIZE,
  };
}

export function HistoryPage() {
  const { t } = useTranslation('public');
  const f = useFormat();
  const [params, setParams] = useSearchParams();
  const { data: settings } = usePublicSettings();
  const showLocations = settings?.showLocations !== false;
  const services = useServices();
  const locations = useLocations(showLocations);
  usePageHead({ title: t('nav.history') });

  const query = historyQuery(params, showLocations);
  const { type, page } = query as { type: HistoryType; page: number };
  const serviceId = query.serviceId ?? '';
  const locationId = query.locationId ?? '';
  const month = query.month ?? '';
  const { data, isPending, isError, isPlaceholderData, refetch } = useHistory(query);

  function update(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value && !(key === 'type' && value === 'all')) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: key !== 'page' });
  }

  const currentMonth = monthKey(new Date(f.now));
  const months = useMemo(() => recentMonths(new Date(`${currentMonth}-01T00:00:00Z`), 24), [currentMonth]);
  const serviceOptions = services.data ? flattenServices(services.data.groups, services.data.ungrouped) : [];
  const filtered = type !== 'all' || serviceId || locationId || month;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const sections = useMemo(() => {
    const out: { month: string; items: HistoryItem[] }[] = [];
    for (const item of data?.items ?? []) {
      const key = monthKey(item.date);
      const last = out[out.length - 1];
      if (last && last.month === key) last.items.push(item);
      else out.push({ month: key, items: [item] });
    }
    return out;
  }, [data]);

  return (
    <div className="space-y-8">
      <PageTitle title={t('history.title')} subtitle={t('history.subtitle')} />

      <Card as="section" className="p-4 sm:p-5">
        <h2 className="sr-only">{t('history.filters')}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect label={t('history.type')} value={type} onChange={(v) => update('type', v)}>
            <option value="all">{t('history.types.all')}</option>
            <option value="incident">{t('history.types.incident')}</option>
            <option value="maintenance">{t('history.types.maintenance')}</option>
          </FilterSelect>
          <FilterSelect label={t('history.service')} value={serviceId} onChange={(v) => update('service', v)}>
            <option value="">{t('history.allServices')}</option>
            {serviceOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </FilterSelect>
          {showLocations && (
            <FilterSelect label={t('history.location')} value={locationId} onChange={(v) => update('location', v)}>
              <option value="">{t('history.allLocations')}</option>
              {(locations.data?.locations ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code ? `${l.name} (${l.code})` : l.name}
                </option>
              ))}
            </FilterSelect>
          )}
          <FilterSelect label={t('history.month')} value={month} onChange={(v) => update('month', v)}>
            <option value="">{t('history.allMonths')}</option>
            {months.map((m) => (
              <option key={m} value={m}>
                {f.month(m)}
              </option>
            ))}
          </FilterSelect>
        </div>
        {filtered && (
          <button
            type="button"
            onClick={() => setParams(new URLSearchParams(), { replace: true })}
            className="mt-3 inline-flex items-center gap-1.5 text-sm text-[color:var(--osp-accent-text,var(--accent))] hover:underline"
          >
            <X aria-hidden className="size-4" />
            {t('history.reset')}
          </button>
        )}
      </Card>

      {isPending ? (
        <SkeletonList rows={5} />
      ) : isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : data.items.length === 0 ? (
        <EmptyState icon={<RotateCcwClock aria-hidden className="size-5 shrink-0" />}>
          {filtered ? t('history.emptyFiltered') : t('history.empty')}
        </EmptyState>
      ) : (
        <div className={isPlaceholderData ? 'opacity-60 motion-safe:transition-opacity' : undefined} aria-busy={isPlaceholderData}>
          <p className="sr-only" aria-live="polite">
            {t('history.resultCount', { count: data.total })}
          </p>
          <div className="space-y-8">
            {sections.map((s) => (
              <section key={s.month} aria-labelledby={`month-${s.month}`}>
                <h2 id={`month-${s.month}`} className="mb-3 text-sm font-semibold tracking-wide text-muted uppercase">
                  {f.month(s.month)}
                </h2>
                <Card className="overflow-hidden">
                  <ul className="divide-y divide-border">
                    {s.items.map((item) => (
                      <HistoryRow key={`${item.type}-${item.type === 'incident' ? item.incident.id : item.maintenance.id}`} item={item} />
                    ))}
                  </ul>
                </Card>
              </section>
            ))}
          </div>

          {totalPages > 1 && (
            <nav aria-label={t('history.pagination')} className="mt-8 flex items-center justify-between gap-3">
              <PageButton disabled={page <= 1} onClick={() => update('page', String(page - 1))}>
                <ChevronLeft aria-hidden className="size-4" />
                {t('history.previous')}
              </PageButton>
              <span className="text-sm text-muted">{t('history.pageOf', { page, total: totalPages })}</span>
              <PageButton disabled={page >= totalPages} onClick={() => update('page', String(page + 1))}>
                {t('history.next')}
                <ChevronRight aria-hidden className="size-4" />
              </PageButton>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-10 w-full cursor-pointer appearance-none rounded-xl border border-border-strong bg-surface-2 py-2 pr-9 pl-3 text-sm focus:border-accent"
        >
          {children}
        </select>
        <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" />
      </div>
    </div>
  );
}

function PageButton({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        onClick();
        window.scrollTo({ top: 0 });
      }}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium hover:border-accent disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function HistoryRow({ item }: { item: HistoryItem }) {
  const { t } = useTranslation('public');
  const f = useFormat();

  if (item.type === 'incident') {
    const i = item.incident;
    return (
      <li className="relative flex gap-3 px-4 py-4 hover:bg-surface-2 sm:px-5">
        <IncidentIcon incident={i} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h3 className="min-w-0 font-medium">
              <Link to={`/incidents/${i.id}`} className="after:absolute after:inset-0 hover:underline">
                {i.title}
              </Link>
            </h3>
            <IncidentStatusBadge incident={i} />
          </div>
          <p className="mt-1 text-xs text-muted">
            <span className="sr-only">{t('incident.title')} · </span>
            <DateTime value={i.startedAt} /> ·{' '}
            {i.resolvedAt
              ? t('incident.resolvedAfter', { duration: f.durationSince(i.startedAt, i.resolvedAt) })
              : t('incident.ongoingFor', { duration: f.durationSince(i.startedAt, null) })}
            {i.affectedServices.length > 0 && <> · {i.affectedServices.map((s) => s.name).join(', ')}</>}
          </p>
        </div>
      </li>
    );
  }

  const m = item.maintenance;
  return (
    <li className="relative flex gap-3 px-4 py-4 hover:bg-surface-2 sm:px-5">
      <MaintenanceIcon status={m.status} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 className="min-w-0 font-medium">
            <Link to={`/maintenance/${m.id}`} className="after:absolute after:inset-0 hover:underline">
              {m.title}
            </Link>
          </h3>
          <MaintenanceStatusBadge status={m.status} />
        </div>
        <p className="mt-1 text-xs text-muted">
          <span className="sr-only">{t('maintenance.title')} · </span>
          <DateTime value={maintenanceStart(m)} />
          {m.status !== 'cancelled' && <> · {t('maintenance.durationLabel', { duration: f.durationSince(maintenanceStart(m), m.status === 'in_progress' ? null : maintenanceEnd(m)) })}</>}
          {m.affectedServices.length > 0 && <> · {m.affectedServices.map((s) => s.name).join(', ')}</>}
        </p>
      </div>
    </li>
  );
}
