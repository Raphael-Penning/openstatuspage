/**
 * Management UI shell: sidebar navigation (drawer on mobile) and user menu.
 */
import { ChangePasswordInput } from '@openstatuspage/shared';
import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Boxes,
  ChevronUp,
  Combine,
  CircleHelp,
  ExternalLink,
  Fingerprint,
  FolderTree,
  History,
  KeyRound,
  LockKeyhole,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  MapPin,
  Menu,
  Radar,
  ScrollText,
  Settings,
  TriangleAlert,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api, ApiError } from '../../lib/api';
import { LANGUAGES } from '../../lib/i18n';
import { useTheme, type ThemePreference } from '../../lib/theme';
import { useAdminMutation } from '../lib/queries';
import { useForm } from '../lib/useForm';
import { useBranding, useSession } from '../session';
import { Dialog } from './Dialog';
import { TextField } from './fields';
import { Button } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  adminOnly?: boolean;
}

function useNavSections(): { title?: string; items: NavItem[] }[] {
  const { t } = useTranslation('admin');
  const { t: tHelp } = useTranslation('help');
  return [
    {
      items: [
        { to: '/admin', label: t('nav.dashboard'), icon: LayoutDashboard, end: true },
        { to: '/admin/incidents', label: t('nav.incidents'), icon: TriangleAlert },
        { to: '/admin/maintenance', label: t('nav.maintenance'), icon: Wrench },
        { to: '/admin/corrections', label: t('nav.corrections'), icon: History },
      ],
    },
    {
      title: t('nav.catalog'),
      items: [
        { to: '/admin/services', label: t('nav.services'), icon: Boxes },
        { to: '/admin/groups', label: t('nav.groups'), icon: FolderTree },
        { to: '/admin/locations', label: t('nav.locations'), icon: MapPin },
      ],
    },
    {
      title: t('nav.monitoring'),
      items: [
        { to: '/admin/monitoring', label: t('nav.sources'), icon: Radar, end: true, adminOnly: true },
        { to: '/admin/monitoring/checks', label: t('nav.checks'), icon: ListChecks },
        { to: '/admin/monitoring/bundles', label: t('nav.bundles'), icon: Combine, adminOnly: true },
      ],
    },
    {
      title: t('nav.administration'),
      items: [
        { to: '/admin/settings', label: t('nav.settings'), icon: Settings, adminOnly: true },
        { to: '/admin/users', label: t('nav.users'), icon: Users, adminOnly: true },
        { to: '/admin/subscribers', label: t('nav.subscribers'), icon: Mail, adminOnly: true },
        { to: '/admin/api-tokens', label: t('nav.apiTokens'), icon: KeyRound, adminOnly: true },
        { to: '/admin/private-pages', label: t('nav.privatePages'), icon: LockKeyhole, adminOnly: true },
        { to: '/admin/sso', label: t('nav.sso'), icon: Fingerprint, adminOnly: true },
        { to: '/admin/audit-log', label: t('nav.auditLog'), icon: ScrollText, adminOnly: true },
      ],
    },
    {
      items: [{ to: '/admin/help', label: tHelp('nav'), icon: CircleHelp }],
    },
  ];
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  const isAdmin = user.role === 'admin';
  const sections = useNavSections()
    .map((s) => ({ ...s, items: s.items.filter((i) => isAdmin || !i.adminOnly) }))
    .filter((s) => s.items.length > 0);
  const branding = useBranding();

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        {branding.data?.logoUrl ? (
          <img src={branding.data.logoUrl} alt="" className="h-6 w-auto max-w-[2.5rem] object-contain" />
        ) : (
          <span aria-hidden className="size-6 rounded-md bg-accent" />
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{branding.data?.siteName ?? 'OpenStatusPage'}</p>
          <p className="text-xs text-muted">{t('title')}</p>
        </div>
      </div>
      <nav aria-label={t('nav.label')} className="flex-1 overflow-y-auto px-2 py-3">
        {sections.map((section, i) => (
          <div key={section.title ?? i} className="mb-4">
            {section.title && (
              <p className="px-2 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">{section.title}</p>
            )}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      clsx(
                        'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition focus-visible:outline-2 focus-visible:outline-accent',
                        isActive ? 'bg-surface-2 font-medium text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon aria-hidden className={clsx('size-4', isActive && 'text-accent')} />
                        {item.label}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <UserMenu />
    </div>
  );
}

function UserMenu() {
  const { t, i18n } = useTranslation('admin');
  const { user } = useSession();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const logout = useAdminMutation(() => api.post('/api/auth/logout'), {
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ['admin'] });
      queryClient.removeQueries({ queryKey: ['auth', 'session'] });
      await navigate('/admin/login', { replace: true });
    },
  });

  const lang = i18n.resolvedLanguage ?? 'en';
  const optionClass = (active: boolean) =>
    clsx(
      'rounded-md px-2 py-1 text-xs transition focus-visible:outline-2 focus-visible:outline-accent',
      active ? 'bg-surface-2 font-medium text-fg' : 'text-muted hover:text-fg',
    );

  return (
    <div ref={ref} className="relative border-t border-border p-2">
      {open && (
        <div
          id={menuId}
          className="absolute right-2 bottom-full left-2 mb-1 flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 shadow-lg"
        >
          <div>
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted">{user.email}</p>
            <p className="mt-0.5 text-xs text-muted">{t(`roles.${user.role}`)}</p>
          </div>
          <div role="group" aria-label={t('userMenu.language')}>
            <p className="mb-1 text-xs text-muted">{t('userMenu.language')}</p>
            <div className="flex gap-1">
              {LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  type="button"
                  aria-pressed={lang === l.code}
                  className={optionClass(lang === l.code)}
                  onClick={() => void i18n.changeLanguage(l.code)}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <div role="group" aria-label={t('userMenu.theme')}>
            <p className="mb-1 text-xs text-muted">{t('userMenu.theme')}</p>
            <div className="flex gap-1">
              {(['system', 'light', 'dark'] as ThemePreference[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={theme.preference === p}
                  className={optionClass(theme.preference === p)}
                  onClick={() => theme.setPreference(p)}
                >
                  {t(`common:theme.${p}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-0.5 border-t border-border pt-2 text-sm">
            {user.hasPassword && (
              <button
                type="button"
                className="rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
                onClick={() => {
                  setOpen(false);
                  setPwOpen(true);
                }}
              >
                {t('userMenu.changePassword')}
              </button>
            )}
            <Link to="/" className="flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-surface-2">
              {t('userMenu.viewStatusPage')}
              <ExternalLink aria-hidden className="size-3.5 text-muted" />
            </Link>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-status-major-outage-text hover:bg-surface-2"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              <LogOut aria-hidden className="size-3.5" />
              {t('userMenu.logout')}
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent">
          {user.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{user.name}</span>
          <span className="block truncate text-xs text-muted">{t('userMenu.label')}</span>
        </span>
        <ChevronUp aria-hidden className={clsx('size-4 text-muted transition', !open && 'rotate-180')} />
      </button>
      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const empty = { currentPassword: '', newPassword: '', confirm: '' };
  const form = useForm(empty);
  const mutation = useAdminMutation((body: { currentPassword: string; newPassword: string }) => api.post('/api/auth/password', body, { type: 'passwords' }), {
    success: t('userMenu.passwordChanged'),
    onSuccess: () => {
      form.setValues(empty);
      onClose();
    },
    onError: (err) => {
      if (form.applyServerError(err)) return true;
      if (err instanceof ApiError && err.body?.error === 'invalid_password') {
        form.setErrors({ currentPassword: { key: 'validation.wrongPassword' } });
        return true;
      }
      return false;
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = form.validate(ChangePasswordInput, {
      currentPassword: form.values.currentPassword,
      newPassword: form.values.newPassword,
    });
    if (!body) return;
    if (form.values.newPassword !== form.values.confirm) {
      form.setErrors({ confirm: { key: 'validation.passwordMismatch' } });
      return;
    }
    mutation.mutate(body);
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('userMenu.changePassword')}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <TextField
          label={t('userMenu.currentPassword')}
          type="password"
          autoComplete="current-password"
          value={form.values.currentPassword}
          onValue={(v) => form.set('currentPassword', v)}
          error={form.error('currentPassword')}
          required
        />
        <TextField
          label={t('userMenu.newPassword')}
          type="password"
          autoComplete="new-password"
          value={form.values.newPassword}
          onValue={(v) => form.set('newPassword', v)}
          error={form.error('newPassword')}
          help={t('users.passwordHelp')}
          required
        />
        <TextField
          label={t('userMenu.confirmPassword')}
          type="password"
          autoComplete="new-password"
          value={form.values.confirm}
          onValue={(v) => form.set('confirm', v)}
          error={form.error('confirm')}
          required
        />
        <p className="text-xs text-muted">{t('userMenu.passwordSessionsHint')}</p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" variant="primary" pending={mutation.isPending}>
            {t('common:actions.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function AdminLayout() {
  const { t } = useTranslation('admin');
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();

  useEffect(() => setDrawer(false), [location.pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <a
        href="#admin-main"
        className="sr-only z-50 rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t('nav.skipToContent')}
      </a>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-border bg-surface lg:block">
        <Sidebar />
      </aside>

      {/* Mobile top bar + drawer */}
      <div className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface px-3 lg:hidden">
        <button
          type="button"
          onClick={() => setDrawer(true)}
          aria-label={t('nav.open')}
          aria-expanded={drawer}
          className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Menu aria-hidden className="size-5" />
        </button>
        <span className="text-sm font-semibold">{t('title')}</span>
      </div>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t('nav.label')}>
          <button type="button" aria-label={t('nav.close')} className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-border bg-surface shadow-xl">
            <button
              type="button"
              onClick={() => setDrawer(false)}
              aria-label={t('nav.close')}
              className="absolute top-3 right-3 z-10 rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X aria-hidden className="size-4" />
            </button>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      <main id="admin-main" className="px-4 py-6 sm:px-6 lg:ml-60 lg:px-8 lg:py-8">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
