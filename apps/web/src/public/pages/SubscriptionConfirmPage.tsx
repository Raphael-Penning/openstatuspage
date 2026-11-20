/**
 * /subscription/confirm?id=…#token=…: target of the double opt-in email. The
 * token sits in the URL fragment so it never reaches the server or its logs.
 */
import type { PublicSubscription } from '@openstatuspage/shared';
import { Loader2, MailCheck, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { InvalidLinkState, NoReferrer, primaryButton, ResultState, secondaryButton } from '../components/Subscription';
import { useHydrated } from '../../lib/ssr';
import { ErrorState } from '../components/ui';
import { isNotFound } from '../hooks/queries';
import { useConfirmSubscription } from '../hooks/subscriptions';
import { linkParams, managePath } from '../utils/subscription';
import { usePageHead } from '../head';

export function SubscriptionConfirmPage() {
  const { t } = useTranslation('public');
  // Personal links: never indexed.
  usePageHead({ title: t('subscription.confirm.title'), robots: 'noindex', canonical: null });
  const [params] = useSearchParams();
  const { hash } = useLocation();
  // The token is in the fragment, which the server never sees: decide after hydration.
  const hydrated = useHydrated();
  const link = hydrated ? linkParams(params, hash) : null;
  return (
    <>
      <NoReferrer />
      {!hydrated ? (
        <Checking />
      ) : link ? (
        <Confirm key={`${link.id}:${link.token}`} id={link.id} token={link.token} />
      ) : (
        <InvalidLinkState />
      )}
    </>
  );
}

function Checking() {
  const { t } = useTranslation('public');
  return (
    <ResultState
      icon={<Loader2 aria-hidden className="size-10 motion-safe:animate-spin text-muted" />}
      title={t('subscription.confirm.loading')}
    />
  );
}

function Confirm({ id, token }: { id: string; token: string }) {
  const { t } = useTranslation('public');
  const navigate = useNavigate();
  const confirm = useConfirmSubscription(id, token);

  if (confirm.isPending) return <Checking />;
  if (confirm.isError) {
    if (isNotFound(confirm.error)) return <InvalidLinkState />;
    return <ErrorState className="mx-auto max-w-xl" onRetry={() => void confirm.refetch()} />;
  }

  const { subscription, manageToken } = confirm.data;
  return (
    <ResultState
      icon={<MailCheck aria-hidden className="size-10 text-status-operational-text" />}
      title={t('subscription.confirm.success')}
      actions={
        <>
          <button type="button" className={primaryButton} onClick={() => void navigate(managePath(subscription.id, manageToken))}>
            <SlidersHorizontal aria-hidden className="size-4" />
            {t('subscription.confirm.manage')}
          </button>
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
