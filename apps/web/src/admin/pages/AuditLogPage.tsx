import type { AuditLogEntry } from '@openstatuspage/shared';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { auditSubject, EntityBadge, useAuditLabels } from '../components/AuditEntries';
import { InlineSelect } from '../components/fields';
import { Card, EmptyState, PageHeader, Pagination, QueryState, Table, td, th, tr } from '../components/ui';
import { useFormat } from '../lib/format';
import { useAuditLog } from '../lib/queries';

const ENTITY_TYPES = [
  'incident',
  'maintenance',
  'service',
  'service_group',
  'location',
  'monitor_source',
  'check',
  'settings',
  'user',
  'api_token',
  'subscriber',
] as const;

const PAGE_SIZE = 25;

/** Details without the keys already shown elsewhere, as compact "key: value" text. */
function detailText(entry: AuditLogEntry): string {
  const d = entry.details ?? {};
  return Object.entries(d)
    .filter(([k]) => k !== 'apiToken')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
}

export default function AuditLogPage() {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const labels = useAuditLabels();
  const [params, setParams] = useSearchParams();
  const entityType = params.get('entityType') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const log = useAuditLog(page, entityType, PAGE_SIZE);

  return (
    <>
      <PageHeader title={t('audit.title')} description={t('audit.description')} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
          <InlineSelect
            label={t('audit.filterEntity')}
            value={entityType}
            onValue={(v) => setParams(v ? { entityType: v } : {})}
            options={[{ value: '', label: t('audit.allEntities') }, ...ENTITY_TYPES.map((e) => ({ value: e, label: labels.entity(e) }))]}
            className="sm:w-56"
          />
        </div>
        <QueryState query={log}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState>{t('audit.empty')}</EmptyState>
            ) : (
              <>
                <Table label={t('audit.title')}>
                  <thead>
                    <tr>
                      <th className={th}>{t('audit.time')}</th>
                      <th className={th}>{t('audit.actor')}</th>
                      <th className={th}>{t('audit.action')}</th>
                      <th className={th}>{t('audit.details')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((e) => (
                      <tr key={e.id} className={tr}>
                        <td className={`${td} whitespace-nowrap text-muted`}>
                          <time dateTime={e.createdAt}>{fmt.dateTime(e.createdAt)}</time>
                        </td>
                        <td className={td}>{labels.actor(e)}</td>
                        <td className={td}>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium">{labels.action(e.action)}</span>
                            <EntityBadge type={e.entityType} />
                          </div>
                          {auditSubject(e) && <p className="text-xs text-muted">{auditSubject(e)}</p>}
                        </td>
                        <td className={`${td} max-w-sm text-xs break-words text-muted`}>{detailText(e) || '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  page={data.page}
                  pageSize={data.pageSize}
                  total={data.total}
                  onPage={(p) => setParams({ ...(entityType ? { entityType } : {}), page: String(p) })}
                />
              </>
            )
          }
        </QueryState>
      </Card>
    </>
  );
}
