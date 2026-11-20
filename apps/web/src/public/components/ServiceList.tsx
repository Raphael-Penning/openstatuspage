/**
 * Service catalog: collapsible group cards with service rows and uptime bars.
 */
import type { PublicService, PublicServiceGroup } from '@openstatuspage/shared';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useServicePaths } from '../hooks/links';
import { usePublicSettings } from '../hooks/queries';
import { Card, StatusPill } from './ui';
import { useOutboundHref } from './OutboundLink';
import { UptimeBar } from './UptimeBar';

/**
 * Days an uptime bar shows on a wide screen: the configured range, at most 90.
 * Narrow screens show fewer (UptimeBar hides them with media queries).
 */
export function useBarDays(): number {
  const { data } = usePublicSettings();
  return Math.min(data?.uptimeDays ?? 90, 90);
}

export function ServiceRow({ service, days }: { service: PublicService; days: number }) {
  const { t } = useTranslation('public');
  const { data: settings } = usePublicSettings();
  const outbound = useOutboundHref();
  const paths = useServicePaths();
  const showUptime = settings?.showUptime !== false && (service.uptime?.length ?? 0) > 0;
  return (
    <li className="px-4 py-3.5 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link to={paths.service(service)} className="font-medium break-words hover:text-[color:var(--osp-accent-text,var(--accent))] hover:underline">
            {service.name}
          </Link>
          {service.kind === 'site' && service.url && (
            <a
              href={outbound(service.url)}
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
          dayHref={(date) => paths.day(service, date)}
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

/**
 * A group of services that collapses: a <details> disclosure, so it opens and
 * closes without JavaScript, too. Its summary is stretched over the card
 * (behind the services), and the group heading stays a real heading outside
 * the summary, which would hide it from the heading outline.
 */
export function ServiceGroupCard({ group, days, forceOpen, headingLevel = 3 }: GroupCardProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const { t } = useTranslation('public');
  const [open, setOpen] = useState(!group.collapsedByDefault);
  const expanded = forceOpen || open;

  return (
    <Card as="section" className="osp-group relative overflow-hidden">
      <div className="osp-group-head flex w-full items-center gap-3 px-4 py-4 sm:px-5">
        <ChevronDown aria-hidden className="osp-chevron size-4 shrink-0 text-muted motion-safe:transition-transform" />
        <Heading className="min-w-0 flex-1">
          <span className="block font-semibold break-words">{group.name}</span>
          <span className="block text-xs font-normal text-muted">{t('services.count', { count: group.services.length })}</span>
        </Heading>
        <StatusPill status={group.status} />
      </div>
      <details
        open={expanded}
        onToggle={(e) => {
          if (!forceOpen) setOpen(e.currentTarget.open);
        }}
      >
        <summary className="absolute inset-0 cursor-pointer list-none rounded-2xl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
          <span className="sr-only">{t('services.groupToggle', { name: group.name })}</span>
        </summary>
        {/* Above the stretched summary: the services stay clickable. */}
        <div className="relative z-10 bg-surface">
          {group.description && <p className="border-t border-border px-4 py-2 text-sm text-muted sm:px-5">{group.description}</p>}
          <ul className="divide-y divide-border border-t border-border">
            {group.services.map((s) => (
              <ServiceRow key={s.id} service={s} days={days} />
            ))}
          </ul>
        </div>
      </details>
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

