/**
 * Private status pages (/p/<token>): create, edit, delete, renew the link.
 * The link is shown once, right after it was created or renewed (the server
 * keeps only a hash of its token).
 */
import { PrivatePageInput, type AdminPrivatePage } from '@openstatuspage/shared';
import { ExternalLink, Pencil, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { CopyField } from '../components/CopyField';
import { ConfirmDialog, Dialog, useConfirm } from '../components/Dialog';
import { CheckboxField, DateTimeField, FormErrorSummary, TextAreaField, TextField } from '../components/fields';
import { ServicesPicker } from '../components/pickers';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader, QueryState, Table, td, th, tr } from '../components/ui';
import { isoToLocalInput, localInputToIso } from '../lib/datetime';
import { PRIVATE_PAGE_DOCUMENT } from '../lib/documents';
import { useFormat } from '../lib/format';
import { useAdminMutation, usePrivatePages } from '../lib/queries';
import { useForm } from '../lib/useForm';

const path = (id: string) => `/api/admin/private-pages/${encodeURIComponent(id)}`;

export default function PrivatePagesPage() {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const pages = usePrivatePages();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<AdminPrivatePage | 'new' | null>(null);
  const [link, setLink] = useState<AdminPrivatePage | null>(null);

  const remove = useAdminMutation((p: AdminPrivatePage) => api.delete(path(p.id)), {
    success: t('privatePages.deleted'),
    onSuccess: () => confirm.close(),
  });
  const regenerate = useAdminMutation((p: AdminPrivatePage) => api.post<AdminPrivatePage>(`${path(p.id)}/regenerate-token`), {
    success: t('privatePages.regenerated'),
    onSuccess: (p) => {
      confirm.close();
      setLink(p);
    },
  });

  return (
    <>
      <PageHeader
        title={t('privatePages.title')}
        description={t('privatePages.description')}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
            {t('privatePages.new')}
          </Button>
        }
      />
      <Card>
        <QueryState query={pages}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState>{t('privatePages.empty')}</EmptyState>
            ) : (
              <Table label={t('privatePages.title')}>
                <thead>
                  <tr>
                    <th className={th}>{t('privatePages.fields.name')}</th>
                    <th className={th}>{t('privatePages.status')}</th>
                    <th className={th}>{t('privatePages.fields.services')}</th>
                    <th className={th}>{t('privatePages.fields.expiresAt')}</th>
                    <th className={th}>{t('privatePages.linkCreated')}</th>
                    <th className={`${th} text-right`}>{t('table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={p.id} className={tr}>
                      <td className={`${td} font-medium`}>
                        {p.name}
                        {p.description && <span className="block text-xs font-normal text-muted">{p.description}</span>}
                      </td>
                      <td className={td}>
                        {!p.enabled ? (
                          <Badge>{t('privatePages.statusDisabled')}</Badge>
                        ) : p.expired ? (
                          <Badge tone="warning">{t('privatePages.statusExpired')}</Badge>
                        ) : (
                          <Badge tone="success">{t('privatePages.statusActive')}</Badge>
                        )}
                      </td>
                      <td className={`${td} whitespace-nowrap text-muted`}>{t('privatePages.servicesCount', { count: p.serviceIds.length })}</td>
                      <td className={`${td} whitespace-nowrap text-muted`}>{p.expiresAt ? fmt.dateTime(p.expiresAt) : t('privatePages.never')}</td>
                      <td className={`${td} whitespace-nowrap text-muted`}>{fmt.dateTime(p.tokenCreatedAt)}</td>
                      <td className={`${td} text-right whitespace-nowrap`}>
                        <IconButton icon={Pencil} label={t('privatePages.editLabel', { name: p.name })} onClick={() => setEditing(p)} />
                        <IconButton
                          icon={RefreshCw}
                          label={t('privatePages.regenerateLabel', { name: p.name })}
                          onClick={() =>
                            confirm.ask({
                              title: t('privatePages.regenerateTitle'),
                              message: t('privatePages.regenerateConfirm', { name: p.name }),
                              confirmLabel: t('privatePages.regenerate'),
                              action: () => regenerate.mutate(p),
                            })
                          }
                        />
                        <IconButton
                          icon={Trash2}
                          label={t('privatePages.deleteLabel', { name: p.name })}
                          onClick={() =>
                            confirm.ask({
                              title: t('privatePages.deleteTitle'),
                              message: t('privatePages.deleteConfirm', { name: p.name }),
                              confirmLabel: t('common:actions.delete'),
                              action: () => remove.mutate(p),
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
      {editing && (
        <PrivatePageDialog
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreated={(p) => {
            setEditing(null);
            setLink(p);
          }}
        />
      )}
      {link?.url && <LinkDialog page={link} onClose={() => setLink(null)} />}
      <ConfirmDialog {...confirm.dialogProps(remove.isPending || regenerate.isPending)} />
    </>
  );
}

/** The link of a page, right after it was created or renewed (never again). */
function LinkDialog({ page, onClose }: { page: AdminPrivatePage; onClose: () => void }) {
  const { t } = useTranslation('admin');
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('privatePages.linkTitle')}
      wide
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('ingest.done')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="flex items-start gap-2 rounded-lg bg-status-degraded/10 px-3 py-2 text-sm text-status-degraded-text">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t('privatePages.onceWarning')}
        </p>
        <CopyField label={t('privatePages.link')} value={page.url!} secret />
        <a
          href={page.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
        >
          <ExternalLink aria-hidden className="size-4" />
          {t('privatePages.open')}
          <span className="sr-only"> {t('privatePages.newTab')}</span>
        </a>
      </div>
    </Dialog>
  );
}

interface FormValues {
  name: string;
  description: string;
  serviceIds: string[];
  expiresAt: string;
  enabled: boolean;
}

function PrivatePageDialog({
  existing,
  onClose,
  onCreated,
}: {
  existing: AdminPrivatePage | null;
  onClose: () => void;
  onCreated: (p: AdminPrivatePage) => void;
}) {
  const { t } = useTranslation('admin');
  const form = useForm<FormValues>(() => ({
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    serviceIds: existing?.serviceIds ?? [],
    expiresAt: isoToLocalInput(existing?.expiresAt),
    enabled: existing?.enabled ?? true,
  }));
  const v = form.values;
  const save = useAdminMutation(
    (body: PrivatePageInput) =>
      existing
        ? api.patch<AdminPrivatePage>(path(existing.id), body, { ...PRIVATE_PAGE_DOCUMENT, id: existing.id })
        : api.post<AdminPrivatePage>('/api/admin/private-pages', body, PRIVATE_PAGE_DOCUMENT),
    {
      success: existing ? t('privatePages.saved') : t('privatePages.created'),
      onSuccess: (p) => (existing ? onClose() : onCreated(p)),
      onError: form.applyServerError,
    },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const expiresAt = v.expiresAt.trim() ? localInputToIso(v.expiresAt) : null;
    if (v.expiresAt.trim() && !expiresAt) {
      form.setErrors({ expiresAt: { key: 'validation.datetime' } });
      return;
    }
    const body = form.validate(PrivatePageInput, {
      name: v.name.trim(),
      description: v.description.trim() || null,
      serviceIds: v.serviceIds,
      expiresAt,
      enabled: v.enabled,
    });
    if (body) save.mutate(body);
  };

  return (
    <Dialog open wide onClose={onClose} title={existing ? t('privatePages.editTitle') : t('privatePages.new')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <TextField
          label={t('privatePages.fields.name')}
          value={v.name}
          onValue={(x) => form.set('name', x)}
          error={form.error('name')}
          help={t('privatePages.nameHelp')}
          required
          autoFocus
        />
        <TextAreaField
          label={t('privatePages.fields.description')}
          value={v.description}
          onValue={(x) => form.set('description', x)}
          error={form.error('description')}
          help={t('privatePages.descriptionHelp')}
          rows={2}
        />
        <ServicesPicker
          label={t('privatePages.fields.services')}
          help={t('privatePages.servicesHelp')}
          value={v.serviceIds}
          onChange={(x) => form.set('serviceIds', x)}
          error={form.error('serviceIds')}
        />
        <DateTimeField
          label={t('privatePages.fields.expiresAt')}
          help={t('privatePages.expiresAtHelp')}
          value={v.expiresAt}
          onValue={(x) => form.set('expiresAt', x)}
          error={form.error('expiresAt')}
        />
        <CheckboxField
          label={t('privatePages.fields.enabled')}
          help={t('privatePages.enabledHelp')}
          checked={v.enabled}
          onChecked={(x) => form.set('enabled', x)}
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
