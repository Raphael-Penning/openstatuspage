/**
 * /subscribe: email subscription form (double opt-in).
 */
import { SubscribeInput, type SubscriptionLocale } from '@openstatuspage/shared';
import { Loader2, MailCheck, MailX } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ApiError } from '../../lib/api';
import {
  FieldError,
  fieldClass,
  LocaleSelect,
  primaryButton,
  ResultState,
  ScopePicker,
  secondaryButton,
} from '../components/Subscription';
import { Card, ErrorState, PageTitle, Skeleton } from '../components/ui';
import { useSummary } from '../hooks/queries';
import { useSubscribe } from '../hooks/subscriptions';
import {
  knownServiceIds,
  serviceSections,
  subscriptionErrors,
  toSubscriptionLocale,
  type ServiceSection,
  type SubscriptionErrors,
} from '../utils/subscription';
import { usePageHead, useSiteName } from '../head';

export function SubscribePage() {
  const { t } = useTranslation('public');
  const site = useSiteName();
  usePageHead({
    title: t('subscription.title'),
    description: t('seo.subscribe', { site }),
    breadcrumbs: [{ name: t('subscription.title'), path: '/subscribe' }],
  });
  const summary = useSummary();
  const [unavailable, setUnavailable] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const sections = useMemo(
    () => (summary.data ? serviceSections(summary.data.groups, summary.data.ungrouped) : []),
    [summary.data],
  );

  if (summary.isPending) return <SubscribeSkeleton />;
  if (summary.isError) return <ErrorState onRetry={() => void summary.refetch()} />;
  if (!summary.data.emailSubscriptions || unavailable) return <UnavailableState />;
  if (sentTo) return <SentState email={sentTo} />;

  return (
    <div>
      <PageTitle title={t('subscription.title')} subtitle={t('subscription.subtitle')} />
      <SubscribeForm sections={sections} onUnavailable={() => setUnavailable(true)} onSent={setSentTo} />
    </div>
  );
}

function SubscribeForm({
  sections,
  onUnavailable,
  onSent,
}: {
  sections: ServiceSection[];
  onUnavailable: () => void;
  onSent: (email: string) => void;
}) {
  const { t, i18n } = useTranslation('public');
  const emailId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const scopeRef = useRef<HTMLFieldSetElement>(null);
  const [email, setEmail] = useState('');
  const [locale, setLocale] = useState<SubscriptionLocale>(() => toSubscriptionLocale(i18n.resolvedLanguage));
  const [scope, setScope] = useState({ allServices: true, serviceIds: [] as string[] });
  const [website, setWebsite] = useState('');
  const [errors, setErrors] = useState<SubscriptionErrors>({});
  const subscribe = useSubscribe();
  // After a failed submit the focus moves to the first invalid field, once its
  // error is rendered, so the error is announced with it (WCAG 3.3.1).
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (focusRequest === 0) return;
    if (errors.email) emailRef.current?.focus();
    else if (errors.serviceIds) scopeRef.current?.focus();
    // Only on a new request, not on every change of the errors.
  }, [focusRequest]);
  const clearError = (field: keyof SubscriptionErrors) =>
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = SubscribeInput.safeParse({
      email: email.trim(),
      locale,
      allServices: scope.allServices,
      serviceIds: scope.allServices ? [] : knownServiceIds(scope.serviceIds, sections),
    });
    if (!parsed.success) {
      const next = subscriptionErrors(parsed.error.issues);
      setErrors(next);
      setFocusRequest((n) => n + 1);
      return;
    }
    setErrors({});
    // The honeypot is only sent when a bot filled it in; the server rejects it then.
    subscribe.mutate(website ? { ...parsed.data, website } : parsed.data, {
      onSuccess: () => onSent(parsed.data.email),
      onError: (error) => {
        if (error instanceof ApiError && error.status === 404) return onUnavailable();
        if (error instanceof ApiError && error.status === 400) {
          setErrors(subscriptionErrors(error.body?.issues));
          return setFocusRequest((n) => n + 1);
        }
        if (error instanceof ApiError && error.status === 429) return setErrors({ form: 'subscription.errors.rateLimited' });
        setErrors({ form: 'subscription.errors.generic' });
      },
    });
  };

  return (
    <Card className="mx-auto max-w-2xl">
      <form onSubmit={submit} noValidate className="relative flex flex-col gap-6 p-5 sm:p-8">
        <div className="grid gap-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={emailId} className="text-sm font-medium">
              {t('subscription.email')}
            </label>
            <input
              ref={emailRef}
              id={emailId}
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              placeholder={t('subscription.emailPlaceholder')}
              onChange={(e) => {
                setEmail(e.target.value);
                clearError('email');
              }}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? `${emailId}-error` : undefined}
              className={fieldClass}
            />
            <FieldError id={`${emailId}-error`}>{errors.email && t(errors.email)}</FieldError>
          </div>
          <LocaleSelect value={locale} onChange={setLocale} />
        </div>

        <ScopePicker
          ref={scopeRef}
          value={scope}
          onChange={(v) => {
            setScope(v);
            clearError('serviceIds');
          }}
          sections={sections}
          error={errors.serviceIds && t(errors.serviceIds)}
        />

        {/* Honeypot: invisible to people and assistive technology, bots tend to fill it in. */}
        <div aria-hidden="true" className="pointer-events-none absolute -left-[9999px] size-px overflow-hidden opacity-0">
          <label>
            {t('subscription.honeypot')}
            <input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </label>
        </div>

        <p className="rounded-xl bg-surface-2 px-4 py-3 text-xs text-muted">{t('subscription.privacy')}</p>

        {errors.form && (
          <p role="alert" className="rounded-xl bg-status-major-outage/10 px-4 py-3 text-sm text-status-major-outage-text">
            {t(errors.form)}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link to="/" className={secondaryButton}>
            {t('common:actions.cancel')}
          </Link>
          <button type="submit" className={primaryButton} disabled={subscribe.isPending} aria-busy={subscribe.isPending || undefined}>
            {subscribe.isPending && <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" />}
            {t('subscription.submit')}
          </button>
        </div>
      </form>
    </Card>
  );
}

function SentState({ email }: { email: string }) {
  const { t } = useTranslation('public');
  return (
    <ResultState
      icon={<MailCheck aria-hidden className="size-10 text-status-operational-text" />}
      title={t('subscription.sent.title')}
      actions={
        <Link to="/" className={secondaryButton}>
          {t('subscription.backHome')}
        </Link>
      }
    >
      <p>{t('subscription.sent.description', { email })}</p>
      <p className="text-sm">{t('subscription.sent.hint')}</p>
    </ResultState>
  );
}

function UnavailableState() {
  const { t } = useTranslation('public');
  return (
    <ResultState
      icon={<MailX aria-hidden className="size-10 text-muted" />}
      title={t('subscription.unavailable.title')}
      actions={
        <Link to="/" className={secondaryButton}>
          {t('subscription.backHome')}
        </Link>
      }
    >
      <p>{t('subscription.unavailable.description')}</p>
    </ResultState>
  );
}

function SubscribeSkeleton() {
  return (
    <div className="flex flex-col items-center gap-6">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <Skeleton className="h-96 w-full max-w-2xl rounded-2xl" />
    </div>
  );
}
