/**
 * /subscription/manage?id=…&token=…: change language and scope of a
 * subscription or unsubscribe. The token comes from the emails (or the
 * confirmation page) and is sent as X-Subscription-Token header.
 */
import { SubscriptionPreferencesInput, type PublicSubscription, type SubscriptionLocale } from '@openstatuspage/shared';
import { CircleCheck, Clock, Loader2, MailMinus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { ApiError } from '../../lib/api';
import {
  dangerButton,
  InvalidLinkState,
  LocaleSelect,
  NoReferrer,
  primaryButton,
  ResultState,
  ScopePicker,
  secondaryButton,
} from '../components/Subscription';
import { Card, ErrorState, PageTitle, Skeleton } from '../components/ui';
import { useDocumentTitle } from '../hooks/dom';
import { isNotFound, useSummary } from '../hooks/queries';
import { useDeleteSubscription, useSubscription, useUpdateSubscription } from '../hooks/subscriptions';
import {
  knownServiceIds,
  linkParams,
  serviceSections,
  subscriptionErrors,
  type ServiceSection,
  type SubscriptionErrors,
} from '../utils/subscription';

export function SubscriptionManagePage() {
  const { t } = useTranslation('public');
  useDocumentTitle(t('subscription.manage.title'));
  const [params] = useSearchParams();
  const link = linkParams(params);
  return (
    <>
      <NoReferrer />
      {link ? (
        <Manage
          key={`${link.id}:${link.token}`}
          id={link.id}
          token={link.token}
          // Unsubscribe links in emails add unsubscribe=1: open the confirmation directly.
          startUnsubscribe={params.get('unsubscribe') === '1'}
        />
      ) : (
        <InvalidLinkState />
      )}
    </>
  );
}

function Manage({ id, token, startUnsubscribe }: { id: string; token: string; startUnsubscribe: boolean }) {
  const { t } = useTranslation('public');
  const subscription = useSubscription(id, token);
  const summary = useSummary();
  const [invalid, setInvalid] = useState(false);
  const [removed, setRemoved] = useState<string | null>(null);
  const sections = useMemo(
    () => (summary.data ? serviceSections(summary.data.groups, summary.data.ungrouped) : []),
    [summary.data],
  );

  if (removed !== null) return <UnsubscribedState email={removed} />;
  if (invalid || (subscription.isError && isNotFound(subscription.error))) return <InvalidLinkState />;
  if (subscription.isError) return <ErrorState className="mx-auto max-w-xl" onRetry={() => void subscription.refetch()} />;
  if (summary.isError) return <ErrorState className="mx-auto max-w-xl" onRetry={() => void summary.refetch()} />;
  if (subscription.isPending || summary.isPending) return <ManageSkeleton />;

  return (
    <div>
      <PageTitle title={t('subscription.manage.title')} subtitle={t('subscription.manage.subtitle')} />
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <PreferencesForm
          id={id}
          token={token}
          subscription={subscription.data}
          sections={sections}
          onInvalid={() => setInvalid(true)}
        />
        <UnsubscribeCard
          id={id}
          token={token}
          email={subscription.data.email}
          startConfirming={startUnsubscribe}
          onInvalid={() => setInvalid(true)}
          onRemoved={() => setRemoved(subscription.data.email)}
        />
      </div>
    </div>
  );
}

function PreferencesForm({
  id,
  token,
  subscription,
  sections,
  onInvalid,
}: {
  id: string;
  token: string;
  subscription: PublicSubscription;
  sections: ServiceSection[];
  onInvalid: () => void;
}) {
  const { t } = useTranslation('public');
  const [locale, setLocale] = useState<SubscriptionLocale>(subscription.locale);
  // Services that are no longer public cannot be saved again; drop them up front.
  const [scope, setScope] = useState(() => ({
    allServices: subscription.allServices,
    serviceIds: knownServiceIds(subscription.serviceIds, sections),
  }));
  const [errors, setErrors] = useState<SubscriptionErrors>({});
  const [saved, setSaved] = useState(false);
  const update = useUpdateSubscription(id, token);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const parsed = SubscriptionPreferencesInput.safeParse({
      locale,
      allServices: scope.allServices,
      serviceIds: scope.allServices ? [] : knownServiceIds(scope.serviceIds, sections),
    });
    if (!parsed.success) {
      setErrors(subscriptionErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    update.mutate(parsed.data, {
      onSuccess: (stored) => {
        setLocale(stored.locale);
        setScope({ allServices: stored.allServices, serviceIds: stored.serviceIds });
        setSaved(true);
      },
      onError: (error) => {
        if (isNotFound(error)) return onInvalid();
        if (error instanceof ApiError && error.status === 400) return setErrors(subscriptionErrors(error.body?.issues));
        if (error instanceof ApiError && error.status === 429) return setErrors({ form: 'subscription.errors.rateLimited' });
        setErrors({ form: 'subscription.errors.generic' });
      },
    });
  };

  const change = () => {
    if (saved) setSaved(false);
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate className="flex flex-col gap-6 p-5 sm:p-8">
        <div className="grid gap-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-sm font-medium">{t('subscription.email')}</span>
            <span className="truncate rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm" title={subscription.email}>
              {subscription.email}
            </span>
          </div>
          <LocaleSelect
            value={locale}
            onChange={(v) => {
              setLocale(v);
              change();
            }}
          />
        </div>

        {!subscription.confirmed && (
          <p className="flex items-start gap-2 rounded-xl bg-status-degraded/12 px-4 py-3 text-sm">
            <Clock aria-hidden className="mt-0.5 size-4 shrink-0 text-status-degraded" />
            {t('subscription.manage.pending')}
          </p>
        )}

        <ScopePicker
          value={scope}
          onChange={(v) => {
            setScope(v);
            change();
            if (errors.serviceIds) setErrors({});
          }}
          sections={sections}
          error={errors.serviceIds && t(errors.serviceIds)}
        />

        {errors.form && (
          <p role="alert" className="rounded-xl bg-status-major-outage/10 px-4 py-3 text-sm text-status-major-outage">
            {t(errors.form)}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-3">
          <p role="status" className="flex items-center gap-1.5 text-sm text-status-operational">
            {saved && (
              <>
                <CircleCheck aria-hidden className="size-4" />
                {t('subscription.manage.saved')}
              </>
            )}
          </p>
          <button type="submit" className={primaryButton} disabled={update.isPending} aria-busy={update.isPending || undefined}>
            {update.isPending && <Loader2 aria-hidden className="size-4 animate-spin" />}
            {t('subscription.manage.save')}
          </button>
        </div>
      </form>
    </Card>
  );
}

function UnsubscribeCard({
  id,
  token,
  email,
  startConfirming,
  onInvalid,
  onRemoved,
}: {
  id: string;
  token: string;
  email: string;
  startConfirming: boolean;
  onInvalid: () => void;
  onRemoved: () => void;
}) {
  const { t } = useTranslation('public');
  const [confirming, setConfirming] = useState(startConfirming);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (startConfirming) cardRef.current?.scrollIntoView({ block: 'center' });
  }, [startConfirming]);
  const [failed, setFailed] = useState(false);
  const remove = useDeleteSubscription(id, token);

  const unsubscribe = () => {
    setFailed(false);
    remove.mutate(undefined, {
      onSuccess: onRemoved,
      onError: (error) => (isNotFound(error) ? onInvalid() : setFailed(true)),
    });
  };

  return (
    <div ref={cardRef}>
      <Card as="section" className="flex flex-col gap-3 p-5 sm:p-8">
        <h2 className="text-lg font-semibold">{t('subscription.unsubscribe.title')}</h2>
        <p className="text-sm text-muted">{t('subscription.unsubscribe.description')}</p>
        {confirming ? (
          <div role="group" aria-label={t('subscription.unsubscribe.title')} className="flex flex-col gap-3 rounded-xl border border-status-major-outage/30 bg-status-major-outage/5 p-4">
            <p className="text-sm font-medium">{t('subscription.unsubscribe.confirm', { email })}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={dangerButton} onClick={unsubscribe} disabled={remove.isPending} aria-busy={remove.isPending || undefined}>
                {remove.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <MailMinus aria-hidden className="size-4" />}
                {t('subscription.unsubscribe.confirmButton')}
              </button>
              {/* Focus the safe choice when the confirmation opens. */}
              <button type="button" className={secondaryButton} onClick={() => setConfirming(false)} disabled={remove.isPending} autoFocus>
                {t('subscription.unsubscribe.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button type="button" className={dangerButton} onClick={() => setConfirming(true)}>
              <MailMinus aria-hidden className="size-4" />
              {t('subscription.unsubscribe.button')}
            </button>
          </div>
        )}
        {failed && (
          <p role="alert" className="text-sm text-status-major-outage">
            {t('subscription.errors.generic')}
          </p>
        )}
      </Card>
    </div>
  );
}

function UnsubscribedState({ email }: { email: string }) {
  const { t } = useTranslation('public');
  return (
    <ResultState
      icon={<MailMinus aria-hidden className="size-10 text-muted" />}
      title={t('subscription.unsubscribe.done')}
      actions={
        <>
          <Link to="/subscribe" className={primaryButton}>
            {t('subscription.unsubscribe.subscribeAgain')}
          </Link>
          <Link to="/" className={secondaryButton}>
            {t('subscription.backHome')}
          </Link>
        </>
      }
    >
      <p>{t('subscription.unsubscribe.doneDescription', { email })}</p>
    </ResultState>
  );
}

function ManageSkeleton() {
  return (
    <div className="flex flex-col items-center gap-6">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <Skeleton className="h-80 w-full max-w-2xl rounded-2xl" />
      <Skeleton className="h-36 w-full max-w-2xl rounded-2xl" />
    </div>
  );
}
