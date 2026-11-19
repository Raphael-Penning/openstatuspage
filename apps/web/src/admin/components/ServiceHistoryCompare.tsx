/**
 * Measured vs corrected status history of one service for a date range
 * (admin service page). The colored timelines are decorative; the same
 * information is available as text in the summary and the table.
 */
import type { HistorySegment } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { STATUS_BG } from '../../lib/status';
import { dateInputToIso } from '../lib/datetime';
import { useFormat } from '../lib/format';
import { useServiceHistory } from '../lib/queries';
import { TextField } from './fields';
import { Card, EmptyState, LinkButton, QueryState, StatusBadge, Table, td, th, tr } from './ui';

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function Timeline({ segments, from, to, label }: { segments: HistorySegment[]; from: string; to: string; label: string }) {
  const start = new Date(from).getTime();
  const span = new Date(to).getTime() - start;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <div aria-hidden className="relative h-4 overflow-hidden rounded bg-surface-2">
        {segments.map((s, i) => {
          const a = new Date(s.startedAt).getTime();
          const b = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
          return (
            <span
              key={i}
              className={clsx('absolute inset-y-0', STATUS_BG[s.status], s.source !== 'measured' && 'opacity-80 ring-1 ring-fg ring-inset')}
              style={{ left: `${((a - start) / span) * 100}%`, width: `${Math.max(((b - a) / span) * 100, 0.2)}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}

export function ServiceHistoryCompare({ serviceId }: { serviceId: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const [fromDate, setFromDate] = useState(() => localDate(new Date(Date.now() - 6 * DAY_MS)));
  const [toDate, setToDate] = useState(() => localDate(new Date()));
  const from = dateInputToIso(fromDate);
  const to = dateInputToIso(toDate, 1);
  const valid = Boolean(from && to && to > from);
  const history = useServiceHistory(serviceId, from ?? '', to ?? '', valid);
  const percent = (n: number | null) => (n === null ? '–' : `${new Intl.NumberFormat(fmt.locale, { maximumFractionDigits: 2 }).format(n)} %`);

  const correctionLink = (() => {
    if (!from || !to) return '/admin/corrections';
    const end = new Date(Math.min(new Date(to).getTime(), Date.now())).toISOString();
    const q = new URLSearchParams({ new: '1', serviceId, startsAt: from, endsAt: end });
    return `/admin/corrections?${q.toString()}`;
  })();

  return (
    <Card
      title={t('corrections.compare.title')}
      actions={
        <LinkButton to={correctionLink} icon={Plus} size="sm">
          {t('corrections.compare.add')}
        </LinkButton>
      }
    >
      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <p className="text-sm text-muted">{t('corrections.compare.intro')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={t('corrections.filterFrom')} type="date" value={fromDate} onValue={setFromDate} required />
          <TextField
            label={t('corrections.filterTo')}
            type="date"
            value={toDate}
            onValue={setToDate}
            required
            error={!valid ? t('validation.endAfterStart') : undefined}
          />
        </div>
        {valid && (
          <QueryState query={history}>
            {(h) => {
              const changed = h.corrected.filter((s) => s.source !== 'measured');
              return (
                <div className="flex flex-col gap-4">
                  <dl className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-border p-3">
                      <dt className="text-xs text-muted">{t('corrections.compare.measured')}</dt>
                      <dd className="text-lg font-semibold tabular-nums">{percent(h.measuredUptime)}</dd>
                    </div>
                    <div className="rounded-lg border border-border p-3">
                      <dt className="text-xs text-muted">{t('corrections.compare.corrected')}</dt>
                      <dd className="text-lg font-semibold tabular-nums">{percent(h.correctedUptime)}</dd>
                    </div>
                  </dl>
                  <Timeline segments={h.measured} from={h.from} to={h.to} label={t('corrections.compare.measured')} />
                  <Timeline segments={h.corrected} from={h.from} to={h.to} label={t('corrections.compare.corrected')} />
                  {changed.length === 0 ? (
                    <EmptyState>{t('corrections.compare.none')}</EmptyState>
                  ) : (
                    <Table label={t('corrections.compare.changes')}>
                      <thead>
                        <tr>
                          <th className={th}>{t('corrections.fields.range')}</th>
                          <th className={th}>{t('corrections.compare.correctedStatus')}</th>
                          <th className={th}>{t('corrections.compare.source')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {changed.map((s, i) => {
                          const correction = h.corrections.find((c) => c.id === s.sourceId);
                          const maintenance = h.maintenances.find((m) => m.id === s.sourceId);
                          return (
                            <tr key={i} className={tr}>
                              <td className={`${td} whitespace-nowrap`}>
                                {fmt.dateTime(s.startedAt)}
                                <span className="block text-xs text-muted">{t('corrections.until', { time: fmt.dateTime(s.endedAt) })}</span>
                              </td>
                              <td className={td}>
                                <StatusBadge status={s.status} />
                              </td>
                              <td className={td}>
                                {s.source === 'maintenance' ? (
                                  <Link to={`/admin/maintenance/${s.sourceId}`} className="text-accent underline">
                                    {t('corrections.compare.maintenance', { title: maintenance?.title ?? '' })}
                                  </Link>
                                ) : (
                                  <span className="text-sm break-words">
                                    {t('corrections.compare.correction')}
                                    {correction && <span className="block text-xs text-muted">{correction.reason}</span>}
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </Table>
                  )}
                </div>
              );
            }}
          </QueryState>
        )}
      </div>
    </Card>
  );
}
