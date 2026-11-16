import { CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { MaintenanceStatusBadge } from '../../components/badges';
import {
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Pagination,
  QueryState,
  Segmented,
  Table,
  td,
  th,
  tr,
  VisibilityBadge,
} from '../../components/ui';
import { useFormat } from '../../lib/format';
import { useMaintenances } from '../../lib/queries';

type Filter = 'upcoming' | 'active' | 'past' | 'all';
const FILTERS: Filter[] = ['upcoming', 'active', 'past', 'all'];
const PAGE_SIZE = 20;

export default function MaintenanceListPage() {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const [params, setParams] = useSearchParams();
  const raw = params.get('status') as Filter | null;
  const filter: Filter = raw && FILTERS.includes(raw) ? raw : 'upcoming';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const list = useMaintenances(filter, page, PAGE_SIZE);

  return (
    <>
      <PageHeader
        title={t('maintenance.title')}
        description={t('maintenance.description')}
        actions={
          <LinkButton to="/admin/maintenance/new" variant="primary" icon={CalendarClock}>
            {t('maintenance.new')}
          </LinkButton>
        }
      />
      <div className="mb-4">
        <Segmented
          label={t('form.filterBy')}
          value={filter}
          onChange={(v) => setParams({ status: v })}
          options={FILTERS.map((f) => ({ value: f, label: t(`maintenance.filter.${f}`) }))}
        />
      </div>
      <Card>
        <QueryState query={list}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState>{t('maintenance.empty')}</EmptyState>
            ) : (
              <>
                <Table label={t('maintenance.title')}>
                  <thead>
                    <tr>
                      <th className={th}>{t('maintenance.fields.title')}</th>
                      <th className={th}>{t('maintenance.fields.status')}</th>
                      <th className={th}>{t('maintenance.window')}</th>
                      <th className={th}>{t('maintenance.fields.services')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((m) => (
                      <tr key={m.id} className={tr}>
                        <td className={td}>
                          <Link to={`/admin/maintenance/${m.id}`} className="font-medium hover:text-accent">
                            {m.title}
                          </Link>
                          {!m.isPublic && (
                            <div className="mt-1">
                              <VisibilityBadge isPublic={false} />
                            </div>
                          )}
                        </td>
                        <td className={td}>
                          <MaintenanceStatusBadge status={m.status} />
                        </td>
                        <td className={`${td} text-muted`}>
                          <div className="whitespace-nowrap">{fmt.dateTime(m.scheduledStart)}</div>
                          <div className="whitespace-nowrap">– {fmt.dateTime(m.scheduledEnd)}</div>
                        </td>
                        <td className={`${td} text-muted`}>
                          {m.affectedServices.length === 0 ? '–' : m.affectedServices.map((s) => s.name).join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  page={data.page}
                  pageSize={data.pageSize}
                  total={data.total}
                  onPage={(p) => setParams({ status: filter, page: String(p) })}
                />
              </>
            )
          }
        </QueryState>
      </Card>
    </>
  );
}
