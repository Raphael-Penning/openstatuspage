import type { AdminMonitorSource } from '@openstatuspage/shared';
import { KeyRound, ListChecks, Plus, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api } from '../../../lib/api';
import { ConfirmDialog, useConfirm } from '../../components/Dialog';
import { IngestTokenDialog } from '../../components/IngestTokenDialog';
import { SourcePollStatus } from '../../components/SourcePollStatus';
import { Badge, Card, EmptyState, IconButton, LinkButton, PageHeader, QueryState, Table, td, th, tr } from '../../components/ui';
import { useAdminMutation, useSources } from '../../lib/queries';
import { isPullType } from '../../lib/source-form';
import { useSourceActions } from '../../lib/useSourceActions';

export default function SourceListPage() {
  const { t } = useTranslation('admin');
  const sources = useSources();
  const confirm = useConfirm();
  const actions = useSourceActions();
  const remove = useAdminMutation((s: AdminMonitorSource) => api.delete(`/api/admin/monitor-sources/${s.id}`), {
    success: t('sources.deleted'),
    onSuccess: () => confirm.close(),
  });

  return (
    <>
      <PageHeader
        title={t('sources.title')}
        description={t('sources.description')}
        actions={
          <>
            <LinkButton to="/admin/monitoring/checks" icon={ListChecks}>
              {t('nav.checks')}
            </LinkButton>
            <LinkButton to="/admin/monitoring/new" variant="primary" icon={Plus}>
              {t('sources.new')}
            </LinkButton>
          </>
        }
      />
      <Card>
        <QueryState query={sources}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState>{t('sources.empty')}</EmptyState>
            ) : (
              <Table label={t('sources.title')}>
                <thead>
                  <tr>
                    <th className={th}>{t('sources.fields.name')}</th>
                    <th className={th}>{t('sources.lastPoll')}</th>
                    <th className={th}>{t('nav.checks')}</th>
                    <th className={`${th} text-right`}>{t('table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => (
                    <tr key={s.id} className={tr}>
                      <td className={td}>
                        <Link to={`/admin/monitoring/${s.id}`} className="font-medium hover:text-accent">
                          {s.name}
                        </Link>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Badge tone="accent">{t(`sources.types.${s.type}`)}</Badge>
                          {!s.enabled && <Badge tone="warning">{t('sources.disabled')}</Badge>}
                        </div>
                      </td>
                      <td className={td}>
                        <SourcePollStatus source={s} />
                      </td>
                      <td className={`${td} tabular-nums`}>
                        <Link to={`/admin/monitoring/checks?sourceId=${s.id}`} className="hover:text-accent">
                          {s.checkCount}
                        </Link>
                      </td>
                      <td className={`${td} text-right whitespace-nowrap`}>
                        {isPullType(s.type) && (
                          <>
                            <IconButton
                              icon={PlugZap}
                              label={t('sources.test')}
                              disabled={actions.test.isPending}
                              onClick={() => actions.test.mutate(s)}
                            />
                            <IconButton
                              icon={RefreshCw}
                              label={t('sources.pollNow')}
                              disabled={actions.poll.isPending}
                              onClick={() => actions.poll.mutate(s)}
                            />
                          </>
                        )}
                        <IconButton
                          icon={KeyRound}
                          label={t('sources.rotateToken')}
                          onClick={() =>
                            confirm.ask({
                              title: t('sources.rotateToken'),
                              message: t('sources.rotateConfirm', { name: s.name }),
                              confirmLabel: t('sources.rotate'),
                              action: () => {
                                confirm.close();
                                actions.rotate.mutate(s);
                              },
                            })
                          }
                        />
                        <IconButton
                          icon={Trash2}
                          label={t('common:actions.delete')}
                          onClick={() =>
                            confirm.ask({
                              title: t('sources.deleteTitle'),
                              message: t('sources.deleteConfirm', { name: s.name, count: s.checkCount }),
                              action: () => remove.mutate(s),
                            })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryState>
      </Card>
      {actions.token && (
        <IngestTokenDialog
          open
          onClose={actions.clearToken}
          type={actions.token.source.type}
          ingestUrl={actions.token.source.ingestUrl}
          token={actions.token.token}
        />
      )}
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </>
  );
}
