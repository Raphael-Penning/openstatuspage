import { ApiTokenCreateInput, type AdminApiToken, type UserRole } from '@openstatuspage/shared';
import { Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { CopyField } from '../components/CopyField';
import { ConfirmDialog, Dialog, useConfirm } from '../components/Dialog';
import { FormErrorSummary, SelectField, TextField } from '../components/fields';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader, QueryState, Table, td, th, tr } from '../components/ui';
import { useFormat, useOptions } from '../lib/format';
import { useAdminMutation, useApiTokens } from '../lib/queries';
import { useForm } from '../lib/useForm';

export default function ApiTokensPage() {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const tokens = useApiTokens();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<AdminApiToken | null>(null);
  const revoke = useAdminMutation((tok: AdminApiToken) => api.delete(`/api/admin/api-tokens/${tok.id}`), {
    success: t('tokens.revoked'),
    onSuccess: () => confirm.close(),
  });

  return (
    <>
      <PageHeader
        title={t('tokens.title')}
        description={t('tokens.description')}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            {t('tokens.new')}
          </Button>
        }
      />
      <Card>
        <QueryState query={tokens}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState>{t('tokens.empty')}</EmptyState>
            ) : (
              <Table label={t('tokens.title')}>
                <thead>
                  <tr>
                    <th className={th}>{t('tokens.fields.name')}</th>
                    <th className={th}>{t('tokens.fields.role')}</th>
                    <th className={th}>{t('tokens.createdAt')}</th>
                    <th className={th}>{t('tokens.lastUsed')}</th>
                    <th className={`${th} text-right`}>{t('table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((tok) => (
                    <tr key={tok.id} className={tr}>
                      <td className={`${td} font-medium`}>{tok.name}</td>
                      <td className={td}>
                        <Badge tone={tok.role === 'admin' ? 'accent' : 'neutral'}>{t(`roles.${tok.role}`)}</Badge>
                      </td>
                      <td className={`${td} whitespace-nowrap text-muted`}>{fmt.dateTime(tok.createdAt)}</td>
                      <td className={`${td} whitespace-nowrap text-muted`} title={fmt.dateTime(tok.lastUsedAt)}>
                        {tok.lastUsedAt ? fmt.relative(tok.lastUsedAt) : t('users.never')}
                      </td>
                      <td className={`${td} text-right`}>
                        <IconButton
                          icon={Trash2}
                          label={t('tokens.revokeToken', { name: tok.name })}
                          onClick={() =>
                            confirm.ask({
                              title: t('tokens.revokeTitle'),
                              message: t('tokens.revokeConfirm', { name: tok.name }),
                              confirmLabel: t('tokens.revoke'),
                              action: () => revoke.mutate(tok),
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
      </Card>
      {creating && (
        <CreateTokenDialog
          onClose={() => setCreating(false)}
          onCreated={(tok) => {
            setCreating(false);
            setCreated(tok);
          }}
        />
      )}
      {created?.token && (
        <Dialog
          open
          onClose={() => setCreated(null)}
          title={t('tokens.createdTitle')}
          wide
          footer={
            <Button variant="primary" onClick={() => setCreated(null)}>
              {t('ingest.done')}
            </Button>
          }
        >
          <div className="flex flex-col gap-4">
            <p className="flex items-start gap-2 rounded-lg bg-status-degraded/10 px-3 py-2 text-sm text-status-degraded-text">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {t('tokens.onceWarning')}
            </p>
            <CopyField label={t('tokens.token')} value={created.token} secret />
            <p className="text-sm text-muted">{t('tokens.usage')}</p>
            <code className="block overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs whitespace-pre">
              {`curl -H "Authorization: Bearer ${created.token}" \\\n  ${window.location.origin}/api/admin/overview`}
            </code>
          </div>
        </Dialog>
      )}
      <ConfirmDialog {...confirm.dialogProps(revoke.isPending)} />
    </>
  );
}

function CreateTokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (t: AdminApiToken) => void }) {
  const { t } = useTranslation('admin');
  const opts = useOptions();
  const form = useForm({ name: '', role: 'editor' as UserRole });
  const create = useAdminMutation((body: { name: string; role: UserRole }) => api.post<AdminApiToken>('/api/admin/api-tokens', body, { type: 'api-tokens' }), {
    success: t('tokens.created'),
    onSuccess: onCreated,
    onError: form.applyServerError,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = form.validate(ApiTokenCreateInput, { name: form.values.name.trim(), role: form.values.role });
    if (body) create.mutate(body);
  };
  return (
    <Dialog open onClose={onClose} title={t('tokens.new')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <TextField
          label={t('tokens.fields.name')}
          value={form.values.name}
          onValue={(x) => form.set('name', x)}
          error={form.error('name')}
          help={t('tokens.nameHelp')}
          required
          autoFocus
        />
        <SelectField
          label={t('tokens.fields.role')}
          value={form.values.role}
          onValue={(x) => form.set('role', x)}
          options={opts.role}
          help={t('tokens.roleHelp')}
        />
        <FormErrorSummary errors={form.errors} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" variant="primary" pending={create.isPending}>
            {t('common:actions.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
