/**
 * Incident and maintenance building blocks: summary cards, badges, update
 * timelines and affected service chips.
 */
import type {
  IncidentUpdateEntry,
  MaintenanceStatus,
  MaintenanceUpdateEntry,
  PublicIncident,
  PublicMaintenance,
} from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { CalendarClock, TriangleExclamationPoint, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { STATUS_TEXT } from '../../lib/status';
import { useServicePaths } from '../hooks/links';
import { useFormat } from '../hooks/preferences';
import { incidentTone, isAutoMessage, latestUpdate, maintenanceTone } from '../utils/status';
import { DateTime, RelativeTime, TimeRange } from './Time';
import { Badge, Card } from './ui';

/** Localized default text for maintenance updates without a message. */
export function useMaintenanceMessage() {
  const { t } = useTranslation('public');
  return (update: Pick<MaintenanceUpdateEntry, 'status' | 'message'>) =>
    isAutoMessage(update.message)
      ? t([`common:maintenanceAutoMessage.${update.status}`, `public:maintenanceAutoMessage.${update.status}`])
      : update.message;
}

export function IncidentStatusBadge({ incident }: { incident: Pick<PublicIncident, 'status' | 'impact'> }) {
  const { t } = useTranslation();
  return <Badge tone={incidentTone(incident)}>{t(`incidentStatus.${incident.status}`)}</Badge>;
}

export function ImpactBadge({ impact }: { impact: PublicIncident['impact'] }) {
  const { t } = useTranslation('public');
  return <Badge tone={null}>{t('incident.impactLabel', { impact: t(`common:impact.${impact}`) })}</Badge>;
}

export function MaintenanceStatusBadge({ status }: { status: MaintenanceStatus }) {
  const { t } = useTranslation();
  return <Badge tone={maintenanceTone(status)}>{t(`maintenanceStatus.${status}`)}</Badge>;
}

export function IncidentIcon({ incident, className }: { incident: Pick<PublicIncident, 'status' | 'impact'>; className?: string }) {
  return <TriangleExclamationPoint aria-hidden className={clsx('size-5 shrink-0', STATUS_TEXT[incidentTone(incident)], className)} />;
}

export function MaintenanceIcon({ status, className }: { status: MaintenanceStatus; className?: string }) {
  const tone = maintenanceTone(status);
  const Icon = status === 'scheduled' ? CalendarClock : Wrench;
  return <Icon aria-hidden className={clsx('size-5 shrink-0', tone ? STATUS_TEXT[tone] : 'text-muted', className)} />;
}

/** Chips of affected services, linking to the service pages (below the current link base). */
export function AffectedServices({ services, className }: { services: { id: string; name: string }[]; className?: string }) {
  // Below the link base: on a private page the chips stay on it.
  const paths = useServicePaths();
  const { t } = useTranslation('public');
  if (services.length === 0) return null;
  return (
    <div className={clsx('flex flex-wrap items-center gap-1.5', className)}>
      <span className="text-xs text-muted">{t('affected')}</span>
      <ul className="contents">
        {services.map((s) => (
          <li key={s.id}>
            <Link
              to={paths.service({ id: s.id })}
              className="inline-flex min-h-6 items-center rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs hover:border-accent"
            >
              {s.name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Compact incident card used on the overview and service pages. */
export function IncidentSummary({ incident }: { incident: PublicIncident }) {
  const paths = useServicePaths();
  const { t } = useTranslation('public');
  const f = useFormat();
  const latest = latestUpdate(incident);
  const resolved = incident.status === 'resolved';
  return (
    <Card as="article" className="relative p-4 hover:border-accent sm:p-5">
      <div className="flex items-start gap-3">
        <IncidentIcon incident={incident} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="min-w-0 font-semibold">
              <Link to={paths.incident(incident.id)} className="after:absolute after:inset-0 hover:underline">
                {incident.title}
              </Link>
            </h3>
            <IncidentStatusBadge incident={incident} />
          </div>
          {latest && (
            <p className="prose-update mt-1.5 line-clamp-2 text-sm text-muted">
              <span className="font-medium text-fg">{t(`common:incidentStatus.${latest.status}`)}</span> – {latest.message}
            </p>
          )}
          <p className="mt-2 text-xs text-muted">
            {resolved && incident.resolvedAt
              ? t('incident.resolvedAfter', { duration: f.durationSince(incident.startedAt, incident.resolvedAt) })
              : t('incident.ongoingFor', { duration: f.durationSince(incident.startedAt, null) })}
            {' · '}
            <RelativeTime value={latest?.createdAt ?? incident.updatedAt} />
          </p>
        </div>
      </div>
    </Card>
  );
}

/** Compact maintenance card used on the overview and service pages. */
export function MaintenanceSummary({ maintenance }: { maintenance: PublicMaintenance }) {
  const paths = useServicePaths();
  const { t } = useTranslation('public');
  const message = useMaintenanceMessage();
  const latest = latestUpdate(maintenance);
  return (
    <Card as="article" className="relative p-4 hover:border-accent sm:p-5">
      <div className="flex items-start gap-3">
        <MaintenanceIcon status={maintenance.status} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="min-w-0 font-semibold">
              <Link to={paths.maintenance(maintenance.id)} className="after:absolute after:inset-0 hover:underline">
                {maintenance.title}
              </Link>
            </h3>
            <MaintenanceStatusBadge status={maintenance.status} />
          </div>
          <p className="mt-1.5 text-sm">
            <span className="sr-only">{t('maintenance.window')}: </span>
            <TimeRange start={maintenance.scheduledStart} end={maintenance.scheduledEnd} />
          </p>
          {(maintenance.description || (latest && !isAutoMessage(latest.message))) && (
            <p className="prose-update mt-1 line-clamp-2 text-sm text-muted">
              {latest && !isAutoMessage(latest.message) ? message(latest) : maintenance.description}
            </p>
          )}
          {maintenance.status === 'scheduled' && (
            <p className="mt-2 text-xs text-muted">
              {t('maintenance.startsIn')} <RelativeTime value={maintenance.scheduledStart} />
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

type TimelineEntry = IncidentUpdateEntry | MaintenanceUpdateEntry;

/** Update timeline, newest first (Statuspage style: bold status, message, timestamp). */
export function Timeline({ updates, kind }: { updates: TimelineEntry[]; kind: 'incident' | 'maintenance' }) {
  const { t } = useTranslation('public');
  const message = useMaintenanceMessage();
  if (updates.length === 0) return <p className="text-sm text-muted">{t('timeline.empty')}</p>;
  return (
    <ol className="relative space-y-6 border-l border-border pl-6">
      {updates.map((u, i) => (
        <li key={u.id} className="relative">
          <span
            aria-hidden
            className={clsx(
              'absolute top-1.5 -left-[29px] size-2.5 rounded-full ring-4 ring-surface',
              i === 0 ? 'bg-[color:var(--osp-accent-solid,var(--accent))]' : 'bg-muted',
            )}
          />
          <p className="font-semibold">
            {kind === 'incident'
              ? t(`common:incidentStatus.${u.status}`)
              : t(`common:maintenanceStatus.${u.status}`)}
          </p>
          <p className="prose-update mt-1 text-sm">
            {kind === 'maintenance' ? message(u as MaintenanceUpdateEntry) : u.message}
          </p>
          <p className="mt-1 text-xs text-muted">
            <DateTime value={u.createdAt} /> · <RelativeTime value={u.createdAt} />
          </p>
        </li>
      ))}
    </ol>
  );
}
