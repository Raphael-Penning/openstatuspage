import {
  ServiceInput,
  type AdminService,
  type AggregationMode,
  type ServiceStatus,
  type StatusMode,
} from '@openstatuspage/shared';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Info, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { api } from '../../../lib/api';
import { CheckLinksEditor } from '../../components/CheckLinksEditor';
import { ConfirmDialog, useConfirm } from '../../components/Dialog';
import { ServiceHistoryCompare } from '../../components/ServiceHistoryCompare';
import { CheckboxField, FormErrorSummary, SelectField, TextAreaField, TextField } from '../../components/fields';
import { LocationsPicker } from '../../components/pickers';
import { Button, Card, LinkButton, PageHeader, QueryState, Spinner, StatusBadge } from '../../components/ui';
import { nextSortOrder } from '../../lib/ordering';
import { useOptions } from '../../lib/format';
import { keys, useAdminMutation, useGroups, useService, useServices, type PreviewResult } from '../../lib/queries';
import { emptyServiceForm, serviceFormToPayload, serviceToForm, type ServiceFormValues } from '../../lib/service-form';
import { useDebounced } from '../../lib/useDebounced';
import { useForm } from '../../lib/useForm';
import { useIsAdmin } from '../../session';

export default function ServiceEditPage() {
  const { id } = useParams();
  const { t } = useTranslation('admin');
  const service = useService(id);
  const services = useServices();
  if (!id) {
    if (!services.data) return <QueryState query={services}>{() => null}</QueryState>;
    return <ServiceBuilder key="new" siblings={services.data} />;
  }
  if (service.data) return <ServiceBuilder key={service.data.id} service={service.data} />;
  return (
    <>
      <PageHeader title={t('services.title')} back={{ to: '/admin/services', label: t('services.title') }} />
      <QueryState query={service}>{() => null}</QueryState>
    </>
  );
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card title={title}>
      <div className="flex flex-col gap-5 p-4 sm:p-6">
        {description && <p className="-mt-1 text-sm text-muted">{description}</p>}
        {children}
      </div>
    </Card>
  );
}

function RadioCard<T extends string>({
  name,
  value,
  current,
  onChange,
  title,
  description,
  disabled,
}: {
  name: string;
  value: T;
  current: T;
  onChange: (v: T) => void;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  const id = `${name}-${value}`;
  return (
    <label
      htmlFor={id}
      className={clsx(
        'flex cursor-pointer gap-3 rounded-lg border p-3 transition',
        current === value ? 'border-accent bg-accent/5' : 'border-border hover:bg-surface-2',
        disabled && 'cursor-default opacity-70',
      )}
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={current === value}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted">{description}</span>
      </span>
    </label>
  );
}

function ServiceBuilder({ service, siblings = [] }: { service?: AdminService; siblings?: AdminService[] }) {
  const { t } = useTranslation('admin');
  const isAdmin = useIsAdmin();
  const readOnly = !isAdmin;
  const navigate = useNavigate();
  const confirm = useConfirm();
  const opts = useOptions();
  const groups = useGroups();
  const form = useForm<ServiceFormValues>(() => (service ? serviceToForm(service) : emptyServiceForm()));
  const v = form.values;
  const [touchedSlug, setTouchedSlug] = useState(Boolean(service));

  const save = useAdminMutation(
    (body: ServiceInput) =>
      service ? api.put<AdminService>(`/api/admin/services/${service.id}`, body) : api.post<AdminService>('/api/admin/services', body),
    {
      success: service ? t('services.saved') : t('services.created'),
      onSuccess: (s) => {
        if (!service) void navigate(`/admin/services/${s.id}`, { replace: true });
        else form.setValues(serviceToForm(s));
      },
      onError: form.applyServerError,
    },
  );
  const remove = useAdminMutation(() => api.delete(`/api/admin/services/${service!.id}`), {
    success: t('services.deleted'),
    onSuccess: () => navigate('/admin/services', { replace: true }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
    // New services are appended at the end of their group.
    const sortOrder = service ? v.sortOrder : nextSortOrder(siblings.filter((s) => (s.groupId ?? '') === v.groupId));
    const body = form.validate(ServiceInput, serviceFormToPayload({ ...v, sortOrder, slug: touchedSlug ? v.slug : '' }));
    if (body) save.mutate(body);
  };

  const groupOptions = useMemo(
    () => [{ value: '', label: t('services.noGroup') }, ...(groups.data ?? []).map((g) => ({ value: g.id, label: g.name }))],
    [groups.data, t],
  );

  return (
    <>
      <PageHeader
        back={{ to: '/admin/services', label: t('services.title') }}
        title={service ? service.name : t('services.new')}
        description={service ? <StatusBadge status={service.status} /> : t('services.builderIntro')}
        actions={
          service &&
          isAdmin && (
            <Button
              variant="danger"
              icon={Trash2}
              onClick={() =>
                confirm.ask({
                  title: t('services.deleteTitle'),
                  message: t('services.deleteConfirm', { name: service.name }),
                  action: () => remove.mutate(),
                })
              }
            >
              {t('common:actions.delete')}
            </Button>
          )
        }
      />
      {readOnly && (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted">
          <Info aria-hidden className="size-4 shrink-0" />
          {t('readOnlyNotice')}
        </p>
      )}

      <form onSubmit={submit} noValidate>
        <fieldset disabled={readOnly} className="contents">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="flex min-w-0 flex-col gap-6">
              <Section title={t('services.sections.basics')}>
                <div className="grid gap-5 md:grid-cols-2">
                  <TextField
                    label={t('services.fields.name')}
                    value={v.name}
                    onValue={(x) => form.set('name', x)}
                    error={form.error('name')}
                    required
                    maxLength={120}
                  />
                  <TextField
                    label={t('form.slug')}
                    value={v.slug}
                    onValue={(x) => {
                      setTouchedSlug(true);
                      form.set('slug', x);
                    }}
                    error={form.error('slug')}
                    help={t('form.slugHelp')}
                    placeholder={t('form.slugPlaceholder')}
                    maxLength={80}
                  />
                  <TextAreaField
                    className="md:col-span-2"
                    label={t('services.fields.description')}
                    help={t('services.descriptionHelp')}
                    value={v.description}
                    onValue={(x) => form.set('description', x)}
                    error={form.error('description')}
                    rows={2}
                  />
                  <SelectField
                    label={t('services.fields.kind')}
                    value={v.kind}
                    onValue={(x) => form.set('kind', x)}
                    options={[
                      { value: 'service', label: t('common:kind.service') },
                      { value: 'site', label: t('common:kind.site') },
                    ]}
                    help={t('services.kindHelp')}
                  />
                  {v.kind === 'site' ? (
                    <TextField
                      label={t('services.fields.url')}
                      type="url"
                      value={v.url}
                      onValue={(x) => form.set('url', x)}
                      error={form.error('url')}
                      placeholder="https://www.example.com"
                      help={t('services.urlHelp')}
                    />
                  ) : (
                    <div className="hidden md:block" />
                  )}
                  <SelectField
                    label={t('services.fields.group')}
                    value={v.groupId}
                    onValue={(x) => form.set('groupId', x)}
                    options={groupOptions}
                    error={form.error('groupId')}
                  />
                  <div className="flex items-end">
                    <CheckboxField
                      label={t('form.isPublic')}
                      help={t('services.publicHelp')}
                      checked={v.isPublic}
                      onChecked={(x) => form.set('isPublic', x)}
                    />
                  </div>
                </div>
                <LocationsPicker
                  label={t('services.fields.locations')}
                  help={t('services.locationsHelp')}
                  value={v.locationIds}
                  onChange={(x) => form.set('locationIds', x)}
                  error={form.error('locationIds')}
                  disabled={readOnly}
                />
              </Section>

              <Section title={t('services.sections.status')} description={t('services.statusIntro')}>
                <div role="radiogroup" aria-label={t('services.fields.statusMode')} className="grid gap-3 md:grid-cols-2">
                  {(['auto', 'manual'] as StatusMode[]).map((mode) => (
                    <RadioCard
                      key={mode}
                      name="statusMode"
                      value={mode}
                      current={v.statusMode}
                      onChange={(x) => form.set('statusMode', x)}
                      title={t(`services.statusMode.${mode}`)}
                      description={t(`services.statusModeHelp.${mode}`)}
                      disabled={readOnly}
                    />
                  ))}
                </div>
                {v.statusMode === 'manual' && (
                  <SelectField<ServiceStatus>
                    label={t('services.fields.manualStatus')}
                    value={v.manualStatus}
                    onValue={(x) => form.set('manualStatus', x)}
                    options={opts.serviceStatus}
                    help={t('services.manualStatusHelp')}
                  />
                )}
                <div role="radiogroup" aria-label={t('services.fields.aggregation')} className="flex flex-col gap-2">
                  <p className="text-sm font-medium">{t('services.fields.aggregation')}</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    {(['worst', 'quorum'] as AggregationMode[]).map((mode) => (
                      <RadioCard
                        key={mode}
                        name="aggregation"
                        value={mode}
                        current={v.aggregation}
                        onChange={(x) => form.set('aggregation', x)}
                        title={t(`services.aggregation.${mode}`)}
                        description={t(`services.aggregationHelp.${mode}`)}
                        disabled={readOnly}
                      />
                    ))}
                  </div>
                </div>
              </Section>

              <Section title={t('services.sections.checks')} description={t('services.checksIntro')}>
                <CheckLinksEditor
                  links={v.checks}
                  onChange={(x) => form.set('checks', x)}
                  readOnly={readOnly}
                  error={form.error('checks')}
                />
              </Section>
            </div>

            <div className="flex flex-col gap-4 xl:sticky xl:top-6 xl:self-start">
              <PreviewCard values={v} service={service} />
              {!readOnly && (
                <Card>
                  <div className="flex flex-col gap-3 p-4">
                    <FormErrorSummary errors={form.errors} />
                    <Button type="submit" variant="primary" pending={save.isPending} className="w-full">
                      {service ? t('common:actions.save') : t('services.create')}
                    </Button>
                    <LinkButton to="/admin/services" className="w-full">
                      {t('common:actions.cancel')}
                    </LinkButton>
                  </div>
                </Card>
              )}
            </div>
          </div>
        </fieldset>
      </form>
      {service && (
        <div className="mt-6">
          <ServiceHistoryCompare serviceId={service.id} />
        </div>
      )}
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </>
  );
}

/** Live "resulting status" preview of the (unsaved) configuration. */
function PreviewCard({ values, service }: { values: ServiceFormValues; service?: AdminService }) {
  const { t } = useTranslation('admin');
  const isAdmin = useIsAdmin();
  const payload = useMemo(() => serviceFormToPayload({ ...values, name: values.name || 'preview', slug: '' }), [values]);
  const debounced = useDebounced(payload, 400);
  const parsed = ServiceInput.safeParse(debounced);

  // Admins preview the unsaved configuration; editors see the stored configuration.
  const unsaved = useQuery({
    queryKey: [...keys.services, 'preview', debounced],
    queryFn: () => api.post<PreviewResult>('/api/admin/services/preview', debounced),
    enabled: isAdmin && parsed.success,
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });
  const stored = useQuery({
    queryKey: [...keys.services, 'preview-stored', service?.id],
    queryFn: () => api.get<PreviewResult>(`/api/admin/services/${service!.id}/preview`),
    enabled: !isAdmin && Boolean(service),
  });
  const result = isAdmin ? unsaved : stored;
  const monitorStatus = result.data?.monitorStatus;
  const effective: ServiceStatus | undefined =
    values.statusMode === 'manual' ? values.manualStatus : monitorStatus;

  return (
    <Card title={t('preview.title')}>
      <div className="flex flex-col gap-3 p-4 text-sm" aria-live="polite">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted">{t('preview.monitorStatus')}</span>
          {result.isFetching && !monitorStatus ? (
            <Spinner className="size-4" />
          ) : monitorStatus ? (
            <StatusBadge status={monitorStatus} />
          ) : (
            <span className="text-muted">–</span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <span className="font-medium">{t('preview.resulting')}</span>
          {effective ? <StatusBadge status={effective} /> : <span className="text-muted">–</span>}
        </div>
        <p className="text-xs text-muted">
          {values.statusMode === 'manual' ? t('preview.manualHint') : isAdmin ? t('preview.hint') : t('preview.storedHint')}
          {values.checks.length === 0 && values.statusMode === 'auto' && <> {t('preview.noChecks')}</>}
        </p>
        {service && (
          <p className="text-xs text-muted">
            {t('preview.currentPublic')} <StatusBadge status={service.status} />
          </p>
        )}
      </div>
    </Card>
  );
}
