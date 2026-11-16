import type { ServiceStatus } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { STATUS_BG, STATUS_TEXT } from '../lib/status';

export function StatusDot({ status, className }: { status: ServiceStatus; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={t(`status.${status}`)}
      className={clsx('inline-block size-2 shrink-0 rounded-full', STATUS_BG[status], className)}
    />
  );
}

/** Colored status label, e.g. "Operational". */
export function StatusLabel({ status, className }: { status: ServiceStatus; className?: string }) {
  const { t } = useTranslation();
  return <span className={clsx('text-sm font-medium', STATUS_TEXT[status], className)}>{t(`status.${status}`)}</span>;
}
