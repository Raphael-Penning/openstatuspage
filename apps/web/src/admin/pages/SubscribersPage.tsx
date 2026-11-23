/**
 * /admin/subscribers (admins only): email subscribers with search, status
 * filter, pagination and deletion.
 */
import type { AdminChannelSubscriber, AdminSubscriber } from '@openstatuspage/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../lib/api';
import { LANGUAGES } from '../../lib/i18n';
import { ConfirmDialog, useConfirm } from '../components/Dialog';
import { inputClass } from '../components/fields';
import { Badge, Card, EmptyState, IconButton, PageHeader, Pagination, QueryState, Segmented, Table, td, th, tr } from '../components/ui';
import { useFormat } from '../lib/format';
import { useAdminMutation, useSubscribers } from '../lib/queries';
import {
  pageAfterEnd,
  subscriberParams,
  subscriberQueryFromParams,
  subscriberScope,
  type SubscriberStatusFilter,
} from '../lib/subscribers';
import { useDebounced } from '../lib/useDebounced';

const PAGE_SIZE = 50;

const languageLabel = (code: string) => LANGUAGES.find((l) => l.code === code)?.label ?? code;

function EmailSubscribers() {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const [params, setParams] = useSearchParams();
  const query = subscriberQueryFromParams(params, PAGE_SIZE);
  const [search, setSearch] = useState(query.q ?? '');
  const debounced = useDebounced(search.trim());
  const subscribers = useSubscribers(query);
  const confirm = useConfirm();

  // Apply the search after typing stopped; a new search starts on page 1.
  useEffect(() => {
    if (debounced === (query.q ?? '')) return;
    setParams(subscriberParams({ ...query, q: debounced || undefined, page: 1 }), { replace: true });
    // Only the debounced input triggers this; the query is read at that moment.
  }, [debounced]);

  // Past the end (last entry of the last page deleted, outdated link): go to the last page.
  const lastPage = subscribers.data && !subscribers.isPlaceholderData ? pageAfterEnd(subscribers.data) : null;
  useEffect(() => {
    if (lastPage === null) return;
    setParams(subscriberParams({ ...query, page: lastPage }), { replace: true });
    // Only a new response triggers this; the query is read at that moment.
  }, [lastPage, subscribers.data]);

  const remove = useAdminMutation((s: AdminSubscriber) => api.delete(`/api/admin/subscribers/${encodeURIComponent(s.id)}`), {
    success: t('subscribers.deleted'),
    onSuccess: () => confirm.close(),
  });

  const filtered = Boolean(query.q) || query.status !== 'all';

  return (
    <>
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative sm:w-72">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('subscribers.search')}
              aria-label={t('subscribers.search')}
              maxLength={254}
              className={`${inputClass} pl-8`}
            />
          </div>
          <Segmented<SubscriberStatusFilter>
            label={t('subscribers.filterStatus')}
            value={query.status}
            onChange={(status) => setParams(subscriberParams({ ...query, status, page: 1 }))}
            options={[
              { value: 'all', label: t('subscribers.filter.all') },
              { value: 'confirmed', label: t('subscribers.filter.confirmed') },
              { value: 'pending', label: t('subscribers.filter.pending') },
            ]}
          />
        </div>
        <QueryState query={subscribers}>
          {(data) =>
            lastPage !== null ? null : data.items.length === 0 ? (
              filtered ? (
                <EmptyState>{t('subscribers.emptyFiltered')}</EmptyState>
              ) : (
                <EmptyState
                  action={
                    <Link to="/admin/settings" className="text-sm font-medium text-accent hover:underline">
                      {t('subscribers.toSettings')}
                    </Link>
                  }
                >
                  {t('subscribers.empty')}
                </EmptyState>
              )
            ) : (
              <>
                <Table label={t('subscribers.title')}>
                  <thead>
                    <tr>
                      <th className={th}>{t('subscribers.fields.email')}</th>
                      <th className={th}>{t('subscribers.fields.status')}</th>
                      <th className={th}>{t('subscribers.fields.scope')}</th>
                      <th className={th}>{t('subscribers.fields.language')}</th>
                      <th className={th}>{t('subscribers.fields.created')}</th>
                      <th className={th}>{t('subscribers.fields.confirmed')}</th>
                      <th className={`${th} text-right`}>{t('table.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((s) => (
                      <tr key={s.id} className={tr}>
                        <td className={td}>
                          <span className="block min-w-48 font-medium [overflow-wrap:anywhere]">{s.email}</span>
                        </td>
                        <td className={td}>
                          {s.confirmed ? (
                            <Badge tone="success">{t('subscribers.status.confirmed')}</Badge>
                          ) : (
                            <Badge tone="warning">{t('subscribers.status.pending')}</Badge>
                          )}
                        </td>
                        <td className={`${td} max-w-xs text-muted`}>{subscriberScope(s, t('subscribers.allUpdates'))}</td>
                        <td className={`${td} whitespace-nowrap`}>{languageLabel(s.locale)}</td>
                        <td className={`${td} whitespace-nowrap text-muted`}>
                          <time dateTime={s.createdAt} title={fmt.dateTime(s.createdAt)}>
                            {fmt.relative(s.createdAt)}
                          </time>
                        </td>
                        <td className={`${td} whitespace-nowrap text-muted`}>
                          {s.confirmedAt ? (
                            <time dateTime={s.confirmedAt} title={fmt.dateTime(s.confirmedAt)}>
                              {fmt.relative(s.confirmedAt)}
                            </time>
                          ) : (
                            '–'
                          )}
                        </td>
                        <td className={`${td} text-right`}>
                          <IconButton
                            icon={Trash2}
                            label={t('subscribers.deleteSubscriber', { email: s.email })}
                            onClick={() =>
                              confirm.ask({
                                title: t('subscribers.deleteTitle'),
                                message: t('subscribers.deleteConfirm', { email: s.email }),
                                action: () => remove.mutate(s),
                              })
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination
                  page={data.page}
                  pageSize={data.pageSize}
                  total={data.total}
                  onPage={(page) => setParams(subscriberParams({ ...query, page }))}
                />
              </>
            )
          }
        </QueryState>
      </Card>
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </>
  );
}

type ChannelFilter = 'email' | 'webhook' | 'sms';

/** Subscribers of every channel: email (search, status) or webhook/SMS (status). The channel is the `channel` query parameter. */
export default function SubscribersPage() {
  const { t } = useTranslation('admin');
  const [params, setParams] = useSearchParams();
  const raw = params.get('channel');
  const channel: ChannelFilter = raw === 'webhook' || raw === 'sms' ? raw : 'email';
  return (
    <>
      <PageHeader
        title={t('subscribers.title')}
        description={t('subscribers.description')}
        actions={
          <Segmented<ChannelFilter>
            label={t('subscribers.filterChannel')}
            value={channel}
            onChange={(c) => setParams(c === 'email' ? {} : { channel: c })}
            options={[
              { value: 'email', label: t('subscribers.channels.email') },
              { value: 'webhook', label: t('subscribers.channels.webhook') },
              { value: 'sms', label: t('subscribers.channels.sms') },
            ]}
          />
        }
      />
      {channel === 'email' ? <EmailSubscribers /> : <ChannelSubscribers key={channel} channel={channel} />}
    </>
  );
}

function ChannelSubscribers({ channel }: { channel: 'webhook' | 'sms' }) {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const confirm = useConfirm();
  const [status, setStatus] = useState<SubscriberStatusFilter>('all');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['admin', 'channel-subscribers', channel, status, page],
    queryFn: () =>
      api.getPage<AdminChannelSubscriber>('/api/admin/channel-subscribers', {
        page: { number: page, size: PAGE_SIZE },
        filter: { channel, status },
      }),
    placeholderData: keepPreviousData,
  });
  const remove = useAdminMutation((s: AdminChannelSubscriber) => api.delete(`/api/admin/channel-subscribers/${encodeURIComponent(s.id)}`), {
    success: t('subscribers.deleted'),
    onSuccess: () => confirm.close(),
  });
  return (
    <Card>
      <div className="flex justify-end border-b border-border p-4">
        <Segmented<SubscriberStatusFilter>
          label={t('subscribers.filterStatus')}
          value={status}
          onChange={(s) => {
            setStatus(s);
            setPage(1);
          }}
          options={[
            { value: 'all', label: t('subscribers.filter.all') },
            { value: 'confirmed', label: t('subscribers.filter.confirmed') },
            { value: 'pending', label: t('subscribers.filter.pending') },
          ]}
        />
      </div>
      <QueryState query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState
              action={
                <Link to="/admin/notifications" className="text-sm font-medium text-accent hover:underline">
                  {t('subscribers.toChannels')}
                </Link>
              }
            >
              {t('subscribers.emptyChannel')}
            </EmptyState>
          ) : (
            <>
              <Table label={t('subscribers.title')}>
                <thead>
                  <tr>
                    <th className={th}>{t('subscribers.fields.target')}</th>
                    <th className={th}>{t('subscribers.fields.status')}</th>
                    <th className={th}>{t('subscribers.fields.scope')}</th>
                    <th className={th}>{t('subscribers.fields.language')}</th>
                    <th className={th}>{t('subscribers.fields.created')}</th>
                    <th className={`${th} text-right`}>{t('table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((s) => (
                    <tr key={s.id} className={tr}>
                      <td className={`${td} font-medium`}>
                        {s.target}
                        {s.webhookKind && <span className="block text-xs font-normal text-muted">{t(`channels.kinds.${s.webhookKind}`)}</span>}
                      </td>
                      <td className={td}>
                        {s.confirmed ? (
                          <Badge tone="success">{t('subscribers.status.confirmed')}</Badge>
                        ) : (
                          <Badge tone="warning">{t('subscribers.status.pending')}</Badge>
                        )}
                      </td>
                      <td className={`${td} max-w-xs text-muted`}>{s.allServices ? t('subscribers.allUpdates') : s.services.map((x) => x.name).join(', ')}</td>
                      <td className={`${td} whitespace-nowrap`}>{languageLabel(s.locale)}</td>
                      <td className={`${td} whitespace-nowrap text-muted`}>
                        <time dateTime={s.createdAt} title={fmt.dateTime(s.createdAt)}>
                          {fmt.relative(s.createdAt)}
                        </time>
                      </td>
                      <td className={`${td} text-right`}>
                        <IconButton
                          icon={Trash2}
                          label={t('subscribers.deleteSubscriber', { email: s.target })}
                          onClick={() =>
                            confirm.ask({
                              title: t('subscribers.deleteTitle'),
                              message: t('subscribers.deleteConfirm', { email: s.target }),
                              action: () => remove.mutate(s),
                            })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
            </>
          )
        }
      </QueryState>
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </Card>
  );
}
