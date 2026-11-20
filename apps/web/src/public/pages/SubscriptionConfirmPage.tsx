/**
 * /subscription/confirm?id=…&token=…: target of the double opt-in email.
 *
 * The page asks for one click (a form posting to /subscription/confirm), so a
 * mail scanner that opens the link confirms nothing. Without JavaScript the
 * form handler confirms and redirects to the manage page; with JavaScript the
 * page confirms through the JSON:API and shows the result in place. Older
 * links carry the token in the URL fragment, which only the browser sees.
 */
import { FORM_PATHS, type PublicSubscription } from '@openstatuspage/shared';
import { Loader2, MailCheck, MailQuestion, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useHydrated, useServerForm } from '../../lib/ssr';
import { NoScript } from '../components/NoScript';
import { ErrorSummary, InvalidLinkState, NoReferrer, primaryButton, ResultState, secondaryButton } from '../components/Subscription';
import { ErrorState } from '../components/ui';
import { usePageHead } from '../head';
import { isNotFound } from '../hooks/queries';
import { useConfirmSubscription } from '../hooks/subscriptions';
import { linkParams, managePath, serverFormErrors } from '../utils/subscription';

export function SubscriptionConfirmPage() {
  const { t } = useTranslation('public');
  // Personal links: never indexed.
  usePageHead({ title: t('subscription.confirm.title'), robots: 'noindex', canonical: null });
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const hydrated = useHydrated();
  // The server sees a token in the query; one in the fragment only after hydration.
  const link = linkParams(params, hydrated ? hash : '');
  const waitForFragment = !hydrated && !link && params.has('id');
  return (
    <>
      <NoReferrer />
      {params.get('error') === 'invalid' ? (
        <InvalidLinkState />
      ) : link ? (
        <Confirm key={`${link.id}:${link.token}`} id={link.id} token={link.token} />
      ) : waitForFragment ? (
        <Checking needsScript />
      ) : (
        <InvalidLinkState />
      )}
    </>
  );
}

function Checking({ needsScript = false }: { needsScript?: boolean }) {
  const { t } = useTranslation('public');
  return (
    <ResultState
      icon={<Loader2 aria-hidden className="size-10 motion-safe:animate-spin text-muted" />}
      title={t('subscription.confirm.loading')}
    >
      {needsScript && (
        <NoScript>
          <p>{t('subscription.confirm.needsScript')}</p>
        </NoScript>
      )}
    </ResultState>
  );
}

/** The confirmation form; with JavaScript the result replaces it. */
function Confirm({ id, token }: { id: string; token: string }) {
  const { t } = useTranslation('public');
  const [started, setStarted] = useState(false);
  const confirm = useConfirmSubscription(id, token, started);
  const serverForm = useServerForm();
  const [params] = useSearchParams();
  const errors = serverFormErrors(serverForm, params.get('error'));

  if (started) {
    if (confirm.isPending) return <Checking />;
    if (confirm.isError) {
      if (isNotFound(confirm.error)) return <InvalidLinkState />;
      return <ErrorState className="mx-auto max-w-xl" onRetry={() => void confirm.refetch()} />;
    }
    return <Confirmed subscription={confirm.data.subscription} manageToken={confirm.data.manageToken} />;
  }

  return (
    <ResultState icon={<MailQuestion aria-hidden className="size-10 text-muted" />} title={t('subscription.confirm.title')}>
      <p>{t('subscription.confirm.intro')}</p>
      <form
        method="post"
        action={FORM_PATHS.confirm}
        className="mt-2 flex flex-col items-center gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setStarted(true);
        }}
      >
        {errors.form && <ErrorSummary problems={[{ message: t(errors.form) }]} />}
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="token" value={token} />
        <button type="submit" className={primaryButton}>
          <MailCheck aria-hidden className="size-4" />
          {t('subscription.confirm.button')}
        </button>
      </form>
    </ResultState>
  );
}

function Confirmed({ subscription, manageToken }: { subscription: PublicSubscription; manageToken: string }) {
  const { t } = useTranslation('public');
  return (
    <ResultState
      icon={<MailCheck aria-hidden className="size-10 text-status-operational-text" />}
      title={t('subscription.confirm.success')}
      actions={
        <>
          <Link to={managePath(subscription.id, manageToken)} className={primaryButton}>
            <SlidersHorizontal aria-hidden className="size-4" />
            {t('subscription.confirm.manage')}
          </Link>
          <Link to="/" className={secondaryButton}>
            {t('subscription.backHome')}
          </Link>
        </>
      }
    >
      <p>
        <ScopeSentence subscription={subscription} />
      </p>
      <p className="text-sm">{t('subscription.confirm.hint')}</p>
    </ResultState>
  );
}

/** "We will email <address> about …" for the confirmed scope. */
function ScopeSentence({ subscription }: { subscription: PublicSubscription }) {
  const { t } = useTranslation('public');
  return subscription.allServices
    ? t('subscription.confirm.scopeAll', { email: subscription.email })
    : t('subscription.confirm.scopeServices', { email: subscription.email, count: subscription.serviceIds.length });
}
