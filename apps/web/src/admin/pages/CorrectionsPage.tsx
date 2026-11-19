/**
 * History corrections: status overrides for past time ranges (false alarms,
 * missed outages). They are applied over the measured history; see
 * apps/server/src/services/history-corrections.ts.
 */
import { CorrectionInput, type AdminCorrection, type ServiceStatus } from '@openstatuspage/shared';
import { Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { api } from '../../lib/api';
import { ConfirmDialog, Dialog, useConfirm } from '../components/Dialog';
import { CheckboxField, DateTimeField, FormErrorSummary, SelectField, TextAreaField, TextField } from '../components/fields';
import { ServicesPicker } from '../components/pickers';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader, Pagination, QueryState, StatusBadge, Table, td, th, tr } from '../components/ui';
import { dateInputToIso, isoToLocalInput, localInputToIso } from '../lib/datetime';
import { useFormat, useOptions } from '../lib/format';
import { useAdminMutation, useCorrections, useServices } from '../lib/queries';
import { useForm } from '../lib/useForm';

const PAGE_SIZE = 20;
/** End times up to this far in the future are accepted (the server clamps them to now). */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Prefill for a new correction (e.g. from the service history comparison). */
export interface CorrectionPrefill {
  serviceIds?: string[];
  startsAt?: string;
  endsAt?: string;
}

export default function CorrectionsPage() {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const [params, setParams] = useSearchParams();
  const services = useServices();
  const confirm = useConfirm();

  const serviceId = params.get('serviceId') ?? '';
  const fromDate = params.get('from') ?? '';
  const toDate = params.get('to') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const filter = {
    serviceId: serviceId || undefined,
    from: dateInputToIso(fromDate) ?? undefined,
    // "to" is inclusive in the UI: up to the end of that day.
    to: dateInputToIso(toDate, 1) ?? undefined,
    page,
  };
  const list = useCorrections(filter, PAGE_SIZE);

  // A link like /admin/corrections?new=1&serviceId=…&startsAt=…&endsAt=… opens the dialog prefilled.
  const [editing, setEditing] = useState<AdminCorrection | CorrectionPrefill | null>(() =>
    params.get('new') === '1'
      ? {
          serviceIds: serviceId ? [serviceId] : [],
          startsAt: params.get('startsAt') ?? undefined,
          endsAt: params.get('endsAt') ?? undefined,
        }
      : null,
  );

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    next.delete('new');
    next.delete('startsAt');
    next.delete('endsAt');
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const remove = useAdminMutation((id: string) => api.delete(`/api/admin/corrections/${id}`), {
    success: t('corrections.deleted'),
    onSuccess: () => confirm.close(),
  });

  const serviceOptions = [
    { value: '', label: t('corrections.allServices') },
    ...(services.data ?? []).map((s) => ({ value: s.id, label: s.name })),
  ];

  return (
    <>
      <PageHeader
        title={t('corrections.title')}
        description={t('corrections.description')}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setEditing({ serviceIds: serviceId ? [serviceId] : [] })}>
            {t('corrections.new')}
          </Button>
        }
      />
      <form
        role="search"
        aria-label={t('corrections.filterLabel')}
        className="mb-4 grid gap-3 sm:grid-cols-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <SelectField label={t('corrections.fields.service')} value={serviceId} onValue={(v) => update({ serviceId: v })} options={serviceOptions} />
        <TextField label={t('corrections.filterFrom')} type="date" value={fromDate} onValue={(v) => update({ from: v })} />
        <TextField label={t('corrections.filterTo')} type="date" value={toDate} onValue={(v) => update({ to: v })} />
      </form>
      <Card>
        <QueryState query={list}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState>{t('corrections.empty')}</EmptyState>
            ) : (
              <>
                <Table label={t('corrections.title')}>
                  <thead>
                    <tr>
                      <th className={th}>{t('corrections.fields.range')}</th>
                      <th className={th}>{t('corrections.fields.services')}</th>
                      <th className={th}>{t('corrections.fields.status')}</th>
                      <th className={th}>{t('corrections.fields.reason')}</th>
                      <th className={th}>{t('corrections.fields.visibility')}</th>
                      <th className={`${th} text-right`}>{t('table.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((c) => (
                      <tr key={c.id} className={tr}>
                        <td className={`${td} whitespace-nowrap`}>
                          <span className="block">{fmt.dateTime(c.startsAt)}</span>
                          <span className="block text-xs text-muted">
                            {t('corrections.until', { time: fmt.dateTime(c.endsAt) })}
                          </span>
                        </td>
                        <td className={td}>{c.services.map((s) => s.name).join(', ') || '–'}</td>
                        <td className={td}>
                          <StatusBadge status={c.status} />
                        </td>
                        <td className={`${td} max-w-xs`}>
                          <p className="line-clamp-3 text-sm break-words">{c.reason}</p>
                          <p className="mt-1 text-xs text-muted">
                            {t('corrections.createdBy', { name: c.createdByName ?? t('audit.system'), time: fmt.dateTime(c.createdAt) })}
                          </p>
                        </td>
                        <td className={td}>
                          {c.showPublic ? (
                            <>
                              <Badge>
                                <Eye aria-hidden className="size-3" />
                                {t('corrections.public')}
                              </Badge>
                              {c.publicNote && <p className="mt-1 max-w-xs text-xs break-words text-muted">{c.publicNote}</p>}
                            </>
                          ) : (
                            <Badge tone="warning">
                              <EyeOff aria-hidden className="size-3" />
                              {t('corrections.internal')}
                            </Badge>
                          )}
                        </td>
                        <td className={`${td} text-right whitespace-nowrap`}>
                          <IconButton icon={Pencil} label={t('corrections.editLabel', { time: fmt.dateTime(c.startsAt) })} onClick={() => setEditing(c)} />
                          <IconButton
                            icon={Trash2}
                            label={t('corrections.deleteLabel', { time: fmt.dateTime(c.startsAt) })}
                            onClick={() =>
                              confirm.ask({
                                title: t('corrections.deleteTitle'),
                                message: t('corrections.deleteConfirm'),
                                action: () => remove.mutate(c.id),
                              })
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={(p) => update({ page: String(p) })} />
              </>
            )
          }
        </QueryState>
      </Card>
      {editing && <CorrectionDialog value={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </>
  );
}

function isCorrection(v: AdminCorrection | CorrectionPrefill): v is AdminCorrection {
  return 'id' in v;
}

interface Values {
  serviceIds: string[];
  startsAt: string;
  endsAt: string;
  status: ServiceStatus;
  reason: string;
  showPublic: boolean;
  publicNote: string;
}

export function CorrectionDialog({ value, onClose }: { value: AdminCorrection | CorrectionPrefill; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const opts = useOptions();
  const existing = isCorrection(value) ? value : null;
  const form = useForm<Values>(() =>
    existing
      ? {
          serviceIds: existing.services.map((s) => s.id),
          startsAt: isoToLocalInput(existing.startsAt),
          endsAt: isoToLocalInput(existing.endsAt),
          status: existing.status,
          reason: existing.reason,
          showPublic: existing.showPublic,
          publicNote: existing.publicNote ?? '',
        }
      : {
          serviceIds: (value as CorrectionPrefill).serviceIds ?? [],
          startsAt: isoToLocalInput((value as CorrectionPrefill).startsAt),
          endsAt: isoToLocalInput((value as CorrectionPrefill).endsAt),
          status: 'operational',
          reason: '',
          showPublic: false,
          publicNote: '',
        },
  );
  const v = form.values;
  const save = useAdminMutation(
    (body: CorrectionInput) =>
      existing ? api.patch<AdminCorrection>(`/api/admin/corrections/${existing.id}`, body) : api.post<AdminCorrection>('/api/admin/corrections', body),
    { success: existing ? t('corrections.saved') : t('corrections.created'), onSuccess: onClose, onError: form.applyServerError },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const startsAt = localInputToIso(v.startsAt);
    const endsAt = localInputToIso(v.endsAt);
    if (!startsAt || !endsAt) {
      form.setErrors({
        ...(startsAt ? {} : { startsAt: { key: 'validation.datetime' } }),
        ...(endsAt ? {} : { endsAt: { key: 'validation.datetime' } }),
      });
      return;
    }
    if (new Date(endsAt).getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      form.setErrors({ endsAt: { key: 'validation.notInFuture' } });
      return;
    }
    const body = form.validate(CorrectionInput, {
      serviceIds: v.serviceIds,
      startsAt,
      endsAt,
      status: v.status,
      reason: v.reason.trim(),
      showPublic: v.showPublic,
      publicNote: v.showPublic ? v.publicNote.trim() || null : null,
    });
    if (body) save.mutate(body);
  };

  return (
    <Dialog open wide onClose={onClose} title={existing ? t('corrections.editTitle') : t('corrections.new')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('corrections.dialogIntro')}</p>
        <ServicesPicker
          label={t('corrections.fields.services')}
          value={v.serviceIds}
          onChange={(x) => form.set('serviceIds', x)}
          error={form.error('serviceIds')}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <DateTimeField
            label={t('corrections.fields.startsAt')}
            value={v.startsAt}
            onValue={(x) => form.set('startsAt', x)}
            error={form.error('startsAt')}
            required
          />
          <DateTimeField
            label={t('corrections.fields.endsAt')}
            help={t('corrections.endsAtHelp')}
            value={v.endsAt}
            onValue={(x) => form.set('endsAt', x)}
            error={form.error('endsAt')}
            required
          />
        </div>
        <SelectField<ServiceStatus>
          label={t('corrections.fields.status')}
          help={t('corrections.statusHelp')}
          value={v.status}
          onValue={(x) => form.set('status', x)}
          options={opts.serviceStatus}
          error={form.error('status')}
        />
        <TextAreaField
          label={t('corrections.fields.reason')}
          help={t('corrections.reasonHelp')}
          value={v.reason}
          onValue={(x) => form.set('reason', x)}
          error={form.error('reason')}
          rows={3}
          maxLength={2000}
          required
        />
        <CheckboxField
          label={t('corrections.fields.showPublic')}
          help={t('corrections.showPublicHelp')}
          checked={v.showPublic}
          onChecked={(x) => form.set('showPublic', x)}
        />
        {v.showPublic && (
          <TextField
            label={t('corrections.fields.publicNote')}
            help={t('corrections.publicNoteHelp')}
            value={v.publicNote}
            onValue={(x) => form.set('publicNote', x)}
            error={form.error('publicNote')}
            maxLength={500}
          />
        )}
        <FormErrorSummary errors={form.errors} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" variant="primary" pending={save.isPending}>
            {existing ? t('common:actions.save') : t('common:actions.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
