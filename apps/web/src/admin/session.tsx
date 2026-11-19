/**
 * Session handling for the management UI: auth guard, role helpers and the
 * shared admin root (toasts, accent color).
 */
import { deserialize, JSONAPI_MEDIA_TYPE, type DataDocument, type PublicPageSettings, type SessionInfo } from '@openstatuspage/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Outlet, useLocation } from 'react-router';
import { ApiError } from '../lib/api';
import { useAccentColor } from '../lib/theme';
import { ToastProvider } from './components/Toast';
import { ErrorState, LoadingState } from './components/ui';
import { keys, useSessionQuery } from './lib/queries';

const SessionContext = createContext<SessionInfo | null>(null);

export function useSession(): SessionInfo {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside RequireSession');
  return ctx;
}

export function useIsAdmin(): boolean {
  return useSession().user.role === 'admin';
}

/** Public branding (site name, accent color); available without login. */
export function useBranding() {
  return useQuery({
    queryKey: ['public', 'settings'],
    // Public responses are cacheable for 30 s; revalidate so saved settings show up immediately.
    queryFn: async () => {
      const res = await fetch('/api/public/settings', {
        cache: 'no-cache',
        credentials: 'same-origin',
        headers: { accept: JSONAPI_MEDIA_TYPE },
      });
      if (!res.ok) throw new ApiError(res.status, null);
      return deserialize<PublicPageSettings>((await res.json()) as DataDocument);
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Only allows a same-app path below /admin as post-login target (no open redirects). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/admin') || next.startsWith('//') || next.startsWith('/admin/login')) return '/admin';
  return next;
}

/** Root element of every /admin route. */
export function AdminRoot() {
  const branding = useBranding();
  useAccentColor(branding.data?.accentColor);
  const { t } = useTranslation('admin');
  useEffect(() => {
    const site = branding.data?.siteName;
    document.title = site ? `${t('title')} · ${site}` : t('title');
  }, [branding.data?.siteName, t]);
  return (
    <ToastProvider>
      <Outlet />
    </ToastProvider>
  );
}

/** Auth guard: redirects to the login page (and back afterwards) without a session. */
export function RequireSession({ children }: { children: ReactNode }) {
  const session = useSessionQuery();
  const location = useLocation();
  const queryClient = useQueryClient();

  // Any admin request failing with 401 (expired session) re-checks the session, which redirects to the login.
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        const err = event.query.state.error;
        if (
          event.type === 'updated' &&
          event.query.queryKey[0] === 'admin' &&
          err instanceof ApiError &&
          err.status === 401
        ) {
          void queryClient.invalidateQueries({ queryKey: keys.session });
        }
      }),
    [queryClient],
  );

  // Checked before `data`: a failed refetch keeps the stale session data of an expired session.
  if (session.error instanceof ApiError && session.error.status === 401) {
    const next = `${location.pathname}${location.search}`;
    const target = next === '/admin' || next === '/admin/' ? '/admin/login' : `/admin/login?next=${encodeURIComponent(next)}`;
    return <Navigate to={target} replace />;
  }
  if (session.data) return <SessionContext.Provider value={session.data}>{children}</SessionContext.Provider>;
  if (session.error) {
    return (
      <div className="min-h-dvh bg-bg">
        <ErrorState error={session.error} onRetry={() => void session.refetch()} />
      </div>
    );
  }
  return (
    <div className="min-h-dvh bg-bg">
      <LoadingState />
    </div>
  );
}

/** Wraps admin-only pages; editors get a notice instead. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const isAdmin = useIsAdmin();
  const { t } = useTranslation('admin');
  if (!isAdmin) {
    return (
      <div role="alert" className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-muted">
        {t('errors.adminOnly')}
      </div>
    );
  }
  return <>{children}</>;
}
