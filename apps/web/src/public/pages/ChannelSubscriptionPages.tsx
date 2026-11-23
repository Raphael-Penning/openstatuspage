/**
 * Webhook and SMS subscriptions (besides email, see SubscribePage):
 *
 *   /subscribe/webhook                    kind (Discord, Slack, Teams, generic when allowed) and URL
 *   /subscribe/sms                        phone number (allowed countries only)
 *   /subscription/verify?ref=…&channel=…  the 6-digit code of the confirmation message
 *   /subscription/channel?id=…&token=…    details, preferences, unsubscribe (the link of every message)
 *
 * Every page is a plain form posting to the server's form handlers (FORM_PATHS),
 * which answer invalid input with the page itself (422, values and errors) and
 * success with a redirect: they work the same with and without JavaScript.
 */
import {
  FORM_PATHS,
  type ChannelOptions,
  type PublicChannelSubscription,
  type SubscriptionLocale,
  type WebhookKind,
} from '@openstatuspage/shared';
import clsx from 'clsx';
import { CircleCheck, KeyRound, MailMinus, MessageSquareText, Webhook } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useServerForm } from '../../lib/ssr';
import {
  dangerButton,
  ErrorSummary,
  FieldError,
  fieldClass,
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
import { usePageHead, useSiteName, VARIANT_HEAD } from '../head';
import { useChannelSubscription } from '../hooks/channel-subscriptions';
import { isNotFound, useSummary } from '../hooks/queries';
import { channelFormErrors, type ChannelErrors } from '../utils/channel-subscription';
import { formScope, formValue, knownServiceIds, serviceSections, toSubscriptionLocale, type ServiceSection } from '../utils/subscription';

const URL_FIELD_ID = 'channel-url';
const KIND_FIELD_ID = 'channel-kind';
const PHONE_FIELD_ID = 'channel-phone';
const CODE_FIELD_ID = 'channel-code';
const NO_CHANNELS: ChannelOptions = { webhookKinds: [], sms: false, smsCallingCodes: [] };

/** Links to the ways to subscribe that this page offers (email, webhook, SMS). */
export function ChannelLinks({
  email,
  channels,
  current,
}: {
  email: boolean;
  /** Undefined from an older API: no channels. */
  channels: ChannelOptions | undefined;
  current: 'email' | 'webhook' | 'sms';
}) {
  const { t } = useTranslation('public');
  const offered = channels ?? NO_CHANNELS;
  const items = [
    ...(email ? [{ key: 'email' as const, to: '/subscribe', label: t('channels.nav.email') }] : []),
    ...(offered.webhookKinds.length > 0 ? [{ key: 'webhook' as const, to: '/subscribe/webhook', label: t('channels.nav.webhook') }] : []),
    ...(offered.sms ? [{ key: 'sms' as const, to: '/subscribe/sms', label: t('channels.nav.sms') }] : []),
  ];
  if (items.length < 2) return null;
  return (
    <nav aria-label={t('channels.nav.label')} className="mx-auto mb-6 flex max-w-2xl flex-wrap justify-center gap-2">
      {items.map((item) => (
        <Link
          key={item.key}
          to={item.to}
          aria-current={item.key === current ? 'page' : undefined}
          className={clsx(
            'rounded-full border px-4 py-2 text-sm font-medium',
            item.key === current ? 'border-accent bg-surface-2' : 'border-border hover:border-accent/60',
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

function errorProblems(t: (key: string) => string, errors: ChannelErrors, fields: Partial<Record<keyof ChannelErrors, string>>) {
  return (Object.keys(errors) as (keyof ChannelErrors)[])
    .filter((k) => errors[k])
    .map((k) => ({ message: t(errors[k]!), field: fields[k] }));
}

function Honeypot() {
  const { t } = useTranslation('public');
  return (
    <div aria-hidden="true" className="pointer-events-none absolute -left-[9999px] size-px overflow-hidden opacity-0">
      <label>
        {t('subscription.honeypot')}
        <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
      </label>
    </div>
  );
}

function SubscribeSkeleton() {
  return (
    <div className="flex flex-col items-center gap-6">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-96 w-full max-w-2xl rounded-2xl" />
    </div>
  );
}

function UnavailableChannel({ title }: { title: string }) {
  const { t } = useTranslation('public');
  return (
    <ResultState
      icon={<Webhook aria-hidden className="size-10 text-muted" />}
      title={title}
      actions={
        <Link to="/" className={secondaryButton}>
          {t('subscription.backHome')}
        </Link>
      }
    >
      <p>{t('channels.unavailable')}</p>
    </ResultState>
  );
}

/** Locale and scope fields shared by the subscribe forms. */
function useCommonFields(sections: ServiceSection[]) {
  const { i18n } = useTranslation('public');
  const serverForm = useServerForm();
  const [locale, setLocale] = useState<SubscriptionLocale>(() => toSubscriptionLocale(formValue(serverForm, 'locale') || i18n.resolvedLanguage));
  const [scope, setScope] = useState(() => (serverForm ? formScope(serverForm, sections) : { allServices: true, serviceIds: [] as string[] }));
  return { serverForm, locale, setLocale, scope, setScope };
}

function SubscribeShell({
  title,
  subtitle,
  current,
  children,
}: {
  title: string;
  subtitle: string;
  current: 'webhook' | 'sms';
  children: (args: { sections: ServiceSection[]; channels: ChannelOptions }) => ReactNode;
}) {
  const { t } = useTranslation('public');
  const site = useSiteName();
  const [params] = useSearchParams();
  const serverForm = useServerForm();
  const hasErrors = Object.keys(channelFormErrors(serverForm, params.get('error'))).length > 0;
  usePageHead({
    title: hasErrors ? t('subscription.errors.titlePrefix', { title }) : title,
    description: t('channels.seo', { site }),
    breadcrumbs: [
      { name: t('subscription.title'), path: '/subscribe' },
      { name: title, path: current === 'sms' ? '/subscribe/sms' : '/subscribe/webhook' },
    ],
    ...(serverForm || params.has('error') ? VARIANT_HEAD : {}),
  });
  const summary = useSummary();
  const sections = useMemo(() => (summary.data ? serviceSections(summary.data.groups, summary.data.ungrouped) : []), [summary.data]);
  if (summary.isPending) return <SubscribeSkeleton />;
  if (summary.isError) return <ErrorState onRetry={() => void summary.refetch()} />;
  const channels = summary.data.channelSubscriptions ?? NO_CHANNELS;
  const offered = current === 'sms' ? channels.sms : channels.webhookKinds.length > 0;
  if (!offered) return <UnavailableChannel title={title} />;
  return (
    <div>
      <PageTitle title={title} subtitle={subtitle} />
      <ChannelLinks email={summary.data.emailSubscriptions} channels={channels} current={current} />
      {children({ sections, channels })}
    </div>
  );
}

export function SubscribeWebhookPage() {
  const { t } = useTranslation('public');
  return (
    <SubscribeShell title={t('channels.webhook.title')} subtitle={t('channels.webhook.subtitle')} current="webhook">
      {({ sections, channels }) => <WebhookForm sections={sections} kinds={channels.webhookKinds} />}
    </SubscribeShell>
  );
}

function WebhookForm({ sections, kinds }: { sections: ServiceSection[]; kinds: WebhookKind[] }) {
  const { t } = useTranslation('public');
  const [params] = useSearchParams();
  const { serverForm, locale, setLocale, scope, setScope } = useCommonFields(sections);
  const errors = channelFormErrors(serverForm, params.get('error'));
  const initialKind = formValue(serverForm, 'kind') as WebhookKind;
  const [kind, setKind] = useState<WebhookKind>(kinds.includes(initialKind) ? initialKind : kinds[0]!);
  const urlError = useId();
  const kindHelp = useId();
  const problems = errorProblems(t, errors, { url: URL_FIELD_ID, kind: KIND_FIELD_ID, serviceIds: SCOPE_FIELD_ID });
  return (
    <Card className="mx-auto max-w-2xl">
      <form method="post" action={FORM_PATHS.subscribeWebhook} noValidate className="relative flex flex-col gap-6 p-5 sm:p-8">
        <ErrorSummary problems={problems} />
        <fieldset id={KIND_FIELD_ID} tabIndex={-1} className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{t('channels.webhook.kind')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {kinds.map((k) => (
              <label
                key={k}
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-border p-3 focus-within:outline-2 focus-within:outline-focus hover:border-accent/60 has-[:checked]:border-accent has-[:checked]:bg-surface-2"
              >
                <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="size-4 accent-[var(--accent)]" />
                <span className="text-sm font-medium">{t(`channels.kinds.${k}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={URL_FIELD_ID} className="text-sm font-medium">
            {t('channels.webhook.url')}
          </label>
          <input
            id={URL_FIELD_ID}
            name="url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={2048}
            defaultValue={formValue(serverForm, 'url')}
            placeholder="https://"
            aria-invalid={errors.url ? true : undefined}
            aria-describedby={clsx(kindHelp, errors.url && urlError)}
            className={fieldClass}
          />
          <p id={kindHelp} className="text-xs text-muted">
            {t(`channels.webhook.help.${kind}`)}
          </p>
          <FieldError id={urlError}>{errors.url && t(errors.url)}</FieldError>
        </div>
        <LocaleSelect value={locale} onChange={setLocale} label={t('channels.language')} />
        <ScopePicker value={scope} onChange={setScope} sections={sections} error={errors.serviceIds && t(errors.serviceIds)} />
        <Honeypot />
        <p className="rounded-xl bg-surface-2 px-4 py-3 text-xs text-muted">{t('channels.webhook.privacy')}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link to="/subscribe" className={secondaryButton}>
            {t('common:actions.cancel')}
          </Link>
          <button type="submit" className={primaryButton}>
            {t('channels.sendCode')}
          </button>
        </div>
      </form>
    </Card>
  );
}

export function SubscribeSmsPage() {
  const { t } = useTranslation('public');
  return (
    <SubscribeShell title={t('channels.sms.title')} subtitle={t('channels.sms.subtitle')} current="sms">
      {({ sections, channels }) => <SmsForm sections={sections} codes={channels.smsCallingCodes} />}
    </SubscribeShell>
  );
}

function SmsForm({ sections, codes }: { sections: ServiceSection[]; codes: string[] }) {
  const { t } = useTranslation('public');
  const [params] = useSearchParams();
  const { serverForm, locale, setLocale, scope, setScope } = useCommonFields(sections);
  const errors = channelFormErrors(serverForm, params.get('error'));
  const phoneError = useId();
  const phoneHelp = useId();
  const problems = errorProblems(t, errors, { phone: PHONE_FIELD_ID, serviceIds: SCOPE_FIELD_ID });
  return (
    <Card className="mx-auto max-w-2xl">
      <form method="post" action={FORM_PATHS.subscribeSms} noValidate className="relative flex flex-col gap-6 p-5 sm:p-8">
        <ErrorSummary problems={problems} />
        <div className="grid gap-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={PHONE_FIELD_ID} className="text-sm font-medium">
              {t('channels.sms.phone')}
            </label>
            <input
              id={PHONE_FIELD_ID}
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              maxLength={32}
              defaultValue={formValue(serverForm, 'phone')}
              placeholder="+49 151 2345678"
              aria-invalid={errors.phone ? true : undefined}
              aria-describedby={clsx(phoneHelp, errors.phone && phoneError)}
              className={fieldClass}
            />
            <p id={phoneHelp} className="text-xs text-muted">
              {t('channels.sms.countries', { codes: codes.map((c) => `+${c}`).join(', ') })}
            </p>
            <FieldError id={phoneError}>{errors.phone && t(errors.phone)}</FieldError>
          </div>
          <LocaleSelect value={locale} onChange={setLocale} label={t('channels.language')} />
        </div>
        <ScopePicker value={scope} onChange={setScope} sections={sections} error={errors.serviceIds && t(errors.serviceIds)} />
        <Honeypot />
        <p className="rounded-xl bg-surface-2 px-4 py-3 text-xs text-muted">{t('channels.sms.privacy')}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link to="/subscribe" className={secondaryButton}>
            {t('common:actions.cancel')}
          </Link>
          <button type="submit" className={primaryButton}>
            {t('channels.sendCode')}
          </button>
        </div>
      </form>
    </Card>
  );
}

/** /subscription/verify?ref=…&channel=…: enter the code of the confirmation message. */
export function VerifyCodePage() {
  const { t } = useTranslation('public');
  const [params] = useSearchParams();
  const serverForm = useServerForm();
  const errors = channelFormErrors(serverForm, params.get('error'));
  const title = t('channels.verify.title');
  usePageHead({
    title: Object.keys(errors).length > 0 ? t('subscription.errors.titlePrefix', { title }) : title,
    robots: 'noindex',
    canonical: null,
  });
  const ref = params.get('ref')?.trim() ?? formValue(serverForm, 'ref');
  const channel = (params.get('channel') ?? formValue(serverForm, 'channel')) === 'sms' ? 'sms' : 'webhook';
  const codeError = useId();
  const codeHelp = useId();
  if (!ref) return <InvalidLinkState />;
  const problems = errorProblems(t, errors, { code: CODE_FIELD_ID });
  return (
    <div>
      <NoReferrer />
      <PageTitle title={title} subtitle={t(channel === 'sms' ? 'channels.verify.subtitleSms' : 'channels.verify.subtitleWebhook')} />
      <Card className="mx-auto max-w-xl">
        <form method="post" action={FORM_PATHS.verify} noValidate className="flex flex-col gap-6 p-5 sm:p-8">
          <ErrorSummary problems={problems} />
          <input type="hidden" name="ref" value={ref} />
          <input type="hidden" name="channel" value={channel} />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={CODE_FIELD_ID} className="text-sm font-medium">
              {t('channels.verify.code')}
            </label>
            <input
              id={CODE_FIELD_ID}
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              required
              maxLength={12}
              aria-invalid={errors.code ? true : undefined}
              aria-describedby={clsx(codeHelp, errors.code && codeError)}
              className={clsx(fieldClass, 'font-mono tracking-widest')}
            />
            <p id={codeHelp} className="text-xs text-muted">
              {t('channels.verify.help')}
            </p>
            <FieldError id={codeError}>{errors.code && t(errors.code)}</FieldError>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="submit" className={primaryButton}>
              <KeyRound aria-hidden className="size-4" />
              {t('channels.verify.submit')}
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}

/** /subscription/channel?id=…&token=…: the manage page of a webhook or SMS subscription. */
export function ChannelManagePage() {
  const { t } = useTranslation('public');
  const [params] = useSearchParams();
  usePageHead({ title: t('channels.manage.title'), robots: 'noindex', canonical: null });
  const id = params.get('id')?.trim();
  const token = params.get('token')?.trim();
  return (
    <>
      <NoReferrer />
      {params.get('unsubscribed') === '1' ? (
        <ResultState
          icon={<MailMinus aria-hidden className="size-10 text-muted" />}
          title={t('channels.manage.unsubscribed')}
          actions={
            <Link to="/" className={secondaryButton}>
              {t('subscription.backHome')}
            </Link>
          }
        >
          <p>{t('channels.manage.unsubscribedDescription')}</p>
        </ResultState>
      ) : params.get('error') === 'invalid' || !id || !token ? (
        <InvalidLinkState />
      ) : (
        <ChannelManage id={id} token={token} confirmed={params.get('confirmed') === '1'} saved={params.get('saved') === '1'} />
      )}
    </>
  );
}

function ChannelManage({ id, token, confirmed, saved }: { id: string; token: string; confirmed: boolean; saved: boolean }) {
  const { t } = useTranslation('public');
  const subscription = useChannelSubscription(id, token);
  const summary = useSummary();
  const sections = useMemo(() => (summary.data ? serviceSections(summary.data.groups, summary.data.ungrouped) : []), [summary.data]);
  if (subscription.isError && isNotFound(subscription.error)) return <InvalidLinkState />;
  if (subscription.isError) return <ErrorState className="mx-auto max-w-xl" onRetry={() => void subscription.refetch()} />;
  if (summary.isError) return <ErrorState className="mx-auto max-w-xl" onRetry={() => void summary.refetch()} />;
  if (subscription.isPending || summary.isPending) return <SubscribeSkeleton />;
  const sub = subscription.data;
  return (
    <div>
      <PageTitle title={t('channels.manage.title')} subtitle={t('channels.manage.subtitle')} />
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        {confirmed && (
          <p role="status" className="flex items-start gap-2 rounded-xl bg-status-operational/12 px-4 py-3 text-sm">
            <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-status-operational-text" />
            {t('channels.manage.confirmed')}
          </p>
        )}
        <ChannelDetails subscription={sub} />
        <ChannelPreferences id={id} token={token} subscription={sub} sections={sections} saved={saved} />
        <Card as="section" className="flex flex-col gap-3 p-5 sm:p-8">
          <h2 className="text-lg font-semibold">{t('subscription.unsubscribe.title')}</h2>
          <p className="text-sm text-muted">{t('channels.manage.unsubscribeDescription')}</p>
          <form method="post" action={FORM_PATHS.channelUnsubscribe}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="token" value={token} />
            <button type="submit" className={dangerButton}>
              <MailMinus aria-hidden className="size-4" />
              {t('channels.manage.unsubscribe')}
            </button>
          </form>
        </Card>
      </div>
    </div>
  );
}

function ChannelDetails({ subscription }: { subscription: PublicChannelSubscription }) {
  const { t } = useTranslation('public');
  const channel = subscription.channel === 'sms' ? t('channels.nav.sms') : t(`channels.kinds.${subscription.webhookKind ?? 'generic'}`);
  return (
    <Card as="section" className="flex flex-col gap-4 p-5 sm:p-8">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        {subscription.channel === 'sms' ? <MessageSquareText aria-hidden className="size-5" /> : <Webhook aria-hidden className="size-5" />}
        {t('channels.manage.details')}
      </h2>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="font-medium">{t('channels.manage.channel')}</dt>
        <dd>{channel}</dd>
        <dt className="font-medium">{t('channels.manage.target')}</dt>
        <dd className="break-all">{subscription.target}</dd>
        <dt className="font-medium">{t('channels.manage.status')}</dt>
        <dd>{subscription.confirmed ? t('channels.manage.active') : t('channels.manage.pending')}</dd>
      </dl>
      {subscription.signingSecret && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">{t('channels.manage.signingSecret')}</h3>
          <code className="rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-xs break-all">{subscription.signingSecret}</code>
          <p className="text-xs text-muted">{t('channels.manage.signingHelp')}</p>
        </div>
      )}
    </Card>
  );
}

function ChannelPreferences({
  id,
  token,
  subscription,
  sections,
  saved,
}: {
  id: string;
  token: string;
  subscription: PublicChannelSubscription;
  sections: ServiceSection[];
  saved: boolean;
}) {
  const { t } = useTranslation('public');
  const serverForm = useServerForm();
  const errors = channelFormErrors(serverForm, null);
  const [locale, setLocale] = useState<SubscriptionLocale>(() =>
    serverForm ? toSubscriptionLocale(formValue(serverForm, 'locale')) : subscription.locale,
  );
  const [scope, setScope] = useState(() =>
    serverForm
      ? formScope(serverForm, sections)
      : { allServices: subscription.allServices, serviceIds: knownServiceIds(subscription.serviceIds, sections) },
  );
  const problems = errorProblems(t, errors, { serviceIds: SCOPE_FIELD_ID });
  return (
    <Card>
      <form method="post" action={FORM_PATHS.channelManage} noValidate className="flex flex-col gap-6 p-5 sm:p-8">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="token" value={token} />
        <ErrorSummary problems={problems} />
        <LocaleSelect value={locale} onChange={setLocale} label={t('channels.language')} />
        <ScopePicker value={scope} onChange={setScope} sections={sections} error={errors.serviceIds && t(errors.serviceIds)} />
        <div className="flex flex-wrap items-center justify-end gap-3">
          <p role="status" className="flex items-center gap-1.5 text-sm text-status-operational-text">
            {saved && !serverForm && (
              <>
                <CircleCheck aria-hidden className="size-4" />
                {t('subscription.manage.saved')}
              </>
            )}
          </p>
          <button type="submit" className={primaryButton}>
            {t('subscription.manage.save')}
          </button>
        </div>
      </form>
    </Card>
  );
}
