import { MaintenanceCreateInput, type AdminMaintenance } from '@openstatuspage/shared';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { api } from '../../../lib/api';
import { CheckboxField, DateTimeField, FormErrorSummary, TextAreaField, TextField } from '../../components/fields';
import { NotifySubscribersField } from '../../components/NotifySubscribersField';
import { LocationsPicker, ServicesPicker } from '../../components/pickers';
import { Button, Card, LinkButton, PageHeader, QueryState } from '../../components/ui';
import { isoToLocalInput, localInputToIso } from '../../lib/datetime';
import { useAdminMutation, useMaintenance } from '../../lib/queries';
import { MAINTENANCE_DOCUMENT } from '../../lib/documents';
import { useForm } from '../../lib/useForm';

interface Values {
  title: string;
  description: string;
  scheduledStart: string;
  scheduledEnd: string;
  autoStart: boolean;
  autoComplete: boolean;
  isPublic: boolean;
  serviceIds: string[];
  locationIds: string[];
  notify: boolean;
}

/** Next full hour + `hours`, as datetime-local value. */
function roundedLocal(hours: number): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1 + hours);
  return isoToLocalInput(d.toISOString());
}

function fromMaintenance(m: AdminMaintenance): Values {
  return {
    title: m.title,
    description: m.description,
    scheduledStart: isoToLocalInput(m.scheduledStart),
    scheduledEnd: isoToLocalInput(m.scheduledEnd),
    autoStart: m.autoStart,
    autoComplete: m.autoComplete,
    isPublic: m.isPublic,
    serviceIds: m.affectedServices.map((s) => s.id),
    locationIds: m.locationIds,
    notify: m.notify,
  };
}

export default function MaintenanceFormPage() {
  const { id } = useParams();
  const { t } = useTranslation('admin');
  const existing = useMaintenance(id);
  if (!id) return <MaintenanceForm key="new" />;
  if (existing.data) return <MaintenanceForm key={existing.data.id} maintenance={existing.data} />;
  return (
    <>
      <PageHeader title={t('maintenance.editTitle')} back={{ to: '/admin/maintenance', label: t('maintenance.title') }} />
      <QueryState query={existing}>{() => null}</QueryState>
    </>
  );
}

function MaintenanceForm({ maintenance }: { maintenance?: AdminMaintenance }) {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const form = useForm<Values>(() =>
    maintenance
      ? fromMaintenance(maintenance)
      : {
          title: '',
          description: '',
          scheduledStart: roundedLocal(24),
          scheduledEnd: roundedLocal(26),
          autoStart: true,
          autoComplete: true,
          isPublic: true,
          serviceIds: [],
          locationIds: [],
          notify: true,
        },
  );
  const v = form.values;
  const backTo = maintenance ? `/admin/maintenance/${maintenance.id}` : '/admin/maintenance';

  const save = useAdminMutation(
    (body: MaintenanceCreateInput) =>
      maintenance
        ? api.patch<AdminMaintenance>(`/api/admin/maintenances/${maintenance.id}`, body, { ...MAINTENANCE_DOCUMENT, id: maintenance.id })
        : api.post<AdminMaintenance>('/api/admin/maintenances', body, MAINTENANCE_DOCUMENT),
    {
      success: maintenance ? t('maintenance.saved') : t('maintenance.created'),
      onSuccess: (m) => navigate(`/admin/maintenance/${m.id}`),
      onError: form.applyServerError,
    },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const scheduledStart = localInputToIso(v.scheduledStart);
    const scheduledEnd = localInputToIso(v.scheduledEnd);
    if (!scheduledStart || !scheduledEnd) {
      form.setErrors({
        ...(scheduledStart ? {} : { scheduledStart: { key: 'validation.datetime' } }),
        ...(scheduledEnd ? {} : { scheduledEnd: { key: 'validation.datetime' } }),
      });
      return;
    }
    // The create schema also validates "end after start"; its fields are a subset of the patch
    // schema. On edit, `notify` only changes the stored flag (MaintenancePatchInput.notify).
    const body = form.validate(MaintenanceCreateInput, {
      title: v.title.trim(),
      description: v.description,
      scheduledStart,
      scheduledEnd,
      autoStart: v.autoStart,
      autoComplete: v.autoComplete,
      isPublic: v.isPublic,
      serviceIds: v.serviceIds,
      locationIds: v.locationIds,
      notify: v.notify,
    });
    if (body) save.mutate(body);
  };

  return (
    <>
      <PageHeader
        title={maintenance ? t('maintenance.editTitle') : t('maintenance.new')}
        back={{ to: backTo, label: maintenance ? maintenance.title : t('maintenance.title') }}
      />
      <form onSubmit={submit} noValidate>
        <Card>
          <div className="grid gap-5 p-4 sm:p-6 md:grid-cols-2">
            <TextField
              className="md:col-span-2"
              label={t('maintenance.fields.title')}
              value={v.title}
              onValue={(x) => form.set('title', x)}
              error={form.error('title')}
              placeholder={t('maintenance.titlePlaceholder')}
              required
              maxLength={200}
            />
            <TextAreaField
              className="md:col-span-2"
              label={t('maintenance.fields.description')}
              help={t('maintenance.descriptionHelp')}
              value={v.description}
              onValue={(x) => form.set('description', x)}
              error={form.error('description')}
              rows={4}
            />
            <DateTimeField
              label={t('maintenance.fields.scheduledStart')}
              value={v.scheduledStart}
              onValue={(x) => form.set('scheduledStart', x)}
              error={form.error('scheduledStart')}
              required
            />
            <DateTimeField
              label={t('maintenance.fields.scheduledEnd')}
              value={v.scheduledEnd}
              onValue={(x) => form.set('scheduledEnd', x)}
              error={form.error('scheduledEnd')}
              required
            />
            {!maintenance && <RetroactiveHint start={v.scheduledStart} end={v.scheduledEnd} autoStart={v.autoStart} isPublic={v.isPublic} />}
            <CheckboxField
              label={t('maintenance.fields.autoStart')}
              help={t('maintenance.autoStartHelp')}
              checked={v.autoStart}
              onChecked={(x) => form.set('autoStart', x)}
            />
            <CheckboxField
              label={t('maintenance.fields.autoComplete')}
              help={t('maintenance.autoCompleteHelp')}
              checked={v.autoComplete}
              onChecked={(x) => form.set('autoComplete', x)}
            />
            <CheckboxField
              className="md:col-span-2"
              label={t('form.isPublic')}
              help={t('maintenance.publicHelp')}
              checked={v.isPublic}
              onChecked={(x) => form.set('isPublic', x)}
            />
            <NotifySubscribersField
              className="md:col-span-2"
              context={maintenance ? 'maintenanceEdit' : 'maintenance'}
              isPublic={v.isPublic}
              checked={v.notify}
              onChecked={(x) => form.set('notify', x)}
            />
            <ServicesPicker
              label={t('maintenance.fields.services')}
              help={t('maintenance.servicesHelp')}
              value={v.serviceIds}
              onChange={(x) => form.set('serviceIds', x)}
              error={form.error('serviceIds')}
            />
            <LocationsPicker
              label={t('maintenance.fields.locations')}
              value={v.locationIds}
              onChange={(x) => form.set('locationIds', x)}
              error={form.error('locationIds')}
            />
          </div>
          <div className="flex flex-col gap-3 border-t border-border p-4 sm:flex-row sm:items-center sm:justify-end">
            <FormErrorSummary errors={form.errors} />
            <div className="flex justify-end gap-2">
              <LinkButton to={backTo}>{t('common:actions.cancel')}</LinkButton>
              <Button type="submit" variant="primary" pending={save.isPending}>
                {maintenance ? t('common:actions.save') : isPast(v.scheduledEnd) ? t('maintenance.record') : t('maintenance.schedule')}
              </Button>
            </div>
          </div>
        </Card>
      </form>
    </>
  );
}

/** Windows starting less than this before now are treated as starting now (see the server). */
const RETROACTIVE_GRACE_MS = 5 * 60_000;

function isPast(localEnd: string): boolean {
  const end = localInputToIso(localEnd);
  return end !== null && new Date(end).getTime() <= Date.now();
}

/** Explains what happens when a window that already started or ended is entered. */
function RetroactiveHint({
  start,
  end,
  autoStart,
  isPublic,
}: {
  start: string;
  end: string;
  autoStart: boolean;
  isPublic: boolean;
}) {
  const { t } = useTranslation('admin');
  const startIso = localInputToIso(start);
  const endIso = localInputToIso(end);
  if (!startIso || !endIso || endIso <= startIso) return null;
  const now = Date.now();
  const kind =
    new Date(endIso).getTime() <= now
      ? 'past'
      : autoStart && now - new Date(startIso).getTime() >= RETROACTIVE_GRACE_MS
        ? 'started'
        : null;
  if (!kind) return null;
  return (
    <p role="note" className="rounded-lg border border-status-maintenance/40 bg-status-maintenance/10 p-3 text-sm md:col-span-2">
      {t(`maintenance.retroactiveHint.${kind}`)}
      {!isPublic && <> {t('maintenance.retroactiveHint.hidden')}</>}
    </p>
  );
}
