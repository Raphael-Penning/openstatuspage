import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api } from '../../../lib/api';
import {
  Badge,
  Card,
  EmptyState,
  IconButton,
  LinkButton,
  PageHeader,
  QueryState,
  StatusBadge,
  Table,
  td,
  th,
  tr,
  VisibilityBadge,
} from '../../components/ui';
import { countryName } from '../../lib/countries';
import { ORDERING_DOCUMENT } from '../../lib/documents';
import { useFormat } from '../../lib/format';
import { bySortOrder, moveId } from '../../lib/ordering';
import { useAdminMutation, useLocations } from '../../lib/queries';
import { useIsAdmin } from '../../session';

export default function LocationListPage() {
  const { t } = useTranslation('admin');
  const isAdmin = useIsAdmin();
  const fmt = useFormat();
  const locations = useLocations();
  const reorder = useAdminMutation((ids: string[]) => api.post('/api/admin/locations/reorder', { ids }, ORDERING_DOCUMENT), {
    success: t('reorder.saved'),
  });

  return (
    <>
      <PageHeader
        title={t('locations.title')}
        description={t('locations.description')}
        actions={
          isAdmin && (
            <LinkButton to="/admin/locations/new" variant="primary" icon={Plus}>
              {t('locations.new')}
            </LinkButton>
          )
        }
      />
      <Card>
        <QueryState query={locations}>
          {(list) => {
            const sorted = [...list].sort(bySortOrder);
            const ids = sorted.map((l) => l.id);
            if (sorted.length === 0) return <EmptyState>{t('locations.empty')}</EmptyState>;
            return (
              <Table label={t('locations.title')}>
                <thead>
                  <tr>
                    <th className={th}>{t('locations.fields.name')}</th>
                    <th className={th}>{t('locations.place')}</th>
                    <th className={th}>{t('locations.fields.region')}</th>
                    <th className={th}>{t('services.status')}</th>
                    <th className={th}>{t('locations.servicesCount')}</th>
                    {isAdmin && <th className={`${th} text-right`}>{t('reorder.label')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((l, i) => (
                    <tr key={l.id} className={tr}>
                      <td className={td}>
                        <Link to={`/admin/locations/${l.id}`} className="font-medium hover:text-accent">
                          {l.name}
                        </Link>
                        {l.code && <span className="ml-2 font-mono text-xs text-muted">{l.code}</span>}
                        {!l.isPublic && (
                          <div className="mt-1">
                            <VisibilityBadge isPublic={false} />
                          </div>
                        )}
                      </td>
                      <td className={`${td} text-muted`}>
                        {[l.city, l.country ? countryName(l.country, fmt.locale) : null].filter(Boolean).join(', ') || '–'}
                      </td>
                      <td className={`${td} text-muted`}>{t(`common:region.${l.region}`)}</td>
                      <td className={td}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge status={l.status} />
                          {l.statusOverride && <Badge tone="warning">{t('locations.overridden')}</Badge>}
                        </div>
                      </td>
                      <td className={`${td} tabular-nums text-muted`}>{l.serviceIds.length}</td>
                      {isAdmin && (
                        <td className={`${td} text-right whitespace-nowrap`}>
                          <IconButton
                            icon={ArrowUp}
                            label={t('reorder.up', { name: l.name })}
                            disabled={i === 0 || reorder.isPending}
                            onClick={() => reorder.mutate(moveId(ids, i, -1))}
                          />
                          <IconButton
                            icon={ArrowDown}
                            label={t('reorder.down', { name: l.name })}
                            disabled={i === sorted.length - 1 || reorder.isPending}
                            onClick={() => reorder.mutate(moveId(ids, i, 1))}
                          />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            );
          }}
        </QueryState>
      </Card>
    </>
  );
}
