/**
 * /subscription/manage?id=…&token=…: change language and scope of a
 * subscription or unsubscribe.
 *
 * The server renders the page for a token in the query (the links of the
 * emails and of the confirmation), and its forms post to the form handlers
 * /subscription/manage and /subscription/unsubscribe, so everything works
 * without JavaScript. The handlers redirect back with a flag the page shows:
 * ?saved=1, ?confirmed=1, ?unsubscribed=1, ?error=invalid; ?unsubscribe=1 opens
 * the unsubscribe confirmation. With JavaScript the page uses the JSON:API
 * (token in the X-Subscription-Token header) and also accepts the token in the
 * URL fragment of older links.
 */
import { FORM_PATHS, type PublicSubscription, type SubscriptionLocale } from '@openstatuspage/shared';
import { CircleCheck, Clock, Loader2, MailMinus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useSearchParams } from 'react-router';
import { ApiError } from '../../lib/api';
import { useHydrated, useServerForm } from '../../lib/ssr';
import { NoScript } from '../components/NoScript';
import {
  dangerButton,
  ErrorSummary,
  InvalidLinkState,
  LocaleSelect,
  NoReferrer,
  primaryButton,
  ResultState,
  SCOPE_FIELD_ID,
  ScopePicker,
  secondaryButton,
} from '../components/Subscription';
import { Card, ErrorState, PageTitle, Skeleton } from '../components/ui';
import { usePageHead } from '../head';
import { isNotFound, useSummary } from '../hooks/queries';
import { useDeleteSubscription, useSubscription, useUpdateSubscription } from '../hooks/subscriptions';
import {
  formScope,
  formValue,
  knownServiceIds,
  linkParams,
  managePath,
  serverFormErrors,
  serviceSections,
  subscriptionErrors,
  toSubscriptionLocale,
  type ServiceSection,
  type SubscriptionErrors,
} from '../utils/subscription';
import { loadSchemas } from '../utils/schemas';

export function SubscriptionManagePage() {
  const { t } = useTranslation('public');
  const [params] = useSearchParams();
  const serverForm = useServerForm();
  const hasErrors = Object.keys(serverFormErrors(serverForm, null)).length > 0;
  // Personal links: never indexed.
  usePageHead({
    title: hasErrors ? t('subscription.errors.titlePrefix', { title: t('subscription.manage.title') }) : t('subscription.manage.title'),
    robots: 'noindex',
    canonical: null,
  });
  const { hash } = useLocation();
  const hydrated = useHydrated();
  // The server sees a token in the query; one in the fragment only after hydration.
  const link = linkParams(params, hydrated ? hash : '');
  const waitForFragment = !hydrated && !link && params.has('id');
  return (
    <>
      <NoReferrer />
      {params.get('unsubscribed') === '1' ? (
        <UnsubscribedState email={null} />
      ) : params.get('error') === 'invalid' ? (
        <InvalidLinkState />
      ) : link ? (
        <Manage
          key={`${link.id}:${link.token}`}
          id={link.id}
          token={link.token}
          // Unsubscribe links in emails add unsubscribe=1: open the confirmation directly.
          startUnsubscribe={params.get('unsubscribe') === '1'}
          saved={params.get('saved') === '1'}
          confirmed={params.get('confirmed') === '1'}
        />
      ) : waitForFragment ? (
        <>
          <ManageSkeleton />
          <NoScript>
            <p className="mt-6 text-center text-muted">{t('subscription.confirm.needsScript')}</p>
          </NoScript>
        </>
      ) : (
        <InvalidLinkState />
      )}
    </>
  );
}

function Manage({
  id,
  token,
  startUnsubscribe,
  saved,
  confirmed,
}: {
  id: string;
  token: string;
  startUnsubscribe: boolean;
  saved: boolean;
  confirmed: boolean;
}) {
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
        {confirmed && (
          <p role="status" className="flex items-start gap-2 rounded-xl bg-status-operational/12 px-4 py-3 text-sm">
            <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-status-operational-text" />
            {t('subscription.manage.confirmed')}
          </p>
        )}
        <PreferencesForm
          id={id}
          token={token}
          subscription={subscription.data}
          sections={sections}
          savedBefore={saved}
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
  savedBefore,
  onInvalid,
}: {
  id: string;
  token: string;
  subscription: PublicSubscription;
  sections: ServiceSection[];
  /** The form handler saved the preferences and redirected here (?saved=1). */
  savedBefore: boolean;
  onInvalid: () => void;
}) {
  const { t } = useTranslation('public');
  // What the server answered to a form sent without JavaScript (values and errors).
  const serverForm = useServerForm();
  const [locale, setLocale] = useState<SubscriptionLocale>(() =>
    serverForm ? toSubscriptionLocale(formValue(serverForm, 'locale')) : subscription.locale,
  );
  // Services that are no longer public cannot be saved again; drop them up front.
  const [scope, setScope] = useState(() =>
    serverForm
      ? formScope(serverForm, sections)
      : { allServices: subscription.allServices, serviceIds: knownServiceIds(subscription.serviceIds, sections) },
  );
  const [errors, setErrors] = useState<SubscriptionErrors>(() => serverFormErrors(serverForm, null));
  const [saved, setSaved] = useState(savedBefore && !serverForm);
  const update = useUpdateSubscription(id, token);
  const scopeRef = useRef<HTMLFieldSetElement>(null);
  // Focus the service selection once its error is rendered (WCAG 3.3.1).
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (focusRequest > 0 && errors.serviceIds) scopeRef.current?.focus();
    // Only on a new request, not on every change of the errors.
  }, [focusRequest]);

  useEffect(() => {
    void loadSchemas();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const { SubscriptionPreferencesInput } = await loadSchemas();
    const parsed = SubscriptionPreferencesInput.safeParse({
      locale,
      allServices: scope.allServices,
      serviceIds: scope.allServices ? [] : knownServiceIds(scope.serviceIds, sections),
    });
    if (!parsed.success) {
      setErrors(subscriptionErrors(parsed.error.issues));
      setFocusRequest((n) => n + 1);
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
        if (error instanceof ApiError && error.status === 400) {
          setErrors(subscriptionErrors(error.body?.issues));
          return setFocusRequest((n) => n + 1);
        }
        if (error instanceof ApiError && error.status === 429) return setErrors({ form: 'subscription.errors.rateLimited' });
        setErrors({ form: 'subscription.errors.generic' });
      },
    });
  };

  const change = () => {
    if (saved) setSaved(false);
  };

  const problems = [
    ...(errors.serviceIds ? [{ message: t(errors.serviceIds), field: SCOPE_FIELD_ID }] : []),
    ...(errors.form ? [{ message: t(errors.form) }] : []),
  ];

  return (
    <Card>
      <form method="post" action={FORM_PATHS.manage} onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-6 p-5 sm:p-8">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="token" value={token} />
        <ErrorSummary problems={problems} />
        <div className="grid gap-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-sm font-medium">{t('subscription.email')}</span>
            <span className="rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm break-all">{subscription.email}</span>
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
            <Clock aria-hidden className="mt-0.5 size-4 shrink-0 text-status-degraded-text" />
            {t('subscription.manage.pending')}
          </p>
        )}

        <ScopePicker
          ref={scopeRef}
          value={scope}
          onChange={(v) => {
            setScope(v);
            change();
            if (errors.serviceIds) setErrors({});
          }}
          sections={sections}
          error={errors.serviceIds && t(errors.serviceIds)}
        />

        <div className="flex flex-wrap items-center justify-end gap-3">
          <p role="status" className="flex items-center gap-1.5 text-sm text-status-operational-text">
            {saved && (
              <>
                <CircleCheck aria-hidden className="size-4" />
                {t('subscription.manage.saved')}
              </>
            )}
          </p>
          <button type="submit" className={primaryButton} disabled={update.isPending} aria-busy={update.isPending || undefined}>
            {update.isPending && <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" />}
            {t('subscription.manage.save')}
          </button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Unsubscribing takes two steps: a link opens the confirmation (?unsubscribe=1,
 * also from the email), whose form posts to /subscription/unsubscribe. With
 * JavaScript both steps happen in place.
 */
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
  // After a switch in place, the focus goes to the safe choice (opened) or back to the button (cancelled).
  const cancelRef = useRef<HTMLAnchorElement>(null);
  const openRef = useRef<HTMLAnchorElement>(null);
  const switched = useRef(false);
  useEffect(() => {
    if (!switched.current) return;
    (confirming ? cancelRef : openRef).current?.focus();
  }, [confirming]);
  const toggle = (next: boolean) => {
    switched.current = true;
    setConfirming(next);
  };

  const unsubscribe = (e: FormEvent) => {
    e.preventDefault();
    setFailed(false);
    remove.mutate(undefined, {
      onSuccess: onRemoved,
      onError: (error) => (isNotFound(error) ? onInvalid() : setFailed(true)),
    });
  };

  return (
    <div ref={cardRef} id="unsubscribe">
      <Card as="section" className="flex flex-col gap-3 p-5 sm:p-8">
        <h2 className="text-lg font-semibold">{t('subscription.unsubscribe.title')}</h2>
        <p className="text-sm text-muted">{t('subscription.unsubscribe.description')}</p>
        {confirming ? (
          <form
            method="post"
            action={FORM_PATHS.unsubscribe}
            onSubmit={unsubscribe}
            aria-label={t('subscription.unsubscribe.title')}
            className="flex flex-col gap-3 rounded-xl border border-status-major-outage/30 bg-status-major-outage/5 p-4"
          >
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="token" value={token} />
            <p className="text-sm font-medium">{t('subscription.unsubscribe.confirm', { email })}</p>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={dangerButton} disabled={remove.isPending} aria-busy={remove.isPending || undefined}>
                {remove.isPending ? <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" /> : <MailMinus aria-hidden className="size-4" />}
                {t('subscription.unsubscribe.confirmButton')}
              </button>
              {/* The safe choice: back to the page without the confirmation. */}
              <Link
                ref={cancelRef}
                to={managePath(id, token)}
                replace
                preventScrollReset
                className={secondaryButton}
                onClick={(e) => {
                  e.preventDefault();
                  toggle(false);
                }}
              >
                {t('subscription.unsubscribe.cancel')}
              </Link>
            </div>
          </form>
        ) : (
          <div>
            <Link
              ref={openRef}
              to={`${managePath(id, token, { unsubscribe: true })}#unsubscribe`}
              className={dangerButton}
              onClick={(e) => {
                e.preventDefault();
                toggle(true);
              }}
            >
              <MailMinus aria-hidden className="size-4" />
              {t('subscription.unsubscribe.button')}
            </Link>
          </div>
        )}
        {failed && (
          <p role="alert" className="text-sm text-status-major-outage-text">
            {t('subscription.errors.generic')}
          </p>
        )}
      </Card>
    </div>
  );
}

function UnsubscribedState({ email }: { email: string | null }) {
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
      <p>{email ? t('subscription.unsubscribe.doneDescription', { email }) : t('subscription.unsubscribe.doneDescriptionGeneric')}</p>
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
