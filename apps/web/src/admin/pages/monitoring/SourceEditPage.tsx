import {
  CONFIGURABLE_SOURCE_TYPES,
  MonitorSourceInput,
  SECRET_MASK,
  type AdminMonitorSource,
  type ConfigurableSourceType,
} from '@openstatuspage/shared';
import { Combine, KeyRound, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { api } from '../../../lib/api';
import { CopyField } from '../../components/CopyField';
import { ConfirmDialog, useConfirm } from '../../components/Dialog';
import { CheckboxField, FormErrorSummary, SelectField, TextAreaField, TextField } from '../../components/fields';
import { IngestTokenDialog, typedIngestUrl } from '../../components/IngestTokenDialog';
import { SourcePollStatus } from '../../components/SourcePollStatus';
import { Button, Card, LinkButton, PageHeader, QueryState } from '../../components/ui';
import { useAdminMutation, useSource } from '../../lib/queries';
import {
  emptySourceForm,
  hasStoredSecret,
  isBundleSource,
  isPullType,
  sourceFormToPayload,
  sourceToForm,
  type SourceFormValues,
} from '../../lib/source-form';
import { useForm } from '../../lib/useForm';
import { useSourceActions } from '../../lib/useSourceActions';

export default function SourceEditPage() {
  const { id } = useParams();
  const { t } = useTranslation('admin');
  const source = useSource(id);
  if (!id) return <SourceForm key="new" />;
  if (source.data && isBundleSource(source.data)) return <BundleSourceInfo source={source.data} />;
  if (source.data) return <SourceForm key={source.data.id} source={source.data} />;
  return (
    <>
      <PageHeader title={t('sources.title')} back={{ to: '/admin/monitoring', label: t('sources.title') }} />
      <QueryState query={source}>{() => null}</QueryState>
    </>
  );
}

/** The built-in source of the check bundles has nothing to configure. */
function BundleSourceInfo({ source }: { source: AdminMonitorSource }) {
  const { t } = useTranslation('admin');
  return (
    <>
      <PageHeader
        back={{ to: '/admin/monitoring', label: t('sources.title') }}
        title={source.name}
        description={t('sources.types.bundle')}
        actions={
          <LinkButton to="/admin/monitoring/bundles" variant="primary" icon={Combine}>
            {t('bundles.manage')}
          </LinkButton>
        }
      />
      <Card>
        <div className="flex flex-col gap-3 p-4 text-sm sm:p-6">
          <p>{t('bundles.sourceInfo')}</p>
          <p className="text-muted">{t('sources.checkCount', { count: source.checkCount })}</p>
        </div>
      </Card>
    </>
  );
}

type Created = AdminMonitorSource & { ingestToken: string };

function SourceForm({ source }: { source?: AdminMonitorSource }) {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const confirm = useConfirm();
  const actions = useSourceActions();
  const form = useForm<SourceFormValues>(() => (source ? sourceToForm(source) : emptySourceForm()));
  const v = form.values;
  const [created, setCreated] = useState<Created | null>(null);

  const save = useAdminMutation(
    (body: MonitorSourceInput) =>
      source
        ? api.put<AdminMonitorSource>(`/api/admin/monitor-sources/${source.id}`, body)
        : api.post<Created>('/api/admin/monitor-sources', body),
    {
      success: source ? t('sources.saved') : t('sources.created'),
      onSuccess: (s) => {
        if (source) form.setValues(sourceToForm(s));
        else setCreated(s as Created);
      },
      onError: form.applyServerError,
    },
  );
  const remove = useAdminMutation(() => api.delete(`/api/admin/monitor-sources/${source!.id}`), {
    success: t('sources.deleted'),
    onSuccess: () => navigate('/admin/monitoring', { replace: true }),
  });

  const changeType = (type: ConfigurableSourceType) => {
    // Stored secrets belong to the stored type; a new type needs new credentials.
    form.setValues((prev) => ({ ...prev, type, password: '', apiKey: '' }));
    form.setErrors({});
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = form.validate(MonitorSourceInput, sourceFormToPayload(v, source));
    if (body) save.mutate(body);
  };

  const secretProps = (key: 'password' | 'apiKey') => {
    const stored = hasStoredSecret(source, key, v.type);
    return {
      type: 'password' as const,
      autoComplete: 'new-password',
      value: v[key],
      onValue: (x: string) => form.set(key, x),
      placeholder: stored ? `${SECRET_MASK} (${t('sources.secretUnchanged')})` : undefined,
      help: stored ? t('sources.secretHelpStored') : t('sources.secretHelp'),
      error: form.error(`config.${key}`),
      required: !stored,
    };
  };

  const pull = isPullType(v.type);

  return (
    <>
      <PageHeader
        back={{ to: '/admin/monitoring', label: t('sources.title') }}
        title={source ? source.name : t('sources.new')}
        description={source ? t(`sources.types.${source.type}`) : t('sources.newIntro')}
        actions={
          source && (
            <>
              {isPullType(source.type) && (
                <>
                  <Button icon={PlugZap} pending={actions.test.isPending} onClick={() => actions.test.mutate(source)}>
                    {t('sources.test')}
                  </Button>
                  <Button icon={RefreshCw} pending={actions.poll.isPending} onClick={() => actions.poll.mutate(source)}>
                    {t('sources.pollNow')}
                  </Button>
                </>
              )}
              <Button
                icon={KeyRound}
                onClick={() =>
                  confirm.ask({
                    title: t('sources.rotateToken'),
                    message: t('sources.rotateConfirm', { name: source.name }),
                    confirmLabel: t('sources.rotate'),
                    action: () => {
                      confirm.close();
                      actions.rotate.mutate(source);
                    },
                  })
                }
              >
                {t('sources.rotateToken')}
              </Button>
              <Button
                variant="danger"
                icon={Trash2}
                onClick={() =>
                  confirm.ask({
                    title: t('sources.deleteTitle'),
                    message: t('sources.deleteConfirm', { name: source.name, count: source.checkCount }),
                    action: () => remove.mutate(),
                  })
                }
              >
                {t('common:actions.delete')}
              </Button>
            </>
          )
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <form onSubmit={submit} noValidate>
          <Card>
            <div className="grid gap-5 p-4 sm:p-6 md:grid-cols-2">
              <TextField
                label={t('sources.fields.name')}
                value={v.name}
                onValue={(x) => form.set('name', x)}
                error={form.error('name')}
                required
                help={t('sources.nameHelp')}
              />
              <SelectField<ConfigurableSourceType>
                label={t('sources.fields.type')}
                value={v.type}
                onValue={changeType}
                options={CONFIGURABLE_SOURCE_TYPES.map((type) => ({ value: type, label: t(`sources.types.${type}`) }))}
                help={t(`sources.typeHelp.${v.type}`)}
              />
              {v.type !== 'webhook' && (
                <TextField
                  className="md:col-span-2"
                  label={t('sources.fields.baseUrl')}
                  type="url"
                  value={v.baseUrl}
                  onValue={(x) => form.set('baseUrl', x)}
                  error={form.error('config.baseUrl')}
                  placeholder={t(`sources.baseUrlPlaceholder.${v.type}`)}
                  help={t('sources.baseUrlHelp')}
                  required
                />
              )}
              {v.type === 'icinga2' && (
                <>
                  <TextField
                    label={t('sources.fields.username')}
                    value={v.username}
                    onValue={(x) => form.set('username', x)}
                    error={form.error('config.username')}
                    autoComplete="off"
                    help={t('sources.usernameHelp')}
                    required
                  />
                  <TextField label={t('sources.fields.password')} {...secretProps('password')} />
                  <TextAreaField
                    className="md:col-span-2"
                    label={t('sources.fields.filter')}
                    value={v.filter}
                    onValue={(x) => form.set('filter', x)}
                    error={form.error('config.filter')}
                    rows={2}
                    placeholder={'"customer-facing" in service.groups'}
                    help={t('sources.filterHelp')}
                    spellCheck={false}
                  />
                </>
              )}
              {(v.type === 'uptimekuma' || v.type === 'openitcockpit') && (
                <TextField label={t('sources.fields.apiKey')} {...secretProps('apiKey')} className="md:col-span-2" />
              )}
              {pull && (
                <TextField
                  label={t('sources.fields.pollInterval')}
                  type="number"
                  inputMode="numeric"
                  min={10}
                  max={86400}
                  value={v.pollIntervalSeconds}
                  onValue={(x) => form.set('pollIntervalSeconds', x)}
                  error={form.error('pollIntervalSeconds')}
                  help={t('sources.pollIntervalHelp')}
                />
              )}
              <div className="flex flex-col gap-3 md:col-span-2">
                <CheckboxField
                  label={t('sources.fields.enabled')}
                  help={t('sources.enabledHelp')}
                  checked={v.enabled}
                  onChecked={(x) => form.set('enabled', x)}
                />
                {(v.type === 'icinga2' || v.type === 'openitcockpit') && (
                  <CheckboxField
                    label={t('sources.fields.includeHosts')}
                    help={t('sources.includeHostsHelp')}
                    checked={v.includeHosts}
                    onChecked={(x) => form.set('includeHosts', x)}
                  />
                )}
                {pull && (
                  <CheckboxField
                    label={t('sources.fields.verifyTls')}
                    help={t('sources.verifyTlsHelp')}
                    checked={v.verifyTls}
                    onChecked={(x) => form.set('verifyTls', x)}
                  />
                )}
              </div>
              {v.type === 'webhook' && <p className="text-sm text-muted md:col-span-2">{t('sources.webhookIntro')}</p>}
            </div>
            <div className="flex flex-col gap-3 border-t border-border p-4 sm:flex-row sm:items-center sm:justify-end">
              <FormErrorSummary errors={form.errors} />
              <div className="flex justify-end gap-2">
                <LinkButton to="/admin/monitoring">{t('common:actions.cancel')}</LinkButton>
                <Button type="submit" variant="primary" pending={save.isPending}>
                  {source ? t('common:actions.save') : t('common:actions.create')}
                </Button>
              </div>
            </div>
          </Card>
        </form>

        {source && (
          <div className="flex flex-col gap-4 self-start">
            <Card title={t('sources.status')}>
              <div className="flex flex-col gap-3 p-4 text-sm">
                <SourcePollStatus source={source} />
                <p className="text-muted">{t('sources.checkCount', { count: source.checkCount })}</p>
                <LinkButton to={`/admin/monitoring/checks?sourceId=${source.id}`} size="sm">
                  {t('sources.viewChecks')}
                </LinkButton>
              </div>
            </Card>
            <Card title={t('ingest.pushTitle')}>
              <div className="flex flex-col gap-3 p-4">
                <CopyField label={t('ingest.url')} value={typedIngestUrl(source.ingestUrl, source.type)} />
                <p className="text-xs text-muted">{t('ingest.tokenHidden')}</p>
              </div>
            </Card>
          </div>
        )}
      </div>

      {created && (
        <IngestTokenDialog
          open
          type={created.type}
          ingestUrl={created.ingestUrl}
          token={created.ingestToken}
          onClose={() => {
            const id = created.id;
            setCreated(null);
            void navigate(`/admin/monitoring/${id}`, { replace: true });
          }}
        />
      )}
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
