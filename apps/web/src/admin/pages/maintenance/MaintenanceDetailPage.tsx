import {
  MaintenanceUpdateInput,
  type AdminMaintenance,
  type MaintenanceStatus,
  type MaintenanceUpdateEntry,
} from '@openstatuspage/shared';
import { Ban, BellOff, CheckCircle2, Pencil, Play, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { api } from '../../../lib/api';
import { MaintenanceStatusBadge } from '../../components/badges';
import { ConfirmDialog, Dialog, useConfirm } from '../../components/Dialog';
import { SelectField, TextAreaField } from '../../components/fields';
import { NotifySubscribersField } from '../../components/NotifySubscribersField';
import { locationLabel } from '../../components/pickers';
import { Badge, Button, Card, LinkButton, PageHeader, QueryState, VisibilityBadge } from '../../components/ui';
import { useFormat, useOptions } from '../../lib/format';
import { postUpdateDefaults, transitionDefaults } from '../../lib/maintenance-updates';
import { useAdminMutation, useLocations, useMaintenance } from '../../lib/queries';
import { useForm } from '../../lib/useForm';

export default function MaintenanceDetailPage() {
  const { id } = useParams();
  const { t } = useTranslation('admin');
  const query = useMaintenance(id);
  if (query.data) return <MaintenanceDetail maintenance={query.data} />;
  return (
    <>
      <PageHeader title={t('maintenance.title')} back={{ to: '/admin/maintenance', label: t('maintenance.title') }} />
      <QueryState query={query}>{() => null}</QueryState>
    </>
  );
}

/** Message shown for an update; automatic updates have an empty message. */
export function useUpdateMessage() {
  const { t } = useTranslation('admin');
  return (u: MaintenanceUpdateEntry) =>
    u.message ||
    (u.status === 'in_progress' || u.status === 'completed'
      ? t(`common:maintenanceAutoMessage.${u.status}`)
      : t(`maintenance.defaultMessage.${u.status}`));
}

const isOpen = (s: MaintenanceStatus) => s === 'scheduled' || s === 'in_progress';

function MaintenanceDetail({ maintenance: m }: { maintenance: AdminMaintenance }) {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const locations = useLocations();
  const message = useUpdateMessage();
  const [transition, setTransition] = useState<MaintenanceStatus | null>(null);

  const remove = useAdminMutation(() => api.delete(`/api/admin/maintenances/${m.id}`), {
    success: t('maintenance.deleted'),
    onSuccess: () => navigate('/admin/maintenance', { replace: true }),
  });
  const locationNames = (locations.data ?? []).filter((l) => m.locationIds.includes(l.id)).map(locationLabel);

  return (
    <>
      <PageHeader
        back={{ to: '/admin/maintenance', label: t('maintenance.title') }}
        title={m.title}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <MaintenanceStatusBadge status={m.status} />
            <VisibilityBadge isPublic={m.isPublic} />
            {m.retroactive && <Badge tone="info">{t('maintenance.retroactive')}</Badge>}
            {m.autoStart && <Badge>{t('maintenance.fields.autoStart')}</Badge>}
            {m.autoComplete && <Badge>{t('maintenance.fields.autoComplete')}</Badge>}
            {!m.notify && (
              <Badge>
                <BellOff aria-hidden className="size-3" />
                {t('notify.off')}
              </Badge>
            )}
          </span>
        }
        actions={
          <>
            {m.status === 'scheduled' && (
              <Button variant="primary" icon={Play} onClick={() => setTransition('in_progress')}>
                {t('maintenance.start')}
              </Button>
            )}
            {m.status === 'in_progress' && (
              <Button variant="primary" icon={CheckCircle2} onClick={() => setTransition('completed')}>
                {t('maintenance.complete')}
              </Button>
            )}
            {isOpen(m.status) && (
              <Button icon={Ban} onClick={() => setTransition('cancelled')}>
                {t('maintenance.cancel')}
              </Button>
            )}
            <LinkButton to={`/admin/maintenance/${m.id}/edit`} icon={Pencil}>
              {t('common:actions.edit')}
            </LinkButton>
            <Button
              variant="danger"
              icon={Trash2}
              onClick={() =>
                confirm.ask({
                  title: t('maintenance.deleteTitle'),
                  message: t('maintenance.deleteConfirm', { title: m.title }),
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
          {m.description && (
            <Card title={t('maintenance.fields.description')}>
              <p className="prose-update p-4 text-sm">{m.description}</p>
            </Card>
          )}
          {/* Remount when the status or the stored notify flag changes, so the defaults follow them. */}
          <PostUpdateForm key={`${m.status}:${m.notify}`} maintenance={m} />
          <Card title={t('maintenance.timeline')}>
            <ol className="divide-y divide-border">
              {m.updates.map((u) => (
                <li key={u.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <MaintenanceStatusBadge status={u.status} />
                    <time dateTime={u.createdAt} className="text-xs text-muted">
                      {fmt.dateTime(u.createdAt)}
                    </time>
                  </div>
                  <p className={`prose-update mt-1.5 text-sm ${u.message ? '' : 'text-muted italic'}`}>{message(u)}</p>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <Card title={t('maintenance.details')} className="self-start">
          <dl className="flex flex-col gap-3 p-4 text-sm">
            <div>
              <dt className="text-xs text-muted">{t('maintenance.fields.scheduledStart')}</dt>
              <dd>{fmt.dateTime(m.scheduledStart)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('maintenance.fields.scheduledEnd')}</dt>
              <dd>{fmt.dateTime(m.scheduledEnd)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('maintenance.actualStart')}</dt>
              <dd>{fmt.dateTime(m.actualStart)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('maintenance.actualEnd')}</dt>
              <dd>{fmt.dateTime(m.actualEnd)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('maintenance.fields.services')}</dt>
              <dd>{m.affectedServices.length ? m.affectedServices.map((s) => s.name).join(', ') : '–'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('maintenance.fields.locations')}</dt>
              <dd>{locationNames.length ? locationNames.join(', ') : '–'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('notify.label')}</dt>
              <dd>
                {m.notify ? t('form.yes') : t('form.no')}
                {m.reminderSentAt && (
                  <span className="block text-xs text-muted">{t('notify.reminderSent', { date: fmt.dateTime(m.reminderSentAt) })}</span>
                )}
              </dd>
            </div>
          </dl>
        </Card>
      </div>

      <TransitionDialog maintenance={m} status={transition} onClose={() => setTransition(null)} />
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </>
  );
}

function usePostUpdate(
  maintenance: AdminMaintenance,
  onDone: (stored: AdminMaintenance) => void,
  onError: (e: unknown) => boolean,
) {
  const { t } = useTranslation('admin');
  return useAdminMutation(
    (body: MaintenanceUpdateInput) => api.post<AdminMaintenance>(`/api/admin/maintenances/${maintenance.id}/updates`, body),
    { success: t('maintenance.updatePosted'), onSuccess: onDone, onError },
  );
}

function PostUpdateForm({ maintenance }: { maintenance: AdminMaintenance }) {
  const { t } = useTranslation('admin');
  const opts = useOptions();
  // "Notify subscribers" starts from the maintenance's stored flag (incidents default to on).
  const form = useForm(() => postUpdateDefaults(maintenance));
  const post = usePostUpdate(
    maintenance,
    (stored) => form.setValues((v) => ({ ...v, message: '', notify: postUpdateDefaults(stored).notify })),
    form.applyServerError,
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = form.validate(MaintenanceUpdateInput, {
      status: form.values.status,
      message: form.values.message.trim(),
      notify: form.values.notify,
    });
    if (body) post.mutate(body);
  };

  return (
    <Card title={t('maintenance.postUpdate')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4 p-4">
        <SelectField
          label={t('maintenance.fields.status')}
          value={form.values.status}
          onValue={(x) => form.set('status', x)}
          options={opts.maintenanceStatus}
          help={t('maintenance.statusHelp')}
        />
        <TextAreaField
          label={t('maintenance.fields.message')}
          value={form.values.message}
          onValue={(x) => form.set('message', x)}
          error={form.error('message')}
          rows={3}
          required
        />
        <NotifySubscribersField
          context="update"
          isPublic={maintenance.isPublic}
          checked={form.values.notify}
          onChecked={(x) => form.set('notify', x)}
        />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" pending={post.isPending}>
            {t('maintenance.postUpdate')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Start / complete / cancel with a message (pre-filled with a localized default). */
function TransitionDialog({
  maintenance,
  status,
  onClose,
}: {
  maintenance: AdminMaintenance;
  status: MaintenanceStatus | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const form = useForm(() => transitionDefaults(maintenance, ''));
  const [lastStatus, setLastStatus] = useState(status);
  if (status !== lastStatus) {
    setLastStatus(status);
    if (status) {
      form.setValues(transitionDefaults(maintenance, t(`maintenance.transitionMessage.${status}`)));
      form.setErrors({});
    }
  }
  const post = usePostUpdate(maintenance, onClose, form.applyServerError);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!status) return;
    const body = form.validate(MaintenanceUpdateInput, { status, message: form.values.message.trim(), notify: form.values.notify });
    if (body) post.mutate(body);
  };

  return (
    <Dialog open={status !== null} onClose={onClose} title={status ? t(`maintenance.transitionTitle.${status}`) : ''}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <TextAreaField
          label={t('maintenance.fields.message')}
          value={form.values.message}
          onValue={(x) => form.set('message', x)}
          error={form.error('message')}
          rows={3}
          required
        />
        <NotifySubscribersField
          context="update"
          isPublic={maintenance.isPublic}
          checked={form.values.notify}
          onChecked={(x) => form.set('notify', x)}
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" variant={status === 'cancelled' ? 'danger' : 'primary'} pending={post.isPending}>
            {status ? t(`maintenance.transitionConfirm.${status}`) : ''}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
