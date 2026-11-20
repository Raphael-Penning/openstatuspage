/**
 * Small presentational building blocks of the public page.
 */
import type { ServiceStatus } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { CircleExclamationPoint, Inbox, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { STATUS_BG } from '../../lib/status';

/** Tinted badge backgrounds per status (text stays text-fg for contrast in both themes). */
const TINT: Record<ServiceStatus, string> = {
  operational: 'bg-status-operational/12 ring-status-operational/30',
  maintenance: 'bg-status-maintenance/12 ring-status-maintenance/30',
  degraded: 'bg-status-degraded/15 ring-status-degraded/35',
  partial_outage: 'bg-status-partial-outage/12 ring-status-partial-outage/30',
  major_outage: 'bg-status-major-outage/12 ring-status-major-outage/30',
};

export function Card({ children, className, as: Tag = 'div' }: { children: ReactNode; className?: string; as?: 'div' | 'section' | 'article' }) {
  return <Tag className={clsx('rounded-2xl border border-border bg-surface', className)}>{children}</Tag>;
}

/** Pill with a colored dot; tone null renders a neutral pill. */
export function Badge({ tone, children, className }: { tone: ServiceStatus | null; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-fg ring-1 ring-inset',
        tone ? TINT[tone] : 'bg-surface-2 ring-border',
        className,
      )}
    >
      <span aria-hidden className={clsx('size-1.5 rounded-full', tone ? STATUS_BG[tone] : 'bg-muted')} />
      {children}
    </span>
  );
}

/** Badge with the localized label of a service status. */
export function StatusPill({ status, className }: { status: ServiceStatus; className?: string }) {
  const { t } = useTranslation();
  return (
    <Badge tone={status} className={className}>
      {t(`status.${status}`)}
    </Badge>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('rounded-lg bg-surface-2 motion-safe:animate-pulse', className)} />;
}

/** Placeholder for a list of cards while loading. */
export function SkeletonList({ rows = 3, className }: { rows?: number; className?: string }) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-label={t('loading')} className={clsx('space-y-3', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-20 w-full rounded-2xl" />
      ))}
    </div>
  );
}

/**
 * Error with a retry action: a link that reloads the page (works without
 * JavaScript); with JavaScript it refetches in place.
 */
export function ErrorState({ onRetry, className, message }: { onRetry?: () => void; className?: string; message?: string }) {
  const { t } = useTranslation('public');
  const { pathname, search } = useLocation();
  return (
    <Card className={clsx('flex flex-col items-center gap-3 px-6 py-10 text-center', className)}>
      <CircleExclamationPoint aria-hidden className="size-8 text-status-major-outage-text" />
      <div role="alert">
        <p className="font-medium">{message ?? t('error.title')}</p>
        <p className="mt-1 text-sm text-muted">{t('error.description')}</p>
      </div>
      {onRetry && (
        <a
          href={pathname + search}
          onClick={(e) => {
            e.preventDefault();
            onRetry();
          }}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-2 px-4 py-1.5 text-sm font-medium hover:border-accent focus-visible:outline-2 focus-visible:outline-focus"
        >
          <RotateCcw aria-hidden className="size-4" />
          {t('common:actions.retry')}
        </a>
      )}
    </Card>
  );
}

export function EmptyState({ children, icon, className }: { children: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div
      className={clsx(
        'flex items-center gap-3 rounded-2xl border border-dashed border-border px-5 py-6 text-sm text-muted',
        className,
      )}
    >
      {icon ?? <Inbox aria-hidden className="size-5 shrink-0" />}
      <div>{children}</div>
    </div>
  );
}

/** Section heading with an optional "View all" link. */
export function SectionHeader({ id, title, to, linkLabel, count }: { id: string; title: string; to?: string; linkLabel?: string; count?: number }) {
  const { t } = useTranslation();
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 id={id} className="text-lg font-semibold">
        {title}
        {count !== undefined && count > 0 && <span className="ml-2 text-sm font-normal text-muted">{count}</span>}
      </h2>
      {to && (
        <Link to={to} className="shrink-0 text-sm font-medium text-[color:var(--osp-accent-text,var(--accent))] hover:underline">
          {linkLabel ?? t('actions.viewAll')}
        </Link>
      )}
    </div>
  );
}

/** Centered big page title with an optional subtitle. */
export function PageTitle({ title, subtitle, children }: { title: string; subtitle?: string | null; children?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col items-center gap-3 text-center">
      <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
      {subtitle && <p className="max-w-2xl text-muted text-balance">{subtitle}</p>}
      {children}
    </div>
  );
}
