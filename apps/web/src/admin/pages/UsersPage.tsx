import { UserCreateInput, UserUpdateInput, type AdminUser, type UserRole } from '@openstatuspage/shared';
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { ConfirmDialog, Dialog, useConfirm } from '../components/Dialog';
import { CheckboxField, FormErrorSummary, SelectField, TextField } from '../components/fields';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader, QueryState, Table, td, th, tr } from '../components/ui';
import { useFormat, useOptions } from '../lib/format';
import { useAdminMutation, useUsers } from '../lib/queries';
import { useForm } from '../lib/useForm';
import { useSession } from '../session';

export default function UsersPage() {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const { user: me } = useSession();
  const users = useUsers();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null);
  const remove = useAdminMutation((u: AdminUser) => api.delete(`/api/admin/users/${u.id}`), {
    success: t('users.deleted'),
    onSuccess: () => confirm.close(),
  });

  return (
    <>
      <PageHeader
        title={t('users.title')}
        description={t('users.description')}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
            {t('users.new')}
          </Button>
        }
      />
      <Card>
        <QueryState query={users}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState>{t('users.empty')}</EmptyState>
            ) : (
              <Table label={t('users.title')}>
                <thead>
                  <tr>
                    <th className={th}>{t('users.fields.name')}</th>
                    <th className={th}>{t('users.fields.role')}</th>
                    <th className={th}>{t('users.signIn')}</th>
                    <th className={th}>{t('users.lastLogin')}</th>
                    <th className={`${th} text-right`}>{t('table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((u) => {
                    const self = u.id === me.id;
                    return (
                      <tr key={u.id} className={tr}>
                        <td className={td}>
                          <span className="font-medium">{u.name}</span>
                          {self && <Badge className="ml-2">{t('users.you')}</Badge>}
                          <p className="text-xs text-muted">{u.email}</p>
                        </td>
                        <td className={td}>
                          <Badge tone={u.role === 'admin' ? 'accent' : 'neutral'}>{t(`roles.${u.role}`)}</Badge>
                        </td>
                        <td className={td}>
                          <div className="flex flex-wrap gap-1">
                            {u.hasPassword && <Badge>{t('users.password')}</Badge>}
                            {u.oidcLinked && (
                              <Badge tone="info">
                                <KeyRound aria-hidden className="size-3" />
                                {t('users.oidcLinked')}
                              </Badge>
                            )}
                            {!u.hasPassword && !u.oidcLinked && <span className="text-xs text-muted">{t('users.noSignIn')}</span>}
                          </div>
                        </td>
                        <td className={`${td} whitespace-nowrap text-muted`} title={fmt.dateTime(u.lastLoginAt)}>
                          {u.lastLoginAt ? fmt.relative(u.lastLoginAt) : t('users.never')}
                        </td>
                        <td className={`${td} text-right whitespace-nowrap`}>
                          <IconButton icon={Pencil} label={t('users.editUser', { name: u.name })} onClick={() => setEditing(u)} />
                          <IconButton
                            icon={Trash2}
                            label={self ? t('users.cannotDeleteSelf') : t('users.deleteUser', { name: u.name })}
                            disabled={self}
                            onClick={() =>
                              confirm.ask({
                                title: t('users.deleteTitle'),
                                message: t('users.deleteConfirm', { name: u.name, email: u.email }),
                                action: () => remove.mutate(u),
                              })
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )
          }
        </QueryState>
      </Card>
      {editing && <UserDialog user={editing === 'new' ? undefined : editing} self={editing !== 'new' && editing.id === me.id} onClose={() => setEditing(null)} />}
      <ConfirmDialog {...confirm.dialogProps(remove.isPending)} />
    </>
  );
}

function UserDialog({ user, self, onClose }: { user?: AdminUser; self: boolean; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const opts = useOptions();
  const form = useForm({
    email: user?.email ?? '',
    name: user?.name ?? '',
    role: (user?.role ?? 'editor') as UserRole,
    password: '',
    removePassword: false,
  });
  const v = form.values;

  const save = useAdminMutation(
    (body: UserCreateInput | UserUpdateInput) =>
      user
        ? api.patch(`/api/admin/users/${user.id}`, body, { type: 'users', id: user.id })
        : api.post('/api/admin/users', body, { type: 'users' }),
    { success: user ? t('users.saved') : t('users.created'), onSuccess: onClose, onError: form.applyServerError },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const base = { email: v.email.trim(), name: v.name.trim(), role: v.role };
    if (user) {
      const password = v.removePassword ? null : v.password === '' ? undefined : v.password;
      const body = form.validate(UserUpdateInput, { ...base, ...(password !== undefined ? { password } : {}) });
      if (body) save.mutate(body);
    } else {
      const body = form.validate(UserCreateInput, { ...base, password: v.password === '' ? null : v.password });
      if (body) save.mutate(body);
    }
  };

  return (
    <Dialog open onClose={onClose} title={user ? t('users.editTitle') : t('users.new')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <TextField label={t('users.fields.name')} value={v.name} onValue={(x) => form.set('name', x)} error={form.error('name')} required autoFocus />
        <TextField
          label={t('users.fields.email')}
          type="email"
          autoComplete="off"
          value={v.email}
          onValue={(x) => form.set('email', x)}
          error={form.error('email')}
          required
        />
        <SelectField
          label={t('users.fields.role')}
          value={v.role}
          onValue={(x) => form.set('role', x)}
          options={opts.role}
          help={self ? t('users.ownRoleHelp') : t('users.roleHelp')}
          disabled={self}
        />
        {!v.removePassword && (
          <TextField
            label={user ? t('users.fields.newPassword') : t('users.fields.password')}
            type="password"
            autoComplete="new-password"
            value={v.password}
            onValue={(x) => form.set('password', x)}
            error={form.error('password')}
            help={user ? t('users.newPasswordHelp') : t('users.passwordOptionalHelp')}
          />
        )}
        {user?.hasPassword && !self && (
          <CheckboxField
            label={t('users.removePassword')}
            help={t('users.removePasswordHelp')}
            checked={v.removePassword}
            onChecked={(x) => form.set('removePassword', x)}
          />
        )}
        {user?.oidcLinked && <p className="text-xs text-muted">{t('users.oidcLinkedHelp')}</p>}
        <FormErrorSummary errors={form.errors} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" variant="primary" pending={save.isPending}>
            {user ? t('common:actions.save') : t('common:actions.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
