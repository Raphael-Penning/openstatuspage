/**
 * Service catalog: collapsible group cards with service rows and uptime bars.
 */
import type { PublicService, PublicServiceGroup } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useViewportWidth } from '../hooks/dom';
import { usePublicSettings } from '../hooks/queries';
import { barDaysForWidth } from '../utils/uptime';
import { Card, StatusPill } from './ui';
import { UptimeBar } from './UptimeBar';

/** Days an uptime bar shows at the current viewport width. */
export function useBarDays(): number {
  const width = useViewportWidth();
  const { data } = usePublicSettings();
  const max = data?.uptimeDays ?? 90;
  return barDaysForWidth(width, max, Math.min(max, 90));
}

export function ServiceRow({ service, days }: { service: PublicService; days: number }) {
  const { t } = useTranslation('public');
  const { data: settings } = usePublicSettings();
  const showUptime = settings?.showUptime !== false && (service.uptime?.length ?? 0) > 0;
  return (
    <li className="px-4 py-3.5 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link to={`/services/${service.slug}`} className="font-medium break-words hover:text-[color:var(--osp-accent-text,var(--accent))] hover:underline">
            {service.name}
          </Link>
          {service.kind === 'site' && service.url && (
            <a
              href={service.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('services.openSite', { name: service.name })}
              className="grid size-6 shrink-0 place-items-center rounded text-muted hover:text-[color:var(--osp-accent-text,var(--accent))]"
            >
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          )}
        </div>
        <StatusPill status={service.status} />
      </div>
      {showUptime && service.uptime && (
        <UptimeBar
          className="mt-3"
          uptime={service.uptime}
          days={days}
          label={service.name}
          percent={service.uptimePercent}
        />
      )}
    </li>
  );
}

interface GroupCardProps {
  group: PublicServiceGroup;
  days: number;
  /** Forces the group open (e.g. while searching). */
  forceOpen?: boolean;
  /** Level of the group headings, so the outline has no gaps (2 on the services page, 3 below a section heading). */
  headingLevel?: 2 | 3;
}

export function ServiceGroupCard({ group, days, forceOpen, headingLevel = 3 }: GroupCardProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const { t } = useTranslation('public');
  const [open, setOpen] = useState(!group.collapsedByDefault);
  const contentId = useId();
  const expanded = forceOpen || open;

  return (
    <Card as="section" className="overflow-hidden">
      <Heading>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setOpen(!expanded)}
          className="flex w-full items-center gap-3 px-4 py-4 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus sm:px-5"
        >
          <ChevronDown
            aria-hidden
            className={clsx('size-4 shrink-0 text-muted motion-safe:transition-transform', !expanded && '-rotate-90')}
          />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold break-words">{group.name}</span>
            <span className="block text-xs text-muted">{t('services.count', { count: group.services.length })}</span>
          </span>
          <StatusPill status={group.status} />
        </button>
      </Heading>
      <div id={contentId} hidden={!expanded}>
        {group.description && <p className="border-t border-border px-4 py-2 text-sm text-muted sm:px-5">{group.description}</p>}
        <ul className="divide-y divide-border border-t border-border">
          {group.services.map((s) => (
            <ServiceRow key={s.id} service={s} days={days} />
          ))}
        </ul>
      </div>
    </Card>
  );
}

/** All groups plus ungrouped services. */
export function ServiceCatalog({
  groups,
  ungrouped,
  forceOpen,
  headingLevel = 3,
}: {
  groups: PublicServiceGroup[];
  ungrouped: PublicService[];
  forceOpen?: boolean;
  headingLevel?: 2 | 3;
}) {
  const { t } = useTranslation('public');
  const days = useBarDays();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <ServiceGroupCard key={g.id} group={g} days={days} forceOpen={forceOpen} headingLevel={headingLevel} />
      ))}
      {ungrouped.length > 0 && (
        <Card as="section" className="overflow-hidden">
          {groups.length > 0 && (
            <Heading className="border-b border-border px-4 py-3 text-sm font-semibold text-muted sm:px-5">{t('services.ungrouped')}</Heading>
          )}
          <ul className="divide-y divide-border">
            {ungrouped.map((s) => (
              <ServiceRow key={s.id} service={s} days={days} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

