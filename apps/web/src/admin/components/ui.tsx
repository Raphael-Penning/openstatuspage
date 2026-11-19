/**
 * Small presentational building blocks shared by the admin pages.
 */
import type { CheckState, ServiceStatus } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight, Eye, EyeOff, Loader2, type LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, type LinkProps } from 'react-router';
import { StatusDot } from '../../components/StatusDot';
import { apiErrorMessage } from '../lib/errors';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90 border border-transparent',
  secondary: 'border border-border bg-surface text-fg hover:bg-surface-2',
  danger: 'border border-transparent bg-status-major-outage text-white hover:opacity-90',
  ghost: 'border border-transparent text-muted hover:bg-surface-2 hover:text-fg',
};

const SIZE: Record<Size, string> = {
  sm: 'h-8 gap-1.5 px-2.5 text-xs',
  md: 'h-9 gap-2 px-3.5 text-sm',
};

export function buttonClass(variant: Variant = 'secondary', size: Size = 'md', className?: string) {
  return clsx(
    'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    'disabled:cursor-not-allowed disabled:opacity-50',
    VARIANT[variant],
    SIZE[size],
    className,
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  pending?: boolean;
  icon?: LucideIcon;
}

export function Button({ variant = 'secondary', size = 'md', pending, icon: Icon, className, children, disabled, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={buttonClass(variant, size, className)}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...rest}
    >
      {pending ? (
        <Loader2 aria-hidden className="size-4 animate-spin" />
      ) : (
        Icon && <Icon aria-hidden className="size-4" />
      )}
      {children}
    </button>
  );
}

export function LinkButton({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  className,
  children,
  ...rest
}: LinkProps & { variant?: Variant; size?: Size; icon?: LucideIcon }) {
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      {Icon && <Icon aria-hidden className="size-4" />}
      {children}
    </Link>
  );
}

/** Icon-only button with an accessible label. */
export function IconButton({
  icon: Icon,
  label,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg',
        'focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...rest}
    >
      <Icon aria-hidden className="size-4" />
    </button>
  );
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={clsx('rounded-xl border border-border bg-surface', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
}) {
  return (
    <header className="mb-6">
      {back && (
        <Link to={back.to} className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ChevronLeft aria-hidden className="size-4" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold break-words sm:text-2xl">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent/15 text-accent',
  success: 'bg-status-operational/15 text-status-operational-text',
  warning: 'bg-status-degraded/15 text-status-degraded-text',
  danger: 'bg-status-major-outage/15 text-status-major-outage-text',
  info: 'bg-status-maintenance/15 text-status-maintenance-text',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONE[tone], className)}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: ServiceStatus }) {
  const { t } = useTranslation('admin');
  return (
    <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
      <StatusDot status={status} />
      {t(`common:status.${status}`)}
    </span>
  );
}

const CHECK_TONE: Record<CheckState, BadgeTone> = { ok: 'success', warning: 'warning', critical: 'danger', unknown: 'neutral' };

export function CheckStateBadge({ state }: { state: CheckState }) {
  const { t } = useTranslation('admin');
  return <Badge tone={CHECK_TONE[state]}>{t(`common:checkState.${state}`)}</Badge>;
}

export function VisibilityBadge({ isPublic }: { isPublic: boolean }) {
  const { t } = useTranslation('admin');
  return isPublic ? (
    <Badge tone="neutral">
      <Eye aria-hidden className="size-3" />
      {t('visibility.public')}
    </Badge>
  ) : (
    <Badge tone="warning">
      <EyeOff aria-hidden className="size-3" />
      {t('visibility.hidden')}
    </Badge>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden className={clsx('size-5 animate-spin text-muted', className)} />;
}

export function LoadingState() {
  const { t } = useTranslation('admin');
  return (
    <div role="status" className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
      <Spinner />
      {t('common:loading')}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation('admin');
  return (
    <div role="alert" className="flex flex-col items-center gap-3 p-10 text-center text-sm">
      <p className="text-status-major-outage-text">{apiErrorMessage(error, t)}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          {t('common:actions.retry')}
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center text-sm text-muted">
      <p>{children}</p>
      {action}
    </div>
  );
}

/** Renders loading / error states of a query, otherwise the children. */
export function QueryState<T>({
  query,
  children,
}: {
  query: { data: T | undefined; isPending: boolean; error: unknown; refetch: () => unknown };
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <LoadingState />;
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const { t } = useTranslation('admin');
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <nav aria-label={t('pagination.label')} className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm">
      <span className="text-muted">{t('pagination.status', { page, pages, total })}</span>
      <div className="flex gap-1">
        <IconButton icon={ChevronLeft} label={t('pagination.previous')} disabled={page <= 1} onClick={() => onPage(page - 1)} />
        <IconButton icon={ChevronRight} label={t('pagination.next')} disabled={page >= pages} onClick={() => onPage(page + 1)} />
      </div>
    </nav>
  );
}

/** Segmented filter control (tabs-like radio group). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-lg border border-border bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-md px-3 py-1 text-sm transition focus-visible:outline-2 focus-visible:outline-accent',
            value === o.value ? 'bg-surface-2 font-medium text-fg' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Responsive table wrapper: scrolls horizontally inside the card on small screens. */
export function Table({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full min-w-[36rem] text-left text-sm">
        {children}
      </table>
    </div>
  );
}

export const th = 'px-4 py-2.5 text-xs font-medium tracking-wide text-muted uppercase';
export const td = 'px-4 py-3 align-middle';
export const tr = 'border-t border-border';
