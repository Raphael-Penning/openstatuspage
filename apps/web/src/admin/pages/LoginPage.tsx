import { LoginInput, OIDC_LOGIN_ERRORS, type SessionInfo } from '@openstatuspage/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError } from '../../lib/api';
import { TextField } from '../components/fields';
import { Button, buttonClass, LoadingState } from '../components/ui';
import { apiErrorMessage } from '../lib/errors';
import { keys, useAuthConfig, useSessionQuery } from '../lib/queries';
import { useForm } from '../lib/useForm';
import { safeNext, useBranding } from '../session';

const KNOWN_ERRORS: readonly string[] = OIDC_LOGIN_ERRORS;

export default function LoginPage() {
  const { t } = useTranslation('admin');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const config = useAuthConfig();
  const session = useSessionQuery();
  const branding = useBranding();
  const next = safeNext(params.get('next'));
  const errorCode = params.get('error');
  const form = useForm({ email: '', password: '' });
  const ssoProviders = config.data?.oidcProviders ?? [];

  const login = useMutation({
    mutationFn: (body: LoginInput) => api.post<SessionInfo>('/api/auth/login', body, { type: 'sessions' }),
    onSuccess: async (info) => {
      queryClient.setQueryData(keys.session, info);
      await navigate(next, { replace: true });
    },
  });

  // An expired session keeps stale data next to its 401 error.
  if (session.data && !session.error) return <Navigate to={next} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = form.validate(LoginInput, { email: form.values.email.trim(), password: form.values.password });
    if (body) login.mutate(body);
  };

  const loginError =
    login.error instanceof ApiError && login.error.status === 401
      ? t('login.invalidCredentials')
      : login.error
        ? apiErrorMessage(login.error, t)
        : null;
  const redirectError = errorCode
    ? t(`login.errors.${KNOWN_ERRORS.includes(errorCode) ? errorCode : 'unknown'}`)
    : null;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10 text-fg">
      <main className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          {branding.data?.logoUrl ? (
            <img src={branding.data.logoUrl} alt="" className="h-10 w-auto" />
          ) : (
            <span aria-hidden className="size-10 rounded-xl bg-accent" />
          )}
          <h1 className="text-xl font-semibold">{t('login.title')}</h1>
          <p className="text-sm text-muted">{branding.data?.siteName ?? t('title')}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
          {config.isPending ? (
            <LoadingState />
          ) : (
            <div className="flex flex-col gap-5">
              {(redirectError || loginError) && (
                <p role="alert" className="rounded-lg bg-status-major-outage/10 px-3 py-2 text-sm text-status-major-outage-text">
                  {loginError ?? redirectError}
                </p>
              )}
              {config.data?.localLoginEnabled !== false && (
                <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                  <TextField
                    label={t('login.email')}
                    type="email"
                    autoComplete="username"
                    value={form.values.email}
                    onValue={(v) => form.set('email', v)}
                    error={form.error('email')}
                    required
                    autoFocus
                  />
                  <TextField
                    label={t('login.password')}
                    type="password"
                    autoComplete="current-password"
                    value={form.values.password}
                    onValue={(v) => form.set('password', v)}
                    error={form.error('password')}
                    required
                  />
                  <Button type="submit" variant="primary" pending={login.isPending} className="w-full">
                    {t('login.submit')}
                  </Button>
                </form>
              )}
              {ssoProviders.length > 0 && (
                <>
                  {config.data?.localLoginEnabled && (
                    <div className="flex items-center gap-3 text-xs text-muted">
                      <span className="h-px flex-1 bg-border" />
                      {t('login.or')}
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  )}
                  {/* Full page navigation: the server redirects to the identity provider. */}
                  <ul className="flex flex-col gap-2" aria-label={t('login.ssoProviders')}>
                    {ssoProviders.map((provider) => (
                      <li key={provider.id}>
                        <a href={provider.loginPath} className={buttonClass('secondary', 'md', 'w-full')}>
                          <KeyRound aria-hidden className="size-4" />
                          {t('login.sso', { label: provider.label })}
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {config.data && !config.data.localLoginEnabled && ssoProviders.length === 0 && (
                <p className="text-sm text-muted">{t('login.noMethods')}</p>
              )}
            </div>
          )}
        </div>
        <p className="mt-4 text-center text-sm">
          <a href="/" className="text-muted hover:text-fg">
            {t('userMenu.viewStatusPage')}
          </a>
        </p>
      </main>
    </div>
  );
}
