/**
 * Shared pieces of the incident and maintenance detail pages.
 */
import { ArrowLeft, MapPin } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useServicePaths } from '../hooks/links';
import { usePrivatePageToken } from '../hooks/private-page';
import { useLocations, usePublicSettings } from '../hooks/queries';
import { Skeleton } from './ui';

export function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-10 w-96 max-w-full" />
      <Skeleton className="h-28 w-full rounded-2xl" />
      <Skeleton className="h-64 w-full rounded-2xl" />
    </div>
  );
}

/** Label/value pair of the facts card. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{children}</dd>
    </div>
  );
}

/** Back to the history; on a private page (/p/<token>) back to that page, which has no history. */
export function BackToHistory() {
  const { t } = useTranslation('public');
  const isPrivate = usePrivatePageToken() !== null;
  const paths = useServicePaths();
  return (
    <Link to={isPrivate ? paths.home : '/history'} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft aria-hidden className="size-4" />
      {isPrivate ? t('private.back') : t('detail.back')}
    </Link>
  );
}

/** Names of the public locations with the given ids. */
export function LocationNames({ ids }: { ids: string[] }) {
  const { t } = useTranslation('public');
  const { data: settings } = usePublicSettings();
  const enabled = settings?.showLocations !== false && ids.length > 0;
  const { data } = useLocations(enabled);
  const names = (data?.locations ?? []).filter((l) => ids.includes(l.id)).map((l) => l.name);
  if (!enabled || names.length === 0) return null;
  return (
    <p className="flex items-center gap-1.5 text-sm text-muted">
      <MapPin aria-hidden className="size-4" />
      <span className="sr-only">{t('service.locations')}:</span>
      {names.join(', ')}
    </p>
  );
}
