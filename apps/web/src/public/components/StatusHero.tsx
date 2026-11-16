import type { OverallStatus } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { CircleCheck, OctagonExclamationPoint, TriangleExclamationPoint, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { STATUS_BG, STATUS_TEXT } from '../../lib/status';
import { RelativeTime } from './Time';
import { Card } from './ui';

const ICONS = {
  operational: CircleCheck,
  maintenance: Wrench,
  degraded: TriangleExclamationPoint,
  partial_outage: TriangleExclamationPoint,
  major_outage: OctagonExclamationPoint,
} as const;

const HALO = {
  operational: 'bg-status-operational/15',
  maintenance: 'bg-status-maintenance/15',
  degraded: 'bg-status-degraded/15',
  partial_outage: 'bg-status-partial-outage/15',
  major_outage: 'bg-status-major-outage/15',
} as const;

/** Big status card at the top of the overview. */
export function StatusHero({
  overall,
  activeIncidents,
  activeMaintenances,
  updatedAt,
}: {
  overall: OverallStatus;
  activeIncidents: number;
  activeMaintenances: number;
  updatedAt: string;
}) {
  const { t } = useTranslation('public');
  // An open incident without service impact still deserves attention.
  const state = overall === 'operational' && activeIncidents > 0 ? 'degraded' : overall;
  const Icon = ICONS[state];
  const key = overall === 'operational' && activeIncidents > 0 ? 'incidentsOpen' : overall;

  return (
    <Card as="section" className="relative overflow-hidden px-6 py-8 text-center sm:px-10 sm:py-10">
      <div aria-hidden className={clsx('absolute inset-x-0 top-0 h-1', STATUS_BG[state])} />
      <div className="flex flex-col items-center gap-4">
        <span className={clsx('grid size-16 place-items-center rounded-full', HALO[state])}>
          <Icon aria-hidden className={clsx('size-9', STATUS_TEXT[state])} strokeWidth={2.25} />
        </span>
        <div aria-live="polite">
          <h2 className="text-2xl font-semibold tracking-tight text-balance">{t(`hero.${key}.title`)}</h2>
          <p className="mx-auto mt-2 max-w-xl text-muted text-balance">
            {t(`hero.${key}.description`, { incidents: activeIncidents, maintenances: activeMaintenances })}
          </p>
        </div>
        <p className="text-xs text-muted">
          {t('hero.updated')} <RelativeTime value={updatedAt} />
        </p>
      </div>
    </Card>
  );
}
