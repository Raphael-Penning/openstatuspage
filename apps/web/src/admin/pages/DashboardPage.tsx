import { clsx } from 'clsx';
import { CalendarClock, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { AuditEntries } from '../components/AuditEntries';
import { Card, LinkButton, PageHeader, QueryState, StatusBadge } from '../components/ui';
import { useFormat } from '../lib/format';
import { useOverview, useSources } from '../lib/queries';
import { useIsAdmin } from '../session';

function Counter({ label, value, to, sub, alert }: { label: string; value: number; to?: string; sub?: ReactNode; alert?: boolean }) {
  const body = (
    <>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={clsx('mt-1 text-2xl font-semibold tabular-nums', alert && 'text-status-major-outage')}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </>
  );
  const cls = 'block rounded-xl border border-border bg-surface p-4';
  return to ? (
    <Link to={to} className={clsx(cls, 'transition hover:border-accent focus-visible:outline-2 focus-visible:outline-accent')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export default function DashboardPage() {
  const { t } = useTranslation('admin');
  const isAdmin = useIsAdmin();
  const overview = useOverview();
  const sources = useSources(isAdmin);
  const fmt = useFormat();

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.description')}
        actions={
          <>
            <LinkButton to="/admin/incidents/new" variant="primary" icon={Plus}>
              {t('incidents.new')}
            </LinkButton>
            <LinkButton to="/admin/maintenance/new" icon={CalendarClock}>
              {t('maintenance.new')}
            </LinkButton>
          </>
        }
      />
      <QueryState query={overview}>
        {(data) => {
          const nonOperational = data.services.filter((s) => s.status !== 'operational');
          const failingSources = (sources.data ?? []).filter((s) => s.enabled && s.lastPollOk === false);
          return (
            <div className="flex flex-col gap-6">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <Counter label={t('dashboard.counts.services')} value={data.counts.services} to="/admin/services" />
                <Counter
                  label={t('dashboard.counts.incidentsActive')}
                  value={data.counts.incidentsActive}
                  to="/admin/incidents"
                  alert={data.counts.incidentsActive > 0}
                />
                <Counter label={t('dashboard.counts.maintenancesActive')} value={data.counts.maintenancesActive} to="/admin/maintenance" />
                <Counter label={t('dashboard.counts.maintenancesUpcoming')} value={data.counts.maintenancesUpcoming} to="/admin/maintenance" />
                <Counter
                  label={t('dashboard.counts.sources')}
                  value={data.counts.sources}
                  to={isAdmin ? '/admin/monitoring' : undefined}
                  sub={t('dashboard.counts.failing', { count: data.counts.sourcesFailing })}
                  alert={data.counts.sourcesFailing > 0}
                />
                <Counter
                  label={t('dashboard.counts.checks')}
                  value={data.counts.checks}
                  to="/admin/monitoring/checks"
                  sub={t('dashboard.counts.failing', { count: data.counts.checksFailing })}
                />
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <Card title={t('dashboard.nonOperational')}>
                  {nonOperational.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted">{t('dashboard.allOperational')}</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {nonOperational.map((s) => (
                        <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                          <Link to={`/admin/services/${s.id}`} className="min-w-0 truncate text-sm font-medium hover:text-accent">
                            {s.name}
                          </Link>
                          <StatusBadge status={s.status} />
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card title={t('dashboard.failingSources')}>
                  {!isAdmin && data.counts.sourcesFailing > 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted">
                      {t('dashboard.failingSourcesCount', { count: data.counts.sourcesFailing })}
                    </p>
                  ) : failingSources.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted">{t('dashboard.noFailingSources')}</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {failingSources.map((s) => (
                        <li key={s.id} className="px-4 py-2.5 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <Link to={`/admin/monitoring/${s.id}`} className="font-medium hover:text-accent">
                              {s.name}
                            </Link>
                            <span className="text-xs text-muted">{fmt.relative(s.lastPollAt)}</span>
                          </div>
                          {s.lastError && <p className="mt-0.5 text-xs break-words text-status-major-outage">{s.lastError}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>

              <Card
                title={t('dashboard.recentActivity')}
                actions={
                  isAdmin && (
                    <Link to="/admin/audit-log" className="text-sm text-accent hover:underline">
                      {t('common:actions.viewAll')}
                    </Link>
                  )
                }
              >
                <AuditEntries entries={data.recentAudit} />
              </Card>
            </div>
          );
        }}
      </QueryState>
    </>
  );
}
