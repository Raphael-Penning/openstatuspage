/**
 * Single sign-on: the OpenID Connect providers of the login page. Admins add,
 * edit, test and delete providers; the provider of the OIDC_* environment
 * variables is shown read-only. The client secret is write-only (the server
 * only reports whether one is stored).
 */
import {
  OIDC_DEFAULT_ROLES,
  OIDC_ROLE_SYNC_MODES,
  OIDC_ROLE_TARGETS,
  OidcProviderInput,
  type AdminOidcProvider,
  type OidcDiscoveryResult,
  type OidcRoleMapping,
} from '@openstatuspage/shared';
import { Eye, FlaskConical, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { CopyField } from '../components/CopyField';
import { ConfirmDialog, Dialog, useConfirm } from '../components/Dialog';
import { CheckboxField, FormErrorSummary, SelectField, TextAreaField, TextField } from '../components/fields';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader, QueryState, Table, td, th, tr } from '../components/ui';
import { OIDC_DISCOVERY_TEST_DOCUMENT, OIDC_PROVIDER_DOCUMENT } from '../lib/documents';
import { apiErrorMessage } from '../lib/errors';
import { useAdminMutation, useOidcProviders } from '../lib/queries';
import { useForm } from '../lib/useForm';

const path = (id: string) => `/api/admin/oidc-providers/${encodeURIComponent(id)}`;

/** The meta of a discovery test answer (a meta-only JSON:API document). */
function runDiscoveryTest(target: { id: string } | { issuerUrl: string }): Promise<OidcDiscoveryResult> {
  return 'id' in target
    ? api.post<OidcDiscoveryResult>(`${path(target.id)}/test`)
    : api.post<OidcDiscoveryResult>('/api/admin/oidc-providers/test', { issuerUrl: target.issuerUrl }, OIDC_DISCOVERY_TEST_DOCUMENT);
}

export default function SsoProvidersPage() {
  const { t } = useTranslation('admin');
  const providers = useOidcProviders();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<AdminOidcProvider | 'new' | null>(null);
  const [viewing, setViewing] = useState<AdminOidcProvider | null>(null);

  const remove = useAdminMutation((p: AdminOidcProvider) => api.delete(path(p.id)), {
    success: t('sso.deleted'),
    onSuccess: () => confirm.close(),
  });

  return (
    <>
      <PageHeader
        title={t('sso.title')}
        description={t('sso.description')}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
            {t('sso.new')}
          </Button>
        }
      />
      <Card>
        <QueryState query={providers}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState>{t('sso.empty')}</EmptyState>
            ) : (
              <Table label={t('sso.title')}>
                <thead>
                  <tr>
                    <th className={th}>{t('sso.fields.name')}</th>
                    <th className={th}>{t('sso.fields.status')}</th>
                    <th className={th}>{t('sso.fields.issuerUrl')}</th>
                    <th className={th}>{t('sso.fields.users')}</th>
                    <th className={`${th} text-right`}>{t('table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={p.id} className={tr}>
                      <td className={`${td} font-medium`}>
                        {p.name}
                        {p.readOnly && (
                          <span className="block">
                            <Badge tone="info">{t('sso.fromEnv')}</Badge>
                          </span>
                        )}
                      </td>
                      <td className={td}>
                        {p.enabled ? <Badge tone="success">{t('sso.statusEnabled')}</Badge> : <Badge>{t('sso.statusDisabled')}</Badge>}
                      </td>
                      <td className={`${td} max-w-xs truncate font-mono text-xs text-muted`}>{p.issuerUrl}</td>
                      <td className={`${td} whitespace-nowrap text-muted`}>{t('sso.linkedUsers', { count: p.linkedUsers })}</td>
                      <td className={`${td} text-right whitespace-nowrap`}>
                        {p.readOnly ? (
                          <IconButton icon={Eye} label={t('sso.viewLabel', { name: p.name })} onClick={() => setViewing(p)} />
                        ) : (
                          <>
                            <IconButton icon={Pencil} label={t('sso.editLabel', { name: p.name })} onClick={() => setEditing(p)} />
                            <IconButton
                              icon={Trash2}
                              label={t('sso.deleteLabel', { name: p.name })}
                              onClick={() =>
                                confirm.ask({
                                  title: t('sso.deleteTitle'),
                                  message: t('sso.deleteConfirm', { name: p.name }),
                                  confirmLabel: t('common:actions.delete'),
                                  action: () => remove.mutate(p),
                                })
                              }
                            />
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryState>
      </Card>
      {editing && <ProviderDialog existing={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {viewing && <EnvProviderDialog provider={viewing} onClose={() => setViewing(null)} />}
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </>
  );
}

/** "Test configuration": runs the discovery and shows the endpoints (or the error) in a live region. */
function DiscoveryTest({ target, disabled }: { target: () => { id: string } | { issuerUrl: string } | null; disabled?: boolean }) {
  const { t } = useTranslation('admin');
  const [result, setResult] = useState<OidcDiscoveryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const helpId = useId();

  const run = async () => {
    const value = target();
    if (!value) return;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      setResult(await runDiscoveryTest(value));
    } catch (err) {
      setError(apiErrorMessage(err, t));
    } finally {
      setPending(false);
    }
  };

  const endpoints: [string, string | null | undefined][] = result
    ? [
        [t('sso.endpoints.issuer'), result.issuer],
        [t('sso.endpoints.authorization'), result.authorizationEndpoint],
        [t('sso.endpoints.token'), result.tokenEndpoint],
        [t('sso.endpoints.userinfo'), result.userinfoEndpoint],
        [t('sso.endpoints.jwks'), result.jwksUri],
        [t('sso.endpoints.endSession'), result.endSessionEndpoint],
      ]
    : [];

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button icon={FlaskConical} onClick={run} pending={pending} disabled={disabled} aria-describedby={helpId}>
          {t('sso.test')}
        </Button>
        <p id={helpId} className="mt-1 text-xs text-muted">
          {t('sso.testHelp')}
        </p>
      </div>
      <div role="status" aria-live="polite">
        {error && <p className="rounded-lg bg-status-major-outage/10 px-3 py-2 text-sm text-status-major-outage-text">{error}</p>}
        {result && (
          <div
            className={
              'flex flex-col gap-2 rounded-lg px-3 py-2 text-sm ' +
              (result.ok ? 'bg-status-operational/10' : 'bg-status-major-outage/10 text-status-major-outage-text')
            }
          >
            <p className="font-medium">{result.ok ? t('sso.testOk') : t('sso.testFailed')}</p>
            {!result.ok && <p>{result.message}</p>}
            {result.issuer && (
              <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
                {endpoints.map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted">{label}</dt>
                    <dd className="font-mono break-all">{value || t('sso.endpoints.none')}</dd>
                  </div>
                ))}
              </dl>
            )}
            {result.warnings && result.warnings.length > 0 && (
              <div>
                <p className="text-xs font-medium">{t('sso.warnings')}</p>
                <ul className="list-disc pl-5 text-xs">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The environment provider: its settings as a description list, plus the test. */
function EnvProviderDialog({ provider, onClose }: { provider: AdminOidcProvider; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const rows: [string, string][] = [
    [t('sso.fields.name'), provider.name],
    [t('sso.fields.issuerUrl'), provider.issuerUrl],
    [t('sso.fields.clientId'), provider.clientId],
    [t('sso.fields.clientSecret'), provider.hasClientSecret ? t('sso.secretStored') : t('sso.secretNone')],
    [t('sso.fields.scopes'), provider.scopes],
    [t('sso.fields.pkce'), t('sso.help.pkce')],
    [t('sso.fields.autoCreateUsers'), provider.autoCreateUsers ? t('sso.yes') : t('sso.no')],
    [t('sso.fields.linkByEmail'), provider.linkByEmail ? t('sso.yes') : t('sso.no')],
    [t('sso.fields.roleClaim'), provider.roleClaim],
    [
      t('sso.fields.roleMappings'),
      provider.roleMappings.length > 0
        ? provider.roleMappings.map((m) => `${m.value} → ${t(`sso.roleTargets.${m.role}`)}`).join(', ')
        : t('sso.none'),
    ],
    [t('sso.fields.defaultRole'), t(`sso.roleTargets.${provider.defaultRole}`)],
  ];
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('sso.viewTitle')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('common:actions.close')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('sso.fromEnvHelp')}</p>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="font-medium">{label}</dt>
              <dd className="break-all text-muted">{value}</dd>
            </div>
          ))}
        </dl>
        <CopyField label={t('sso.fields.callbackUrl')} value={provider.callbackUrl} />
        <DiscoveryTest target={() => ({ id: provider.id })} />
      </div>
    </Dialog>
  );
}

interface FormValues {
  name: string;
  sortOrder: string;
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  removeSecret: boolean;
  scopes: string;
  autoCreateUsers: boolean;
  linkByEmail: boolean;
  allowedDomains: string;
  roleClaim: string;
  roleMappings: OidcRoleMapping[];
  defaultRole: (typeof OIDC_DEFAULT_ROLES)[number];
  roleSync: (typeof OIDC_ROLE_SYNC_MODES)[number];
}

const splitDomains = (value: string) =>
  value
    .split(/[\s,;]+/)
    .map((d) => d.trim())
    .filter(Boolean);

function ProviderDialog({ existing, onClose }: { existing: AdminOidcProvider | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const form = useForm<FormValues>(() => ({
    name: existing?.name ?? '',
    sortOrder: String(existing?.sortOrder ?? 0),
    enabled: existing?.enabled ?? true,
    issuerUrl: existing?.issuerUrl ?? '',
    clientId: existing?.clientId ?? '',
    clientSecret: '',
    removeSecret: false,
    scopes: existing?.scopes ?? 'openid email profile',
    autoCreateUsers: existing?.autoCreateUsers ?? false,
    linkByEmail: existing?.linkByEmail ?? false,
    allowedDomains: (existing?.allowedDomains ?? []).join('\n'),
    roleClaim: existing?.roleClaim ?? 'groups',
    roleMappings: existing?.roleMappings ?? [],
    defaultRole: existing?.defaultRole ?? 'editor',
    roleSync: existing?.roleSync ?? 'login',
  }));
  const v = form.values;
  const issuerChanged = existing !== null && v.issuerUrl.trim() !== existing.issuerUrl;
  const save = useAdminMutation(
    (body: Record<string, unknown>) =>
      existing
        ? api.patch<AdminOidcProvider>(path(existing.id), body, { ...OIDC_PROVIDER_DOCUMENT, id: existing.id })
        : api.post<AdminOidcProvider>('/api/admin/oidc-providers', body, OIDC_PROVIDER_DOCUMENT),
    {
      success: existing ? t('sso.saved') : t('sso.created'),
      onSuccess: () => onClose(),
      onError: form.applyServerError,
    },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const sortOrder = Number(v.sortOrder);
    const payload = {
      name: v.name.trim(),
      sortOrder: v.sortOrder.trim() === '' || !Number.isFinite(sortOrder) ? Number.NaN : sortOrder,
      enabled: v.enabled,
      issuerUrl: v.issuerUrl.trim(),
      clientId: v.clientId.trim(),
      scopes: v.scopes.trim(),
      autoCreateUsers: v.autoCreateUsers,
      linkByEmail: v.linkByEmail,
      allowedDomains: splitDomains(v.allowedDomains),
      roleClaim: v.roleClaim.trim(),
      roleMappings: v.roleMappings.map((m) => ({ value: m.value.trim(), role: m.role })),
      defaultRole: v.defaultRole,
      roleSync: v.roleSync,
    };
    const body = form.validate(OidcProviderInput, payload);
    if (!body) return;
    // The stored secret never goes to another issuer: a new issuer needs a new secret.
    if (issuerChanged && existing?.hasClientSecret && !v.removeSecret && !v.clientSecret) {
      form.setErrors({ clientSecret: { key: 'sso.issuerChangeSecret' } });
      return;
    }
    // The secret is write-only: sent only when typed (set) or removed (null).
    const { clientSecret: _ignored, ...rest } = body;
    const secret = v.removeSecret ? { clientSecret: null } : v.clientSecret ? { clientSecret: v.clientSecret } : {};
    save.mutate({ ...rest, ...secret });
  };

  const setMapping = (index: number, patch: Partial<OidcRoleMapping>) =>
    form.set(
      'roleMappings',
      v.roleMappings.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    );

  const openToEveryone = v.autoCreateUsers && v.defaultRole !== 'deny' && splitDomains(v.allowedDomains).length === 0;

  return (
    <Dialog open wide onClose={onClose} title={existing ? t('sso.editTitle') : t('sso.new')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-6">
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-sm font-semibold">{t('sso.sections.general')}</legend>
          <TextField
            label={t('sso.fields.name')}
            value={v.name}
            onValue={(x) => form.set('name', x)}
            error={form.error('name')}
            help={t('sso.help.name')}
            required
            autoFocus
          />
          <TextField
            label={t('sso.fields.sortOrder')}
            type="number"
            inputMode="numeric"
            min={0}
            max={9999}
            value={v.sortOrder}
            onValue={(x) => form.set('sortOrder', x)}
            error={form.error('sortOrder')}
            help={t('sso.help.sortOrder')}
          />
          <CheckboxField
            label={t('sso.fields.enabled')}
            help={t('sso.help.enabled')}
            checked={v.enabled}
            onChecked={(x) => form.set('enabled', x)}
          />
        </fieldset>

        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-sm font-semibold">{t('sso.sections.client')}</legend>
          <TextField
            label={t('sso.fields.issuerUrl')}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={v.issuerUrl}
            onValue={(x) => form.set('issuerUrl', x)}
            error={form.error('issuerUrl')}
            help={t('sso.help.issuerUrl')}
            required
          />
          {issuerChanged && existing.linkedUsers > 0 && (
            <p className="flex items-start gap-2 rounded-lg bg-status-degraded/10 px-3 py-2 text-sm text-status-degraded-text">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {t('sso.issuerChangeWarning', { count: existing.linkedUsers })}
            </p>
          )}
          <TextField
            label={t('sso.fields.clientId')}
            autoComplete="off"
            spellCheck={false}
            value={v.clientId}
            onValue={(x) => form.set('clientId', x)}
            error={form.error('clientId')}
            required
          />
          <TextField
            label={t('sso.fields.clientSecret')}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={v.clientSecret}
            onValue={(x) => form.set('clientSecret', x)}
            error={form.error('clientSecret')}
            help={existing?.hasClientSecret ? t('sso.help.clientSecretKeep') : t('sso.help.clientSecret')}
            disabled={v.removeSecret}
          />
          {existing?.hasClientSecret && (
            <CheckboxField
              label={t('sso.help.removeSecret')}
              checked={v.removeSecret}
              onChecked={(x) => form.set('removeSecret', x)}
            />
          )}
          <TextField
            label={t('sso.fields.scopes')}
            autoComplete="off"
            spellCheck={false}
            value={v.scopes}
            onValue={(x) => form.set('scopes', x)}
            error={form.error('scopes')}
            help={t('sso.help.scopes')}
            required
          />
          <p className="text-sm">
            <span className="font-medium">{t('sso.fields.pkce')}:</span> <span className="text-muted">{t('sso.help.pkce')}</span>
          </p>
          {existing ? (
            <CopyField label={t('sso.fields.callbackUrl')} value={existing.callbackUrl} />
          ) : (
            <p className="text-sm text-muted">{t('sso.help.callbackAfterSave')}</p>
          )}
          <DiscoveryTest
            target={() => {
              const issuerUrl = v.issuerUrl.trim();
              if (!issuerUrl) {
                form.setErrors({ issuerUrl: { key: 'validation.required' } });
                return null;
              }
              return { issuerUrl };
            }}
          />
        </fieldset>

        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-sm font-semibold">{t('sso.sections.users')}</legend>
          <CheckboxField
            label={t('sso.fields.autoCreateUsers')}
            help={t('sso.help.autoCreateUsers')}
            checked={v.autoCreateUsers}
            onChecked={(x) => form.set('autoCreateUsers', x)}
          />
          {openToEveryone && (
            <p className="flex items-start gap-2 rounded-lg bg-status-degraded/10 px-3 py-2 text-sm text-status-degraded-text">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {t('sso.autoCreateWarning')}
            </p>
          )}
          <CheckboxField
            label={t('sso.fields.linkByEmail')}
            help={t('sso.help.linkByEmail')}
            checked={v.linkByEmail}
            onChecked={(x) => form.set('linkByEmail', x)}
          />
          {v.linkByEmail && (
            <p className="flex items-start gap-2 rounded-lg bg-status-degraded/10 px-3 py-2 text-sm text-status-degraded-text">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {t('sso.linkByEmailWarning')}
            </p>
          )}
          <TextAreaField
            label={t('sso.fields.allowedDomains')}
            value={v.allowedDomains}
            onValue={(x) => form.set('allowedDomains', x)}
            error={form.error('allowedDomains')}
            help={t('sso.help.allowedDomains')}
            rows={2}
            spellCheck={false}
          />
          <TextField
            label={t('sso.fields.roleClaim')}
            autoComplete="off"
            spellCheck={false}
            value={v.roleClaim}
            onValue={(x) => form.set('roleClaim', x)}
            error={form.error('roleClaim')}
            help={t('sso.help.roleClaim')}
            required
          />
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-medium">{t('sso.fields.roleMappings')}</legend>
            <p className="text-xs text-muted">{t('sso.help.roleMappings')}</p>
            {v.roleMappings.length === 0 && <p className="text-sm text-muted">{t('sso.noMappings')}</p>}
            {v.roleMappings.map((m, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <TextField
                  className="min-w-40 flex-1"
                  label={t('sso.mappingValue', { n: i + 1 })}
                  autoComplete="off"
                  spellCheck={false}
                  value={m.value}
                  onValue={(x) => setMapping(i, { value: x })}
                  error={form.error(`roleMappings.${i}.value`)}
                  required
                />
                <SelectField
                  className="w-40"
                  label={t('sso.mappingRole', { n: i + 1 })}
                  value={m.role}
                  onValue={(x) => setMapping(i, { role: x })}
                  options={OIDC_ROLE_TARGETS.map((r) => ({ value: r, label: t(`sso.roleTargets.${r}`) }))}
                />
                <IconButton
                  icon={Trash2}
                  className="mb-1"
                  label={t('sso.removeMapping', { n: i + 1 })}
                  onClick={() =>
                    form.set(
                      'roleMappings',
                      v.roleMappings.filter((_, j) => j !== i),
                    )
                  }
                />
              </div>
            ))}
            <div>
              <Button
                icon={Plus}
                size="sm"
                onClick={() => form.set('roleMappings', [...v.roleMappings, { value: '', role: 'editor' }])}
              >
                {t('sso.addMapping')}
              </Button>
            </div>
          </fieldset>
          <SelectField
            label={t('sso.fields.defaultRole')}
            help={t('sso.help.defaultRole')}
            value={v.defaultRole}
            onValue={(x) => form.set('defaultRole', x)}
            options={OIDC_DEFAULT_ROLES.map((r) => ({ value: r, label: t(`sso.roleTargets.${r}`) }))}
          />
          <SelectField
            label={t('sso.fields.roleSync')}
            help={t('sso.help.roleSync')}
            value={v.roleSync}
            onValue={(x) => form.set('roleSync', x)}
            options={OIDC_ROLE_SYNC_MODES.map((r) => ({ value: r, label: t(`sso.syncModes.${r}`) }))}
          />
        </fieldset>

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
