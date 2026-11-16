import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { IncidentStatusBadge, ImpactBadge } from '../../components/badges';
import { Badge, Card, EmptyState, LinkButton, PageHeader, Pagination, QueryState, Segmented, Table, td, th, tr, VisibilityBadge } from '../../components/ui';
import { useFormat } from '../../lib/format';
import { useIncidents } from '../../lib/queries';

type Filter = 'active' | 'resolved' | 'all';
const PAGE_SIZE = 20;

export default function IncidentListPage() {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const [params, setParams] = useSearchParams();
  const filter = (['active', 'resolved', 'all'].includes(params.get('status') ?? '') ? params.get('status') : 'active') as Filter;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const incidents = useIncidents(filter, page, PAGE_SIZE);

  return (
    <>
      <PageHeader
        title={t('incidents.title')}
        description={t('incidents.description')}
        actions={
          <LinkButton to="/admin/incidents/new" variant="primary" icon={Plus}>
            {t('incidents.new')}
          </LinkButton>
        }
      />
      <div className="mb-4">
        <Segmented
          label={t('form.filterBy')}
          value={filter}
          onChange={(v) => setParams({ status: v })}
          options={[
            { value: 'active', label: t('incidents.filter.active') },
            { value: 'resolved', label: t('incidents.filter.resolved') },
            { value: 'all', label: t('incidents.filter.all') },
          ]}
        />
      </div>
      <Card>
        <QueryState query={incidents}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState>{t('incidents.empty')}</EmptyState>
            ) : (
              <>
                <Table label={t('incidents.title')}>
                  <thead>
                    <tr>
                      <th className={th}>{t('incidents.fields.title')}</th>
                      <th className={th}>{t('incidents.fields.status')}</th>
                      <th className={th}>{t('incidents.fields.impact')}</th>
                      <th className={th}>{t('incidents.fields.startedAt')}</th>
                      <th className={th}>{t('incidents.affectedServices')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((i) => (
                      <tr key={i.id} className={tr}>
                        <td className={td}>
                          <Link to={`/admin/incidents/${i.id}`} className="font-medium hover:text-accent">
                            {i.title}
                          </Link>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {!i.isPublic && <VisibilityBadge isPublic={false} />}
                            {i.source === 'auto' && <Badge tone="accent">{t('incidents.auto')}</Badge>}
                          </div>
                        </td>
                        <td className={td}>
                          <IncidentStatusBadge status={i.status} />
                        </td>
                        <td className={td}>
                          <ImpactBadge impact={i.impact} />
                        </td>
                        <td className={`${td} whitespace-nowrap text-muted`}>{fmt.dateTime(i.startedAt)}</td>
                        <td className={`${td} text-muted`}>
                          {i.affectedServices.length === 0 ? '–' : i.affectedServices.map((s) => s.name).join(', ')}
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
