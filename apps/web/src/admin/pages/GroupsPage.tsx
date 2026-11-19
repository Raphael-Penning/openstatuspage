import { ServiceGroupInput, type AdminServiceGroup } from '@openstatuspage/shared';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { ConfirmDialog, Dialog, useConfirm } from '../components/Dialog';
import { CheckboxField, FormErrorSummary, TextAreaField, TextField } from '../components/fields';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader, QueryState, Table, td, th, tr, VisibilityBadge } from '../components/ui';
import { bySortOrder, moveId, nextSortOrder } from '../lib/ordering';
import { useAdminMutation, useGroups, useServices } from '../lib/queries';
import { useForm } from '../lib/useForm';
import { useIsAdmin } from '../session';

export default function GroupsPage() {
  const { t } = useTranslation('admin');
  const isAdmin = useIsAdmin();
  const groups = useGroups();
  const services = useServices();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<AdminServiceGroup | 'new' | null>(null);

  const reorder = useAdminMutation((ids: string[]) => api.post('/api/admin/service-groups/reorder', { ids }), {
    success: t('reorder.saved'),
  });
  const remove = useAdminMutation((id: string) => api.delete(`/api/admin/service-groups/${id}`), {
    success: t('groups.deleted'),
    onSuccess: () => confirm.close(),
  });

  const countFor = (id: string) => (services.data ?? []).filter((s) => s.groupId === id).length;

  return (
    <>
      <PageHeader
        title={t('groups.title')}
        description={t('groups.description')}
        actions={
          isAdmin && (
            <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
              {t('groups.new')}
            </Button>
          )
        }
      />
      <Card>
        <QueryState query={groups}>
          {(list) => {
            const sorted = [...list].sort(bySortOrder);
            const ids = sorted.map((g) => g.id);
            if (sorted.length === 0) return <EmptyState>{t('groups.empty')}</EmptyState>;
            return (
              <Table label={t('groups.title')}>
                <thead>
                  <tr>
                    <th className={th}>{t('groups.fields.name')}</th>
                    <th className={th}>{t('groups.servicesCount')}</th>
                    <th className={th}>{t('groups.fields.collapsedByDefault')}</th>
                    {isAdmin && <th className={`${th} text-right`}>{t('table.actions')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((g, i) => (
                    <tr key={g.id} className={tr}>
                      <td className={td}>
                        <span className="font-medium">{g.name}</span>
                        <span className="ml-2 text-xs text-muted">/{g.slug}</span>
                        {g.description && <p className="text-xs text-muted">{g.description}</p>}
                        {!g.isPublic && (
                          <div className="mt-1">
                            <VisibilityBadge isPublic={false} />
                          </div>
                        )}
                      </td>
                      <td className={`${td} tabular-nums text-muted`}>{countFor(g.id)}</td>
                      <td className={td}>{g.collapsedByDefault ? <Badge>{t('form.yes')}</Badge> : <span className="text-muted">{t('form.no')}</span>}</td>
                      {isAdmin && (
                        <td className={`${td} text-right whitespace-nowrap`}>
                          <IconButton
                            icon={ArrowUp}
                            label={t('reorder.up', { name: g.name })}
                            disabled={i === 0 || reorder.isPending}
                            onClick={() => reorder.mutate(moveId(ids, i, -1))}
                          />
                          <IconButton
                            icon={ArrowDown}
                            label={t('reorder.down', { name: g.name })}
                            disabled={i === sorted.length - 1 || reorder.isPending}
                            onClick={() => reorder.mutate(moveId(ids, i, 1))}
                          />
                          <IconButton icon={Pencil} label={t('common:actions.edit')} onClick={() => setEditing(g)} />
                          <IconButton
                            icon={Trash2}
                            label={t('common:actions.delete')}
                            onClick={() =>
                              confirm.ask({
                                title: t('groups.deleteTitle'),
                                message: t('groups.deleteConfirm', { name: g.name, count: countFor(g.id) }),
                                action: () => remove.mutate(g.id),
                              })
                            }
                          />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            );
          }}
        </QueryState>
      </Card>
      {editing && (
        <GroupDialog
          group={editing === 'new' ? undefined : editing}
          sortOrder={nextSortOrder(groups.data ?? [])}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </>
  );
}

function GroupDialog({ group, sortOrder, onClose }: { group?: AdminServiceGroup; sortOrder: number; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const form = useForm({
    name: group?.name ?? '',
    slug: group?.slug ?? '',
    description: group?.description ?? '',
    isPublic: group?.isPublic ?? true,
    collapsedByDefault: group?.collapsedByDefault ?? false,
  });
  const v = form.values;
  const save = useAdminMutation(
    (body: ServiceGroupInput) =>
      group
        ? api.patch(`/api/admin/service-groups/${group.id}`, body, { type: 'service-groups', id: group.id })
        : api.post('/api/admin/service-groups', body, { type: 'service-groups' }),
    { success: group ? t('groups.saved') : t('groups.created'), onSuccess: onClose, onError: form.applyServerError },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = form.validate(ServiceGroupInput, {
      name: v.name.trim(),
      slug: v.slug.trim() || null,
      description: v.description.trim() || null,
      sortOrder: group?.sortOrder ?? sortOrder,
      isPublic: v.isPublic,
      collapsedByDefault: v.collapsedByDefault,
    });
    if (body) save.mutate(body);
  };

  return (
    <Dialog open onClose={onClose} title={group ? t('groups.editTitle') : t('groups.new')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <TextField label={t('groups.fields.name')} value={v.name} onValue={(x) => form.set('name', x)} error={form.error('name')} required autoFocus />
        <TextField
          label={t('form.slug')}
          value={v.slug}
          onValue={(x) => form.set('slug', x)}
          error={form.error('slug')}
          help={t('form.slugHelp')}
          placeholder={t('form.slugPlaceholder')}
        />
        <TextAreaField
          label={t('groups.fields.description')}
          value={v.description}
          onValue={(x) => form.set('description', x)}
          error={form.error('description')}
          rows={2}
        />
        <CheckboxField label={t('form.isPublic')} help={t('groups.publicHelp')} checked={v.isPublic} onChecked={(x) => form.set('isPublic', x)} />
        <CheckboxField
          label={t('groups.fields.collapsedByDefault')}
          help={t('groups.collapsedHelp')}
          checked={v.collapsedByDefault}
          onChecked={(x) => form.set('collapsedByDefault', x)}
        />
        <FormErrorSummary errors={form.errors} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" variant="primary" pending={save.isPending}>
            {group ? t('common:actions.save') : t('common:actions.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
