import { CHECK_STATES, type AdminMonitorCheck, type CheckState } from '@openstatuspage/shared';
import { Lock, Search, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { api } from '../../../lib/api';
import { ConfirmDialog, useConfirm } from '../../components/Dialog';
import { CheckboxField, InlineSelect, inputClass } from '../../components/fields';
import { Card, CheckStateBadge, EmptyState, IconButton, PageHeader, QueryState, Table, td, th, tr } from '../../components/ui';
import { useFormat } from '../../lib/format';
import { useAdminMutation, useChecks } from '../../lib/queries';
import { useDebounced } from '../../lib/useDebounced';
import { useIsAdmin } from '../../session';

export default function ChecksPage() {
  const { t } = useTranslation('admin');
  const isAdmin = useIsAdmin();
  const fmt = useFormat();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const sourceId = params.get('sourceId') ?? '';
  const state = (CHECK_STATES as readonly string[]).includes(params.get('state') ?? '') ? (params.get('state') as CheckState) : '';
  const unlinked = params.get('unlinked') === 'true';
  const debouncedQ = useDebounced(q.trim(), 250);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const checks = useChecks({ q: debouncedQ || undefined, sourceId: sourceId || undefined, state: state || undefined, unlinked });
  // Source names come from the (cached) unfiltered list, which editors can read too.
  const all = useChecks({});
  const sourceOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of all.data ?? []) seen.set(c.sourceId, c.sourceName);
    return [{ value: '', label: t('checks.allSources') }, ...[...seen].map(([value, label]) => ({ value, label }))];
  }, [all.data, t]);

  const remove = useAdminMutation((c: AdminMonitorCheck) => api.delete(`/api/admin/checks/${c.id}`), {
    success: t('checks.deleted'),
    onSuccess: () => confirm.close(),
  });

  return (
    <>
      <PageHeader title={t('checks.title')} description={t('checks.description')} />
      <p className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted">
        <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
        {t('checkLinks.internalNotice')}
      </p>
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
          <div className="relative min-w-[14rem] flex-1">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={q}
              onChange={(e) => setParam('q', e.target.value)}
              placeholder={t('checkLinks.searchPlaceholder')}
              aria-label={t('checkLinks.search')}
              className={`${inputClass} pl-8`}
            />
          </div>
          <InlineSelect label={t('checks.filterSource')} value={sourceId} onValue={(v) => setParam('sourceId', v)} options={sourceOptions} className="w-full sm:w-48" />
          <InlineSelect<CheckState | ''>
            label={t('checks.filterState')}
            value={state}
            onValue={(v) => setParam('state', v)}
            options={[{ value: '', label: t('checks.allStates') }, ...CHECK_STATES.map((s) => ({ value: s, label: t(`common:checkState.${s}`) }))]}
            className="w-full sm:w-40"
          />
          <CheckboxField
            className="shrink-0"
            label={t('checks.onlyUnlinked')}
            checked={unlinked}
            onChecked={(v) => setParam('unlinked', v ? 'true' : '')}
          />
        </div>
        <QueryState query={checks}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState>{t('checks.empty')}</EmptyState>
            ) : (
              <>
                <Table label={t('checks.title')}>
                  <thead>
                    <tr>
                      <th className={th}>{t('checks.check')}</th>
                      <th className={th}>{t('checks.state')}</th>
                      <th className={th}>{t('checks.lastCheck')}</th>
                      <th className={th}>{t('checks.services')}</th>
                      {isAdmin && <th className={`${th} text-right`}>{t('table.actions')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((c) => (
                      <tr key={c.id} className={tr}>
                        <td className={td}>
                          <p className="font-medium break-words">
                            {c.host && <span className="font-normal text-muted">{c.host} · </span>}
                            {c.name}
                          </p>
                          <p className="text-xs text-muted">{c.sourceName}</p>
                          {c.output && (
                            <p className="mt-0.5 line-clamp-2 max-w-md font-mono text-xs break-all text-muted" title={c.output}>
                              {c.output}
                            </p>
                          )}
                        </td>
                        <td className={td}>
                          <CheckStateBadge state={c.state} />
                        </td>
                        <td className={`${td} whitespace-nowrap text-muted`} title={fmt.dateTime(c.lastCheckAt)}>
                          {fmt.relative(c.lastCheckAt)}
                        </td>
                        <td className={`${td} tabular-nums ${c.serviceCount === 0 ? 'text-muted' : ''}`}>{c.serviceCount}</td>
                        {isAdmin && (
                          <td className={`${td} text-right`}>
                            <IconButton
                              icon={Trash2}
                              label={t('common:actions.delete')}
                              onClick={() =>
                                confirm.ask({
                                  title: t('checks.deleteTitle'),
                                  message: t('checks.deleteConfirm', { name: c.name, count: c.serviceCount }),
                                  action: () => remove.mutate(c),
                                })
                              }
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <p className="border-t border-border px-4 py-2 text-xs text-muted">{t('checks.count', { count: list.length })}</p>
              </>
            )
          }
        </QueryState>
      </Card>
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </>
  );
}
