/**
 * Mail delivery status on the settings page: transport, sender, subscriber
 * and queue counts, last delivery and error, plus "send test email" and
 * "retry failed". Rendered inside the settings form, so it uses no <form> of
 * its own (Enter in the address field sends the test email instead of saving).
 */
import { TestEmailInput, type MailTransportKind, type NotificationStatus } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { CircleCheck, CircleX, Info, RotateCcw, Send, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { useFormat } from '../lib/format';
import { testResultMessage, type TestEmailResponse } from '../lib/notifications';
import { useAdminMutation, useNotificationStatus } from '../lib/queries';
import { useForm } from '../lib/useForm';
import { useSession } from '../session';
import { TextField } from './fields';
import { useToast } from './Toast';
import { Badge, Button, QueryState } from './ui';

interface TestResult {
  ok: boolean;
  /** Localized on success, the server message (SMTP error) on failure. */
  message: string;
}

const TRANSPORT_TONE: Record<MailTransportKind, 'success' | 'info' | 'warning'> = {
  smtp: 'success',
  log: 'info',
  none: 'warning',
};

export function NotificationStatusPanel({ enabled }: { enabled: boolean }) {
  const status = useNotificationStatus();
  return <QueryState query={status}>{(s) => <StatusDetails status={s} enabled={enabled} />}</QueryState>;
}

function Notice({ tone, icon, children }: { tone: 'warning' | 'info'; icon: ReactNode; children: ReactNode }) {
  return (
    <p
      role={tone === 'warning' ? 'alert' : undefined}
      className={clsx(
        'flex items-start gap-2 rounded-lg px-3 py-2 text-sm',
        tone === 'warning' ? 'bg-status-degraded/12 text-fg' : 'bg-surface-2 text-muted',
      )}
    >
      {icon}
      <span>{children}</span>
    </p>
  );
}

function Fact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('min-w-0', className)}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm break-words">{children}</dd>
    </div>
  );
}

/**
 * `enabled` is the (possibly unsaved) value of the toggle, so the warning
 * appears as soon as an admin turns subscriptions on without a transport.
 */
function StatusDetails({ status: s, enabled }: { status: NotificationStatus; enabled: boolean }) {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const toast = useToast();
  const { user } = useSession();
  const form = useForm({ to: user.email });
  const [result, setResult] = useState<TestResult | null>(null);

  const test = useAdminMutation((body: TestEmailInput) => api.post<TestEmailResponse>('/api/admin/notifications/test', body), {
    onSuccess: (r, body) => {
      const msg = testResultMessage(r, s.transport, body.to);
      const message = 'text' in msg ? msg.text : t(msg.key, msg.values ?? {});
      setResult({ ok: r.ok, message });
      if (r.ok) toast.success(message);
      else toast.error(t('notifications.testFailed'));
    },
    onError: (error) => {
      setResult(null);
      return form.applyServerError(error);
    },
  });
  const retry = useAdminMutation(() => api.post<{ requeued: number }>('/api/admin/notifications/retry-failed'), {
    success: (r) => t('notifications.requeued', { count: r.requeued }),
  });

  const sendTest = () => {
    if (!s.configured || test.isPending) return;
    setResult(null);
    const body = form.validate(TestEmailInput, { to: form.values.to.trim() });
    if (body) test.mutate(body);
  };

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold">{t('notifications.title')}</h3>

      {!s.configured &&
        (enabled ? (
          <Notice tone="warning" icon={<TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-status-degraded-text" />}>
            {t('notifications.noTransportWarning')}
          </Notice>
        ) : (
          <Notice tone="info" icon={<Info aria-hidden className="mt-0.5 size-4 shrink-0" />}>
            {t('notifications.noTransport')}
          </Notice>
        ))}
      {s.transport === 'log' && (
        <Notice tone="info" icon={<Info aria-hidden className="mt-0.5 size-4 shrink-0" />}>
          {t('notifications.logTransport')}
        </Notice>
      )}

      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label={t('notifications.transport')}>
          <Badge tone={TRANSPORT_TONE[s.transport]}>{t(`notifications.transports.${s.transport}`)}</Badge>
        </Fact>
        <Fact label={t('notifications.from')}>{s.from ? <span className="font-mono text-xs">{s.from}</span> : '–'}</Fact>
        <Fact label={t('notifications.subscribers')}>
          {t('notifications.subscriberCounts', { confirmed: fmt.number(s.subscribers.confirmed), pending: fmt.number(s.subscribers.pending) })}
        </Fact>
        <Fact label={t('notifications.queue')}>
          {t('notifications.queuePending', { value: fmt.number(s.queue.pending) })}
          {' · '}
          <span className={s.queue.failed > 0 ? 'font-medium text-status-major-outage-text' : undefined}>
            {t('notifications.queueFailed', { value: fmt.number(s.queue.failed) })}
          </span>
        </Fact>
        <Fact label={t('notifications.lastSent')}>
          {s.lastSentAt ? (
            <time dateTime={s.lastSentAt} title={fmt.dateTime(s.lastSentAt)}>
              {fmt.relative(s.lastSentAt)}
            </time>
          ) : (
            t('notifications.never')
          )}
        </Fact>
        <Fact label={t('notifications.lastError')}>
          {s.lastError ? (
            <span className="text-status-major-outage-text">
              {s.lastError.message}{' '}
              <time dateTime={s.lastError.at} title={fmt.dateTime(s.lastError.at)} className="text-xs text-muted">
                ({fmt.relative(s.lastError.at)})
              </time>
            </span>
          ) : (
            '–'
          )}
        </Fact>
      </dl>

      <div className="flex flex-col gap-3 border-t border-border pt-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <TextField
            className="sm:w-80"
            label={t('notifications.testTo')}
            type="email"
            autoComplete="off"
            value={form.values.to}
            onValue={(x) => form.set('to', x)}
            error={form.error('to')}
            onKeyDown={(e) => {
              // Do not submit the surrounding settings form.
              if (e.key === 'Enter') {
                e.preventDefault();
                sendTest();
              }
            }}
          />
          <Button icon={Send} className="sm:mt-7" pending={test.isPending} disabled={!s.configured} onClick={sendTest}>
            {t('notifications.testSend')}
          </Button>
        </div>
        <Button
          icon={RotateCcw}
          pending={retry.isPending}
          disabled={s.queue.failed === 0}
          title={s.queue.failed === 0 ? t('notifications.nothingToRetry') : undefined}
          onClick={() => retry.mutate()}
        >
          {t('notifications.retry')}
        </Button>
      </div>
      {result && (
        <p role="status" className={clsx('flex items-start gap-2 text-sm', result.ok ? 'text-status-operational-text' : 'text-status-major-outage-text')}>
          {result.ok ? (
            <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
          ) : (
            <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
          )}
          <span className="break-words">{result.message}</span>
        </p>
      )}
    </div>
  );
}
