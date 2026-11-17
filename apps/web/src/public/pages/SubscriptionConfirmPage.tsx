/**
 * /subscription/confirm?id=…&token=…: target of the double opt-in email.
 */
import type { PublicSubscription } from '@openstatuspage/shared';
import { Loader2, MailCheck, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { InvalidLinkState, NoReferrer, primaryButton, ResultState, secondaryButton } from '../components/Subscription';
import { ErrorState } from '../components/ui';
import { useDocumentTitle } from '../hooks/dom';
import { isNotFound } from '../hooks/queries';
import { useConfirmSubscription } from '../hooks/subscriptions';
import { linkParams, managePath } from '../utils/subscription';

export function SubscriptionConfirmPage() {
  const { t } = useTranslation('public');
  useDocumentTitle(t('subscription.confirm.title'));
  const [params] = useSearchParams();
  const link = linkParams(params);
  return (
    <>
      <NoReferrer />
      {link ? <Confirm key={`${link.id}:${link.token}`} id={link.id} token={link.token} /> : <InvalidLinkState />}
    </>
  );
}

function Confirm({ id, token }: { id: string; token: string }) {
  const { t } = useTranslation('public');
  const navigate = useNavigate();
  const confirm = useConfirmSubscription(id, token);

  if (confirm.isPending) {
    return (
      <ResultState
        icon={<Loader2 aria-hidden className="size-10 animate-spin text-muted" />}
        title={t('subscription.confirm.loading')}
      />
    );
  }
  if (confirm.isError) {
    if (isNotFound(confirm.error)) return <InvalidLinkState />;
    return <ErrorState className="mx-auto max-w-xl" onRetry={() => void confirm.refetch()} />;
  }

  const { subscription, manageToken } = confirm.data;
  return (
    <ResultState
      icon={<MailCheck aria-hidden className="size-10 text-status-operational" />}
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
