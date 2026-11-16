import type { AdminService } from '@openstatuspage/shared';
import { ArrowDown, ArrowUp, Globe, Plus } from 'lucide-react';
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
import { groupByParent, moveId } from '../../lib/ordering';
import { useAdminMutation, useGroups, useServices } from '../../lib/queries';
import { useIsAdmin } from '../../session';

function ServiceTable({ services }: { services: AdminService[] }) {
  const { t } = useTranslation('admin');
  const isAdmin = useIsAdmin();
  const reorder = useAdminMutation((ids: string[]) => api.post('/api/admin/services/reorder', { ids }), {
    success: t('reorder.saved'),
  });
  const ids = services.map((s) => s.id);

  if (services.length === 0) return <EmptyState>{t('services.emptyGroup')}</EmptyState>;
  return (
    <Table>
      <thead>
        <tr>
          <th className={th}>{t('services.fields.name')}</th>
          <th className={th}>{t('services.status')}</th>
          <th className={th}>{t('services.mode')}</th>
          <th className={th}>{t('services.checksCount')}</th>
          {isAdmin && <th className={`${th} text-right`}>{t('reorder.label')}</th>}
        </tr>
      </thead>
      <tbody>
        {services.map((s, i) => (
          <tr key={s.id} className={tr}>
            <td className={td}>
              <Link to={`/admin/services/${s.id}`} className="font-medium hover:text-accent">
                {s.name}
              </Link>
              <div className="mt-1 flex flex-wrap gap-1">
                <Badge>
                  {s.kind === 'site' && <Globe aria-hidden className="size-3" />}
                  {t(`common:kind.${s.kind}`)}
                </Badge>
                {!s.isPublic && <VisibilityBadge isPublic={false} />}
              </div>
            </td>
            <td className={td}>
              <StatusBadge status={s.status} />
            </td>
            <td className={`${td} text-muted`}>
              {s.statusMode === 'manual' ? t('services.statusMode.manual') : t(`services.aggregation.${s.aggregation}`)}
            </td>
            <td className={`${td} text-muted tabular-nums`}>{s.checks.length}</td>
            {isAdmin && (
              <td className={`${td} text-right whitespace-nowrap`}>
                <IconButton
                  icon={ArrowUp}
                  label={t('reorder.up', { name: s.name })}
                  disabled={i === 0 || reorder.isPending}
                  onClick={() => reorder.mutate(moveId(ids, i, -1))}
                />
                <IconButton
                  icon={ArrowDown}
                  label={t('reorder.down', { name: s.name })}
                  disabled={i === services.length - 1 || reorder.isPending}
                  onClick={() => reorder.mutate(moveId(ids, i, 1))}
                />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default function ServiceListPage() {
  const { t } = useTranslation('admin');
  const isAdmin = useIsAdmin();
  const services = useServices();
  const groups = useGroups();

  return (
    <>
      <PageHeader
        title={t('services.title')}
        description={t('services.description')}
        actions={
          isAdmin && (
            <>
              <LinkButton to="/admin/groups">{t('nav.groups')}</LinkButton>
              <LinkButton to="/admin/services/new" variant="primary" icon={Plus}>
                {t('services.new')}
              </LinkButton>
            </>
          )
        }
      />
      <QueryState query={services}>
        {(list) => {
          if (list.length === 0) {
            return (
              <Card>
                <EmptyState
                  action={
                    isAdmin && (
                      <LinkButton to="/admin/services/new" variant="primary" icon={Plus}>
                        {t('services.new')}
                      </LinkButton>
                    )
                  }
                >
                  {t('services.empty')}
                </EmptyState>
              </Card>
            );
          }
          const grouped = groupByParent(list, groups.data ?? []);
          return (
            <div className="flex flex-col gap-6">
              {grouped.groups.map(({ group, items }) => (
                <Card
                  key={group.id}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      {group.name}
                      {!group.isPublic && <VisibilityBadge isPublic={false} />}
                    </span>
                  }
                >
                  <ServiceTable services={items} />
                </Card>
              ))}
              {grouped.ungrouped.length > 0 && (
                <Card title={t('services.ungrouped')}>
                  <ServiceTable services={grouped.ungrouped} />
                </Card>
              )}
            </div>
          );
        }}
      </QueryState>
    </>
  );
}
