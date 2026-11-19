import type { ServiceStatus } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { CircleCheck, CircleX, TriangleExclamationPoint, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { STATUS_TEXT } from '../../lib/status';
import type { CounterKey, StatusCounters } from '../utils/status';

const ITEMS: { key: CounterKey; tone: ServiceStatus; Icon: typeof CircleCheck }[] = [
  { key: 'operational', tone: 'operational', Icon: CircleCheck },
  { key: 'degraded', tone: 'degraded', Icon: TriangleExclamationPoint },
  { key: 'offline', tone: 'major_outage', Icon: CircleX },
  { key: 'maintenance', tone: 'maintenance', Icon: Wrench },
];

/**
 * Four summary counters. With `onSelect` they act as toggle buttons that
 * filter the list below.
 */
export function CounterCards({
  counters,
  selected,
  onSelect,
  label,
}: {
  counters: StatusCounters;
  selected?: CounterKey | null;
  onSelect?: (key: CounterKey | null) => void;
  label: string;
}) {
  const { t } = useTranslation('public');
  return (
    <ul aria-label={label} className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {ITEMS.map(({ key, tone, Icon }) => {
        const content = (
          <>
            <Icon aria-hidden className={clsx('size-5', STATUS_TEXT[tone])} />
            <span className="text-2xl font-semibold tabular-nums">{counters[key]}</span>
            <span className="text-sm text-muted">{t(`counters.${key}`)}</span>
          </>
        );
        const base = 'flex h-full w-full flex-col items-start gap-1 rounded-2xl border bg-surface p-4 text-left';
        return (
          <li key={key}>
            {onSelect ? (
              <button
                type="button"
                aria-pressed={selected === key}
                onClick={() => onSelect(selected === key ? null : key)}
                className={clsx(
                  base,
                  'hover:border-accent focus-visible:outline-2 focus-visible:outline-focus',
                  selected === key ? 'border-accent ring-1 ring-accent' : 'border-border',
                )}
              >
                {content}
              </button>
            ) : (
              <div className={clsx(base, 'border-border')}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
