import {
  IncidentPatchInput,
  IncidentUpdateEditInput,
  IncidentUpdateInput,
  type AdminIncident,
  type IncidentImpact,
  type IncidentStatus,
  type IncidentUpdateEntry,
} from '@openstatuspage/shared';
import { CheckCircle2, Pencil, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { api } from '../../../lib/api';
import { IncidentStatusBadge, ImpactBadge } from '../../components/badges';
import { ConfirmDialog, Dialog, useConfirm } from '../../components/Dialog';
import {
  CheckboxField,
  DateTimeField,
  FormErrorSummary,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/fields';
import { NotifySubscribersField } from '../../components/NotifySubscribersField';
import { AffectedServicesPicker, defaultImpactStatus, LocationsPicker, locationLabel, type AffectedValue } from '../../components/pickers';
import { Badge, Button, Card, IconButton, PageHeader, QueryState, StatusBadge, VisibilityBadge } from '../../components/ui';
import { isoToLocalInput, localInputToIso } from '../../lib/datetime';
import { useFormat, useOptions } from '../../lib/format';
import { useAdminMutation, useIncident, useLocations } from '../../lib/queries';
import { useForm } from '../../lib/useForm';

const toAffected = (i: AdminIncident): AffectedValue[] => i.affectedServices.map((s) => ({ serviceId: s.id, status: s.status }));

export default function IncidentDetailPage() {
  const { id } = useParams();
  const { t } = useTranslation('admin');
  const incident = useIncident(id);
  if (incident.data) return <IncidentDetail incident={incident.data} />;
  return (
    <>
      <PageHeader title={t('incidents.title')} back={{ to: '/admin/incidents', label: t('incidents.title') }} />
      <QueryState query={incident}>{() => null}</QueryState>
    </>
  );
}

function IncidentDetail({ incident }: { incident: AdminIncident }) {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [editOpen, setEditOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const locations = useLocations();
  const base = `/api/admin/incidents/${incident.id}`;

  const remove = useAdminMutation(() => api.delete(base), {
    success: t('incidents.deleted'),
    onSuccess: () => navigate('/admin/incidents', { replace: true }),
  });

  const locationNames = (locations.data ?? []).filter((l) => incident.locationIds.includes(l.id)).map(locationLabel);

  return (
    <>
      <PageHeader
        back={{ to: '/admin/incidents', label: t('incidents.title') }}
        title={incident.title}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <IncidentStatusBadge status={incident.status} />
            <ImpactBadge impact={incident.impact} />
            <VisibilityBadge isPublic={incident.isPublic} />
            {incident.source === 'auto' && <Badge tone="accent">{t('incidents.auto')}</Badge>}
          </span>
        }
        actions={
          <>
            {incident.status !== 'resolved' && (
              <Button variant="primary" icon={CheckCircle2} onClick={() => setResolveOpen(true)}>
                {t('incidents.resolve')}
              </Button>
            )}
            <Button icon={Pencil} onClick={() => setEditOpen(true)}>
              {t('common:actions.edit')}
            </Button>
            <Button
              variant="danger"
              icon={Trash2}
              onClick={() =>
                confirm.ask({
                  title: t('incidents.deleteTitle'),
                  message: t('incidents.deleteConfirm', { title: incident.title }),
                  action: () => remove.mutate(),
                })
              }
            >
              {t('common:actions.delete')}
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-6">
          <PostUpdateForm key={incident.status} incident={incident} />
          <Card title={t('incidents.timeline')}>
            <ol className="divide-y divide-border">
              {incident.updates.map((u) => (
                <UpdateItem key={u.id} incident={incident} update={u} canDelete={incident.updates.length > 1} />
              ))}
            </ol>
          </Card>
        </div>

        <Card title={t('incidents.details')} className="self-start">
          <dl className="flex flex-col gap-3 p-4 text-sm">
            <div>
              <dt className="text-xs text-muted">{t('incidents.fields.startedAt')}</dt>
              <dd>{fmt.dateTime(incident.startedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('incidents.fields.resolvedAt')}</dt>
              <dd>{incident.resolvedAt ? fmt.dateTime(incident.resolvedAt) : t('incidents.notResolved')}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('incidents.lastUpdated')}</dt>
              <dd>{fmt.dateTime(incident.updatedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('incidents.affectedServices')}</dt>
              <dd>
                {incident.affectedServices.length === 0 ? (
                  '–'
                ) : (
                  <ul className="mt-1 flex flex-col gap-1">
                    {incident.affectedServices.map((s) => (
                      <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span>{s.name}</span>
                        <StatusBadge status={s.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('incidents.affectedLocations')}</dt>
              <dd>{locationNames.length ? locationNames.join(', ') : '–'}</dd>
            </div>
          </dl>
        </Card>
      </div>

      <EditIncidentDialog incident={incident} open={editOpen} onClose={() => setEditOpen(false)} />
      <ResolveDialog incident={incident} open={resolveOpen} onClose={() => setResolveOpen(false)} />
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </>
  );
}

/** Next status suggested in the "post update" form. */
function suggestedStatus(current: IncidentStatus): IncidentStatus {
  if (current === 'investigating') return 'identified';
  if (current === 'identified') return 'monitoring';
  return 'resolved';
}

function PostUpdateForm({ incident }: { incident: AdminIncident }) {
  const { t } = useTranslation('admin');
  const opts = useOptions();
  const initial = () => ({
    status: suggestedStatus(incident.status),
    message: '',
    adjust: false,
    affectedServices: toAffected(incident),
    notify: true,
  });
  const form = useForm(initial);
  const v = form.values;

  const post = useAdminMutation(
    (body: IncidentUpdateInput) => api.post<AdminIncident>(`/api/admin/incidents/${incident.id}/updates`, body),
    {
      success: t('incidents.updatePosted'),
      onSuccess: (updated) =>
        form.setValues({
          status: suggestedStatus(updated.status),
          message: '',
          adjust: false,
          affectedServices: toAffected(updated),
          notify: true,
        }),
      onError: form.applyServerError,
    },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = form.validate(IncidentUpdateInput, {
      status: v.status,
      message: v.message.trim(),
      ...(v.adjust ? { affectedServices: v.affectedServices } : {}),
      notify: v.notify,
    });
    if (body) post.mutate(body);
  };

  return (
    <Card title={t('incidents.postUpdate')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4 p-4">
        <SelectField
          label={t('incidents.fields.status')}
          value={v.status}
          onValue={(x) => form.set('status', x)}
          options={opts.incidentStatus}
          help={v.status === 'resolved' ? t('incidents.resolveHelp') : undefined}
          error={form.error('status')}
        />
        <TextAreaField
          label={t('incidents.fields.message')}
          value={v.message}
          onValue={(x) => form.set('message', x)}
          error={form.error('message')}
          rows={4}
          required
        />
        <CheckboxField
          label={t('incidents.adjustServices')}
          help={t('incidents.adjustServicesHelp')}
          checked={v.adjust}
          onChecked={(x) => form.set('adjust', x)}
        />
        {v.adjust && (
          <AffectedServicesPicker
            value={v.affectedServices}
            onChange={(x) => form.set('affectedServices', x)}
            defaultStatus={defaultImpactStatus(incident.impact)}
            error={form.error('affectedServices')}
          />
        )}
        <NotifySubscribersField
          context="update"
          isPublic={incident.isPublic}
          checked={v.notify}
          onChecked={(x) => form.set('notify', x)}
        />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" pending={post.isPending}>
            {t('incidents.postUpdate')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function UpdateItem({ incident, update, canDelete }: { incident: AdminIncident; update: IncidentUpdateEntry; canDelete: boolean }) {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const form = useForm({ message: update.message });
  const url = `/api/admin/incidents/${incident.id}/updates/${update.id}`;

  const save = useAdminMutation((body: { message: string }) => api.patch<AdminIncident>(url, body), {
    success: t('incidents.updateSaved'),
    onSuccess: () => setEditing(false),
    onError: form.applyServerError,
  });
  const remove = useAdminMutation(() => api.delete(url), {
    success: t('incidents.updateDeleted'),
    onSuccess: () => confirm.close(),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = form.validate(IncidentUpdateEditInput, { message: form.values.message.trim() });
    if (body) save.mutate(body);
  };

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <IncidentStatusBadge status={update.status} />
          <time dateTime={update.createdAt} className="text-xs text-muted">
            {fmt.dateTime(update.createdAt)}
          </time>
        </div>
        {!editing && (
          <div className="flex gap-1">
            <IconButton
              icon={Pencil}
              label={t('incidents.editUpdate')}
              onClick={() => {
                form.setValues({ message: update.message });
                setEditing(true);
              }}
            />
            <IconButton
              icon={Trash2}
              label={t('incidents.deleteUpdate')}
              disabled={!canDelete}
              title={canDelete ? t('incidents.deleteUpdate') : t('incidents.lastUpdateHint')}
              onClick={() =>
                confirm.ask({
                  title: t('incidents.deleteUpdate'),
                  message: t('incidents.deleteUpdateConfirm'),
                  action: () => remove.mutate(),
                })
              }
            />
          </div>
        )}
      </div>
      {editing ? (
        <form onSubmit={submit} noValidate className="mt-2 flex flex-col gap-2">
          <TextAreaField
            label={t('incidents.fields.message')}
            value={form.values.message}
            onValue={(x) => form.set('message', x)}
            error={form.error('message')}
            rows={4}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setEditing(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button size="sm" type="submit" variant="primary" pending={save.isPending}>
              {t('common:actions.save')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="prose-update mt-1.5 text-sm">{update.message}</p>
      )}
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </li>
  );
}

function ResolveDialog({ incident, open, onClose }: { incident: AdminIncident; open: boolean; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const form = useForm({ message: '', notify: true });
  const resolve = useAdminMutation(
    (body: IncidentUpdateInput) => api.post<AdminIncident>(`/api/admin/incidents/${incident.id}/updates`, body),
    { success: t('incidents.resolved'), onSuccess: onClose, onError: form.applyServerError },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = form.validate(IncidentUpdateInput, {
      status: 'resolved',
      message: form.values.message.trim(),
      notify: form.values.notify,
    });
    if (body) resolve.mutate(body);
  };
  return (
    <Dialog open={open} onClose={onClose} title={t('incidents.resolveTitle')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <TextAreaField
          label={t('incidents.fields.message')}
          value={form.values.message}
          onValue={(x) => form.set('message', x)}
          error={form.error('message')}
          placeholder={t('incidents.resolveDefaultMessage')}
          rows={3}
          required
        />
        <NotifySubscribersField
          context="update"
          isPublic={incident.isPublic}
          checked={form.values.notify}
          onChecked={(x) => form.set('notify', x)}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            onClick={() => form.set('message', t('incidents.resolveDefaultMessage'))}
            disabled={form.values.message !== ''}
          >
            {t('incidents.useDefaultMessage')}
          </Button>
          <Button type="submit" variant="primary" pending={resolve.isPending}>
            {t('incidents.resolve')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface EditValues {
  title: string;
  impact: IncidentImpact;
  startedAt: string;
  resolvedAt: string;
  isPublic: boolean;
  affectedServices: AffectedValue[];
  locationIds: string[];
}

function EditIncidentDialog({ incident, open, onClose }: { incident: AdminIncident; open: boolean; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const opts = useOptions();
  const fromIncident = (): EditValues => ({
    title: incident.title,
    impact: incident.impact,
    startedAt: isoToLocalInput(incident.startedAt),
    resolvedAt: isoToLocalInput(incident.resolvedAt),
    isPublic: incident.isPublic,
    affectedServices: toAffected(incident),
    locationIds: incident.locationIds,
  });
  const form = useForm<EditValues>(fromIncident);
  const v = form.values;
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    // Reset the form with fresh data every time the dialog opens.
    setLastOpen(open);
    if (open) {
      form.setValues(fromIncident());
      form.setErrors({});
    }
  }

  const save = useAdminMutation((body: IncidentPatchInput) => api.patch<AdminIncident>(`/api/admin/incidents/${incident.id}`, body), {
    success: t('incidents.saved'),
    onSuccess: onClose,
    onError: form.applyServerError,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const startedAt = localInputToIso(v.startedAt);
    const resolvedAt = incident.status === 'resolved' ? localInputToIso(v.resolvedAt) : null;
    if (!startedAt) return form.setErrors({ startedAt: { key: 'validation.datetime' } });
    if (incident.status === 'resolved' && !resolvedAt) return form.setErrors({ resolvedAt: { key: 'validation.datetime' } });
    const body = form.validate(IncidentPatchInput, {
      title: v.title.trim(),
      impact: v.impact,
      startedAt,
      ...(incident.status === 'resolved' ? { resolvedAt } : {}),
      isPublic: v.isPublic,
      affectedServices: v.affectedServices,
      locationIds: v.locationIds,
    });
    if (body) save.mutate(body);
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('incidents.editTitle')} wide>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <TextField label={t('incidents.fields.title')} value={v.title} onValue={(x) => form.set('title', x)} error={form.error('title')} required />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label={t('incidents.fields.impact')}
            value={v.impact}
            onValue={(x) => form.set('impact', x)}
            options={opts.incidentImpact}
          />
          <div className="flex items-end">
            <CheckboxField label={t('form.isPublic')} checked={v.isPublic} onChecked={(x) => form.set('isPublic', x)} />
          </div>
          <DateTimeField
            label={t('incidents.fields.startedAt')}
            value={v.startedAt}
            onValue={(x) => form.set('startedAt', x)}
            error={form.error('startedAt')}
            required
          />
          {incident.status === 'resolved' && (
            <DateTimeField
              label={t('incidents.fields.resolvedAt')}
              value={v.resolvedAt}
              onValue={(x) => form.set('resolvedAt', x)}
              error={form.error('resolvedAt')}
              required
            />
          )}
        </div>
        <AffectedServicesPicker
          value={v.affectedServices}
          onChange={(x) => form.set('affectedServices', x)}
          defaultStatus={defaultImpactStatus(v.impact)}
          error={form.error('affectedServices')}
        />
        <LocationsPicker
          label={t('incidents.affectedLocations')}
          value={v.locationIds}
          onChange={(x) => form.set('locationIds', x)}
          error={form.error('locationIds')}
        />
        <FormErrorSummary errors={form.errors} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" variant="primary" pending={save.isPending}>
            {t('common:actions.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
