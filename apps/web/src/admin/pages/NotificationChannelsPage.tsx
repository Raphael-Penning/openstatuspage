/**
 * /admin/notifications (admins only): webhook and SMS notifications.
 *
 * - Visitor channels and limits (what the public subscribe page offers).
 * - Webhooks of the team (Discord, Slack, Teams, generic JSON): scope, test
 *   button, delivery log, automatic disabling after repeated failures. URLs and
 *   header values are write-only; the signing secret is shown once.
 * - The SMS provider (request template with presets, write-only credentials,
 *   monthly budget) and the on-call SMS recipients.
 */
import {
  ChannelSettingsInput,
  SmsProviderInput,
  SmsRecipientInput,
  WebhookInput,
  WEBHOOK_KINDS,
  type AdminSmsProvider,
  type AdminSmsRecipient,
  type AdminWebhook,
  type ChannelSettings,
  type HeaderInput,
  type Paginated,
  type SmsPreset,
  type SmsProviderInput as SmsProviderBody,
  type WebhookDelivery,
  type WebhookKind,
} from '@openstatuspage/shared';
import { useQuery } from '@tanstack/react-query';
import { History, Pencil, Plus, Send, Trash2, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { CopyField } from '../components/CopyField';
import { ConfirmDialog, Dialog, useConfirm } from '../components/Dialog';
import { CheckboxField, FormErrorSummary, SelectField, TextAreaField, TextField } from '../components/fields';
import { ServicesPicker } from '../components/pickers';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader, Pagination, QueryState, Table, td, th, tr } from '../components/ui';
import { useFormat } from '../lib/format';
import { useAdminMutation } from '../lib/queries';
import { useForm } from '../lib/useForm';

const WEBHOOK_DOCUMENT = { type: 'webhooks', relationships: { serviceIds: 'services' } };
/** Placeholders of the SMS template (shown literally, not interpolated by i18next). */
const PLACEHOLDERS = ['to', 'to_digits', 'from', 'text', 'username', 'password', 'basic_auth'].map((p) => `{{${p}}}`).join(', ');
const CREDENTIAL_PLACEHOLDERS = ['username', 'password', 'basic_auth'].map((p) => `{{${p}}}`).join(', ');
const RECIPIENT_DOCUMENT ={ type: 'sms-recipients', relationships: { serviceIds: 'services' } };

const useChannelQuery = <T,>(key: string, path: string) =>
  useQuery({ queryKey: ['admin', 'channels', key], queryFn: () => api.get<T>(path) });

interface TestResult {
  ok: boolean;
  statusCode: number | null;
  message: string;
}

export default function NotificationChannelsPage() {
  const { t } = useTranslation('admin');
  return (
    <>
      <PageHeader title={t('channels.title')} description={t('channels.description')} />
      <div className="flex flex-col gap-6">
        <WebhooksCard />
        <SmsProviderCard />
        <SmsRecipientsCard />
        <ChannelSettingsCard />
      </div>
    </>
  );
}

// --- Visitor channels and limits ------------------------------------------------------

function ChannelSettingsCard() {
  const { t } = useTranslation('admin');
  const settings = useChannelQuery<ChannelSettings>('settings', '/api/admin/channel-settings');
  return (
    <Card title={t('channels.settings.title')}>
      <QueryState query={settings}>{(s) => <ChannelSettingsForm key={JSON.stringify(s)} settings={s} />}</QueryState>
    </Card>
  );
}

function ChannelSettingsForm({ settings }: { settings: ChannelSettings }) {
  const { t } = useTranslation('admin');
  const form = useForm(() => ({ ...settings, smsCallingCodes: settings.smsCallingCodes.join(', ') }));
  const v = form.values;
  const save = useAdminMutation((body: ChannelSettings) => api.patch<ChannelSettings>('/api/admin/channel-settings', body, { type: 'channel-settings' }), {
    success: t('channels.saved'),
    onError: form.applyServerError,
  });
  const num = (key: keyof ChannelSettings) => (x: string) => form.set(key, (x === '' ? 0 : Number(x)) as never);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = form.validate(ChannelSettingsInput, {
      ...v,
      smsCallingCodes: v.smsCallingCodes
        .split(/[\s,;]+/)
        .map((c) => c.replace(/^\+/, '').trim())
        .filter(Boolean),
    });
    if (body) save.mutate(body);
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4 p-4">
      <CheckboxField
        label={t('channels.settings.webhookSubscriptions')}
        help={t('channels.settings.webhookSubscriptionsHelp')}
        checked={v.webhookSubscriptions}
        onChecked={(x) => form.set('webhookSubscriptions', x)}
      />
      <CheckboxField
        label={t('channels.settings.genericWebhookSubscriptions')}
        help={t('channels.settings.genericWebhookSubscriptionsHelp')}
        checked={v.genericWebhookSubscriptions}
        onChecked={(x) => form.set('genericWebhookSubscriptions', x)}
      />
      <TextField
        label={t('channels.settings.smsCallingCodes')}
        help={t('channels.settings.smsCallingCodesHelp')}
        value={v.smsCallingCodes}
        onValue={(x) => form.set('smsCallingCodes', x)}
        error={form.error('smsCallingCodes')}
        placeholder="49, 43, 41"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          type="number"
          min={0}
          label={t('channels.settings.smsMonthlyBudget')}
          help={t('channels.settings.smsMonthlyBudgetHelp')}
          value={String(v.smsMonthlyBudget)}
          onValue={num('smsMonthlyBudget')}
          error={form.error('smsMonthlyBudget')}
        />
        <TextField
          type="number"
          min={1}
          label={t('channels.settings.smsConfirmationsPerHour')}
          value={String(v.smsConfirmationsPerHour)}
          onValue={num('smsConfirmationsPerHour')}
          error={form.error('smsConfirmationsPerHour')}
        />
        <TextField
          type="number"
          min={1}
          label={t('channels.settings.smsPerMinute')}
          value={String(v.smsPerMinute)}
          onValue={num('smsPerMinute')}
          error={form.error('smsPerMinute')}
        />
        <TextField
          type="number"
          min={1}
          label={t('channels.settings.subscriberWebhooksPerMinute')}
          value={String(v.subscriberWebhooksPerMinute)}
          onValue={num('subscriberWebhooksPerMinute')}
          error={form.error('subscriberWebhooksPerMinute')}
        />
        <TextField
          type="number"
          min={1}
          label={t('channels.settings.webhookHostPerMinute')}
          value={String(v.webhookHostPerMinute)}
          onValue={num('webhookHostPerMinute')}
          error={form.error('webhookHostPerMinute')}
        />
      </div>
      <FormErrorSummary errors={form.errors} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" pending={save.isPending}>
          {t('common:actions.save')}
        </Button>
      </div>
    </form>
  );
}

// --- Webhooks -------------------------------------------------------------------------

function WebhooksCard() {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const webhooks = useChannelQuery<AdminWebhook[]>('webhooks', '/api/admin/webhooks');
  const confirm = useConfirm();
  const [editing, setEditing] = useState<AdminWebhook | 'new' | null>(null);
  const [secret, setSecret] = useState<AdminWebhook | null>(null);
  const [log, setLog] = useState<AdminWebhook | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const path = (id: string) => `/api/admin/webhooks/${encodeURIComponent(id)}`;
  const remove = useAdminMutation((w: AdminWebhook) => api.delete(path(w.id)), {
    success: t('channels.webhooks.deleted'),
    onSuccess: () => confirm.close(),
  });
  const test = useAdminMutation((w: AdminWebhook) => api.post<TestResult>(`${path(w.id)}/test`), {
    onSuccess: (r, w) => setResults((all) => ({ ...all, [w.id]: r })),
  });
  const rotate = useAdminMutation((w: AdminWebhook) => api.post<AdminWebhook>(`${path(w.id)}/rotate-secret`), {
    success: t('channels.webhooks.rotated'),
    onSuccess: (w) => {
      confirm.close();
      setSecret(w);
    },
  });
  return (
    <Card
      title={t('channels.webhooks.title')}
      actions={
        <Button variant="primary" size="sm" icon={Plus} onClick={() => setEditing('new')}>
          {t('channels.webhooks.new')}
        </Button>
      }
    >
      <p className="px-4 pt-3 text-sm text-muted">{t('channels.webhooks.description')}</p>
      <QueryState query={webhooks}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState>{t('channels.webhooks.empty')}</EmptyState>
          ) : (
            <Table label={t('channels.webhooks.title')}>
              <thead>
                <tr>
                  <th className={th}>{t('channels.fields.name')}</th>
                  <th className={th}>{t('channels.fields.kind')}</th>
                  <th className={th}>{t('channels.fields.status')}</th>
                  <th className={th}>{t('channels.webhooks.lastDelivery')}</th>
                  <th className={`${th} text-right`}>{t('table.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((w) => (
                  <tr key={w.id} className={tr}>
                    <td className={`${td} font-medium`}>
                      {w.name}
                      <span className="block text-xs font-normal text-muted">{w.host}</span>
                      {w.disabledReason && (
                        <span role="note" className="mt-1 flex items-start gap-1 text-xs font-normal text-status-degraded-text">
                          <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
                          {w.disabledReason}
                        </span>
                      )}
                      {results[w.id] && (
                        <span role="status" className="mt-1 block text-xs font-normal">
                          {results[w.id]!.ok ? t('channels.testOk', { message: results[w.id]!.message }) : t('channels.testFailed', { message: results[w.id]!.message })}
                        </span>
                      )}
                    </td>
                    <td className={td}>{t(`channels.kinds.${w.kind}`)}</td>
                    <td className={td}>
                      {w.enabled ? <Badge tone="success">{t('channels.enabled')}</Badge> : <Badge tone="warning">{t('channels.disabled')}</Badge>}
                    </td>
                    <td className={`${td} whitespace-nowrap text-muted`}>
                      {w.lastDeliveryAt ? `${fmt.dateTime(w.lastDeliveryAt)}${w.lastStatusCode ? ` (HTTP ${w.lastStatusCode})` : ''}` : '–'}
                    </td>
                    <td className={`${td} text-right whitespace-nowrap`}>
                      <IconButton icon={Send} label={t('channels.webhooks.testLabel', { name: w.name })} onClick={() => test.mutate(w)} />
                      <IconButton icon={History} label={t('channels.webhooks.logLabel', { name: w.name })} onClick={() => setLog(w)} />
                      <IconButton icon={Pencil} label={t('channels.webhooks.editLabel', { name: w.name })} onClick={() => setEditing(w)} />
                      <IconButton
                        icon={Trash2}
                        label={t('channels.webhooks.deleteLabel', { name: w.name })}
                        onClick={() =>
                          confirm.ask({
                            title: t('channels.webhooks.deleteTitle'),
                            message: t('channels.webhooks.deleteConfirm', { name: w.name }),
                            confirmLabel: t('common:actions.delete'),
                            action: () => remove.mutate(w),
                          })
                        }
                      />
                      {w.kind === 'generic' && (
                        <Button
                          size="sm"
                          onClick={() =>
                            confirm.ask({
                              title: t('channels.webhooks.rotateTitle'),
                              message: t('channels.webhooks.rotateConfirm', { name: w.name }),
                              confirmLabel: t('channels.webhooks.rotate'),
                              action: () => rotate.mutate(w),
                            })
                          }
                        >
                          {t('channels.webhooks.rotate')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryState>
      {editing && (
        <WebhookDialog
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreated={(w) => {
            setEditing(null);
            if (w.signingSecret) setSecret(w);
          }}
        />
      )}
      {secret?.signingSecret && (
        <Dialog
          open
          onClose={() => setSecret(null)}
          title={t('channels.webhooks.secretTitle')}
          wide
          footer={
            <Button variant="primary" onClick={() => setSecret(null)}>
              {t('ingest.done')}
            </Button>
          }
        >
          <div className="flex flex-col gap-4">
            <p className="flex items-start gap-2 rounded-lg bg-status-degraded/10 px-3 py-2 text-sm text-status-degraded-text">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {t('channels.webhooks.secretOnce')}
            </p>
            <CopyField label={t('channels.webhooks.secret')} value={secret.signingSecret} secret />
            <p className="text-sm text-muted">{t('channels.webhooks.secretHelp')}</p>
          </div>
        </Dialog>
      )}
      {log && <DeliveryLogDialog webhook={log} onClose={() => setLog(null)} />}
      <ConfirmDialog {...confirm.dialogProps(remove.isPending || rotate.isPending)} />
    </Card>
  );
}

function DeliveryLogDialog({ webhook, onClose }: { webhook: AdminWebhook; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const [page, setPage] = useState(1);
  const deliveries = useQuery({
    queryKey: ['admin', 'channels', 'deliveries', webhook.id, page],
    queryFn: () => api.getPage<WebhookDelivery>(`/api/admin/webhooks/${encodeURIComponent(webhook.id)}/deliveries`, { page: { number: page, size: 25 } }),
  });
  const retry = useAdminMutation(() => api.post<{ requeued: number }>(`/api/admin/webhooks/${encodeURIComponent(webhook.id)}/retry-failed`), {
    success: (r) => t('channels.webhooks.requeued', { count: r.requeued }),
  });
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('channels.webhooks.logTitle', { name: webhook.name })}
      footer={
        <>
          <Button onClick={() => retry.mutate()} pending={retry.isPending}>
            {t('channels.webhooks.retryFailed')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('ingest.done')}
          </Button>
        </>
      }
    >
      <QueryState query={deliveries}>
        {(result: Paginated<WebhookDelivery>) =>
          result.items.length === 0 ? (
            <EmptyState>{t('channels.webhooks.logEmpty')}</EmptyState>
          ) : (
            <>
              <Table label={t('channels.webhooks.logTitle', { name: webhook.name })}>
                <thead>
                  <tr>
                    <th className={th}>{t('channels.log.time')}</th>
                    <th className={th}>{t('channels.log.event')}</th>
                    <th className={th}>{t('channels.fields.status')}</th>
                    <th className={th}>{t('channels.log.detail')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((d) => (
                    <tr key={d.id} className={tr}>
                      <td className={`${td} whitespace-nowrap text-muted`}>{fmt.dateTime(d.lastAttemptAt ?? d.createdAt)}</td>
                      <td className={td}>{d.event}</td>
                      <td className={td}>
                        <Badge tone={d.status === 'sent' ? 'success' : d.status === 'failed' ? 'danger' : 'neutral'}>
                          {t(`channels.log.${d.status}`)}
                        </Badge>
                        <span className="ml-2 text-xs text-muted">{t('channels.log.attempts', { count: d.attempts })}</span>
                      </td>
                      <td className={`${td} text-xs break-all text-muted`}>{d.error ?? (d.statusCode ? `HTTP ${d.statusCode}` : '–')}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={result.page} pageSize={result.pageSize} total={result.total} onPage={setPage} />
            </>
          )
        }
      </QueryState>
    </Dialog>
  );
}

interface WebhookForm {
  name: string;
  kind: WebhookKind;
  url: string;
  enabled: boolean;
  allowHttp: boolean;
  allServices: boolean;
  serviceIds: string[];
  headers: string;
}

/** "Name: value" per line → headers (values only replace the stored ones when the field was changed). */
function parseHeaders(text: string): HeaderInput[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(':');
      return at < 0 ? { name: line, value: '' } : { name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
    });
}

function WebhookDialog({ existing, onClose, onCreated }: { existing: AdminWebhook | null; onClose: () => void; onCreated: (w: AdminWebhook) => void }) {
  const { t } = useTranslation('admin');
  const form = useForm<WebhookForm>(() => ({
    name: existing?.name ?? '',
    kind: existing?.kind ?? 'discord',
    url: '',
    enabled: existing?.enabled ?? true,
    allowHttp: existing?.allowHttp ?? false,
    allServices: existing?.allServices ?? true,
    serviceIds: existing?.services.map((s) => s.id) ?? [],
    headers: '',
  }));
  const v = form.values;
  const path = existing ? `/api/admin/webhooks/${encodeURIComponent(existing.id)}` : '/api/admin/webhooks';
  const save = useAdminMutation(
    (body: Record<string, unknown>) =>
      existing
        ? api.patch<AdminWebhook>(path, body, { ...WEBHOOK_DOCUMENT, id: existing.id })
        : api.post<AdminWebhook>(path, body, WEBHOOK_DOCUMENT),
    {
      success: existing ? t('channels.saved') : t('channels.webhooks.created'),
      onSuccess: (w) => (existing ? onClose() : onCreated(w)),
      onError: form.applyServerError,
    },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const headers = parseHeaders(v.headers);
    const candidate = {
      name: v.name.trim(),
      kind: v.kind,
      // Write-only: an empty field keeps the stored URL when editing.
      url: v.url.trim() || (existing ? 'https://keep.invalid/' : ''),
      enabled: v.enabled,
      allowHttp: v.allowHttp,
      allServices: v.allServices,
      serviceIds: v.allServices ? [] : v.serviceIds,
      headers,
    };
    const parsed = form.validate(WebhookInput, candidate);
    if (!parsed) return;
    const { url: _url, headers: _headers, ...rest } = parsed;
    save.mutate({
      ...rest,
      ...(v.url.trim() ? { url: parsed.url } : {}),
      ...(v.kind === 'generic' && (v.headers.trim() || !existing) ? { headers: parsed.headers } : {}),
    });
  };
  return (
    <Dialog open wide onClose={onClose} title={existing ? t('channels.webhooks.editTitle') : t('channels.webhooks.new')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <TextField label={t('channels.fields.name')} value={v.name} onValue={(x) => form.set('name', x)} error={form.error('name')} required autoFocus />
        <SelectField<WebhookKind>
          label={t('channels.fields.kind')}
          value={v.kind}
          onValue={(x) => form.set('kind', x)}
          options={WEBHOOK_KINDS.map((k) => ({ value: k, label: t(`channels.kinds.${k}`) }))}
        />
        <TextField
          type="url"
          label={t('channels.fields.url')}
          help={existing ? t('channels.webhooks.urlKeep', { host: existing.host }) : t(`channels.webhooks.urlHelp.${v.kind}`)}
          value={v.url}
          onValue={(x) => form.set('url', x)}
          error={form.error('url')}
          required={!existing}
          autoComplete="off"
          spellCheck={false}
        />
        {v.kind === 'generic' && (
          <TextAreaField
            label={t('channels.fields.headers')}
            help={existing?.headerNames.length ? t('channels.webhooks.headersKeep', { names: existing.headerNames.join(', ') }) : t('channels.webhooks.headersHelp')}
            value={v.headers}
            onValue={(x) => form.set('headers', x)}
            error={form.error('headers')}
            rows={3}
            spellCheck={false}
          />
        )}
        <CheckboxField label={t('channels.fields.allServices')} checked={v.allServices} onChecked={(x) => form.set('allServices', x)} />
        {!v.allServices && (
          <ServicesPicker
            label={t('channels.fields.services')}
            value={v.serviceIds}
            onChange={(x) => form.set('serviceIds', x)}
            error={form.error('serviceIds')}
          />
        )}
        <CheckboxField label={t('channels.fields.enabled')} checked={v.enabled} onChecked={(x) => form.set('enabled', x)} />
        <CheckboxField
          label={t('channels.fields.allowHttp')}
          help={t('channels.webhooks.allowHttpHelp')}
          checked={v.allowHttp}
          onChecked={(x) => form.set('allowHttp', x)}
        />
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

// --- SMS provider ----------------------------------------------------------------------

function SmsProviderCard() {
  const { t } = useTranslation('admin');
  const provider = useChannelQuery<AdminSmsProvider>('sms-provider', '/api/admin/sms-provider');
  return (
    <Card title={t('channels.sms.title')}>
      <QueryState query={provider}>{(p) => <SmsProviderForm key={JSON.stringify(p)} provider={p} />}</QueryState>
    </Card>
  );
}

type Template = Omit<SmsProviderBody, 'enabled' | 'username' | 'password'>;

function SmsProviderForm({ provider }: { provider: AdminSmsProvider }) {
  const { t } = useTranslation('admin');
  const presets = useChannelQuery<(Template & { id: string })[]>('sms-presets', '/api/admin/sms-presets');
  const form = useForm(() => ({
    enabled: provider.enabled,
    preset: provider.preset,
    method: provider.method,
    url: provider.url,
    headers: provider.headers.map((h) => `${h.name}: ${h.value}`).join('\n'),
    bodyType: provider.bodyType,
    body: provider.body,
    from: provider.from,
    successStatuses: provider.successStatuses.join(', '),
    username: '',
    password: '',
  }));
  const v = form.values;
  const [to, setTo] = useState('');
  const [result, setResult] = useState<TestResult | null>(null);
  const save = useAdminMutation((body: SmsProviderBody) => api.patch<AdminSmsProvider>('/api/admin/sms-provider', body, { type: 'sms-provider' }), {
    success: t('channels.saved'),
    onError: form.applyServerError,
  });
  const test = useAdminMutation((number: string) => api.post<TestResult>('/api/admin/sms-provider/test', { to: number }, { type: 'sms-tests' }), {
    onSuccess: (r) => setResult(r),
  });
  const applyPreset = (name: SmsPreset) => {
    form.set('preset', name);
    const preset = presets.data?.find((p) => p.id === name);
    if (!preset) return;
    form.set('method', preset.method);
    form.set('url', preset.url);
    form.set('headers', preset.headers.map((h) => `${h.name}: ${h.value}`).join('\n'));
    form.set('bodyType', preset.bodyType);
    form.set('body', preset.body);
    form.set('successStatuses', preset.successStatuses.join(', '));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = form.validate(SmsProviderInput, {
      enabled: v.enabled,
      preset: v.preset,
      method: v.method,
      url: v.url.trim(),
      headers: parseHeaders(v.headers),
      bodyType: v.bodyType,
      body: v.body,
      from: v.from.trim(),
      successStatuses: v.successStatuses
        .split(/[\s,;]+/)
        .filter(Boolean)
        .map(Number),
      ...(v.username ? { username: v.username } : {}),
      ...(v.password ? { password: v.password } : {}),
    });
    if (body) save.mutate(body);
  };
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-sm text-muted">{t('channels.sms.description')}</p>
      <p role="status" className="text-sm">
        {t('channels.sms.budget', { sent: provider.sentThisMonth, budget: provider.monthlyBudget })}
        {provider.budgetExhausted && (
          <Badge tone="warning" className="ml-2">
            {t('channels.sms.budgetExhausted')}
          </Badge>
        )}
      </p>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <CheckboxField label={t('channels.sms.enabled')} checked={v.enabled} onChecked={(x) => form.set('enabled', x)} />
        <SelectField<SmsPreset>
          label={t('channels.sms.preset')}
          help={t('channels.sms.presetHelp')}
          value={v.preset}
          onValue={applyPreset}
          options={(['custom', 'twilio', 'vonage', 'seven', 'messagebird'] as const).map((p) => ({ value: p, label: t(`channels.sms.presets.${p}`) }))}
        />
        <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
          <SelectField<'POST' | 'PUT' | 'GET'>
            label={t('channels.sms.method')}
            value={v.method}
            onValue={(x) => form.set('method', x)}
            options={[
              { value: 'POST', label: 'POST' },
              { value: 'PUT', label: 'PUT' },
              { value: 'GET', label: 'GET' },
            ]}
          />
          <TextField label={t('channels.sms.url')} value={v.url} onValue={(x) => form.set('url', x)} error={form.error('url')} spellCheck={false} />
        </div>
        <TextAreaField
          label={t('channels.fields.headers')}
          help={t('channels.sms.headersHelp', { credentials: CREDENTIAL_PLACEHOLDERS, interpolation: { escapeValue: false } })}
          value={v.headers}
          onValue={(x) => form.set('headers', x)}
          error={form.error('headers')}
          rows={2}
          spellCheck={false}
        />
        <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
          <SelectField<'form' | 'json' | 'none'>
            label={t('channels.sms.bodyType')}
            value={v.bodyType}
            onValue={(x) => form.set('bodyType', x)}
            options={[
              { value: 'form', label: 'Form' },
              { value: 'json', label: 'JSON' },
              { value: 'none', label: t('channels.sms.noBody') },
            ]}
          />
          <TextAreaField
            label={t('channels.sms.body')}
            help={t('channels.sms.placeholders', { list: PLACEHOLDERS, interpolation: { escapeValue: false } })}
            value={v.body}
            onValue={(x) => form.set('body', x)}
            error={form.error('body')}
            rows={3}
            spellCheck={false}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label={t('channels.sms.from')} value={v.from} onValue={(x) => form.set('from', x)} error={form.error('from')} />
          <TextField
            label={t('channels.sms.successStatuses')}
            value={v.successStatuses}
            onValue={(x) => form.set('successStatuses', x)}
            error={form.error('successStatuses')}
          />
          <TextField
            label={t('channels.sms.username')}
            help={provider.usernameSet ? t('channels.sms.credentialSet') : t('channels.sms.usernameHelp')}
            value={v.username}
            onValue={(x) => form.set('username', x)}
            autoComplete="off"
          />
          <TextField
            type="password"
            label={t('channels.sms.password')}
            help={provider.passwordSet ? t('channels.sms.credentialSet') : t('channels.sms.passwordHelp')}
            value={v.password}
            onValue={(x) => form.set('password', x)}
            autoComplete="new-password"
          />
        </div>
        <FormErrorSummary errors={form.errors} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" pending={save.isPending}>
            {t('common:actions.save')}
          </Button>
        </div>
      </form>
      <form
        className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setResult(null);
          if (to.trim()) test.mutate(to.trim());
        }}
      >
        <TextField
          className="sm:w-72"
          type="tel"
          label={t('channels.sms.testTo')}
          value={to}
          onValue={setTo}
          autoComplete="off"
          placeholder="+49 151 2345678"
        />
        <Button type="submit" icon={Send} pending={test.isPending}>
          {t('channels.sms.test')}
        </Button>
      </form>
      {result && (
        <p role="status" className="text-sm">
          {result.ok ? t('channels.testOk', { message: result.message }) : t('channels.testFailed', { message: result.message })}
        </p>
      )}
    </div>
  );
}

// --- On-call SMS recipients -----------------------------------------------------------

function SmsRecipientsCard() {
  const { t } = useTranslation('admin');
  const recipients = useChannelQuery<AdminSmsRecipient[]>('sms-recipients', '/api/admin/sms-recipients');
  const confirm = useConfirm();
  const [editing, setEditing] = useState<AdminSmsRecipient | 'new' | null>(null);
  const remove = useAdminMutation((r: AdminSmsRecipient) => api.delete(`/api/admin/sms-recipients/${encodeURIComponent(r.id)}`), {
    success: t('channels.recipients.deleted'),
    onSuccess: () => confirm.close(),
  });
  return (
    <Card
      title={t('channels.recipients.title')}
      actions={
        <Button variant="primary" size="sm" icon={Plus} onClick={() => setEditing('new')}>
          {t('channels.recipients.new')}
        </Button>
      }
    >
      <p className="px-4 pt-3 text-sm text-muted">{t('channels.recipients.description')}</p>
      <QueryState query={recipients}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState>{t('channels.recipients.empty')}</EmptyState>
          ) : (
            <Table label={t('channels.recipients.title')}>
              <thead>
                <tr>
                  <th className={th}>{t('channels.fields.name')}</th>
                  <th className={th}>{t('channels.fields.phone')}</th>
                  <th className={th}>{t('channels.fields.services')}</th>
                  <th className={`${th} text-right`}>{t('table.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id} className={tr}>
                    <td className={`${td} font-medium`}>
                      {r.name} {!r.enabled && <Badge tone="warning">{t('channels.disabled')}</Badge>}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>{r.phone}</td>
                    <td className={`${td} text-muted`}>{r.allServices ? t('channels.fields.allServices') : r.services.map((s) => s.name).join(', ')}</td>
                    <td className={`${td} text-right whitespace-nowrap`}>
                      <IconButton icon={Pencil} label={t('channels.recipients.editLabel', { name: r.name })} onClick={() => setEditing(r)} />
                      <IconButton
                        icon={Trash2}
                        label={t('channels.recipients.deleteLabel', { name: r.name })}
                        onClick={() =>
                          confirm.ask({
                            title: t('channels.recipients.deleteTitle'),
                            message: t('channels.recipients.deleteConfirm', { name: r.name }),
                            confirmLabel: t('common:actions.delete'),
                            action: () => remove.mutate(r),
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
      {editing && <RecipientDialog existing={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </Card>
  );
}

function RecipientDialog({ existing, onClose }: { existing: AdminSmsRecipient | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const form = useForm(() => ({
    name: existing?.name ?? '',
    phone: existing?.phone ?? '',
    enabled: existing?.enabled ?? true,
    allServices: existing?.allServices ?? true,
    serviceIds: existing?.services.map((s) => s.id) ?? [],
  }));
  const v = form.values;
  const save = useAdminMutation(
    (body: SmsRecipientInput) =>
      existing
        ? api.patch<AdminSmsRecipient>(`/api/admin/sms-recipients/${encodeURIComponent(existing.id)}`, body, { ...RECIPIENT_DOCUMENT, id: existing.id })
        : api.post<AdminSmsRecipient>('/api/admin/sms-recipients', body, RECIPIENT_DOCUMENT),
    { success: t('channels.saved'), onSuccess: onClose, onError: form.applyServerError },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = form.validate(SmsRecipientInput, { ...v, name: v.name.trim(), phone: v.phone.trim(), serviceIds: v.allServices ? [] : v.serviceIds });
    if (body) save.mutate(body);
  };
  return (
    <Dialog open onClose={onClose} title={existing ? t('channels.recipients.editTitle') : t('channels.recipients.new')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <TextField label={t('channels.fields.name')} value={v.name} onValue={(x) => form.set('name', x)} error={form.error('name')} required autoFocus />
        <TextField
          type="tel"
          label={t('channels.fields.phone')}
          help={t('channels.recipients.phoneHelp')}
          value={v.phone}
          onValue={(x) => form.set('phone', x)}
          error={form.error('phone')}
          required
        />
        <CheckboxField label={t('channels.fields.allServices')} checked={v.allServices} onChecked={(x) => form.set('allServices', x)} />
        {!v.allServices && (
          <ServicesPicker label={t('channels.fields.services')} value={v.serviceIds} onChange={(x) => form.set('serviceIds', x)} error={form.error('serviceIds')} />
        )}
        <CheckboxField label={t('channels.fields.enabled')} checked={v.enabled} onChecked={(x) => form.set('enabled', x)} />
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
