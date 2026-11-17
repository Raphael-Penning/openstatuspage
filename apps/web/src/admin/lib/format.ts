import {
  IMPACT_STATUSES,
  INCIDENT_IMPACTS,
  INCIDENT_STATUSES,
  MAINTENANCE_STATUSES,
  REGIONS,
  SERVICE_STATUSES,
  USER_ROLES,
} from '@openstatuspage/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatRelative } from './datetime';

/** Locale aware date formatting bound to the current UI language. */
export function useFormat() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? 'en';
  return useMemo(
    () => ({
      locale,
      dateTime: (iso: string | null | undefined) => formatDateTime(iso, locale),
      relative: (iso: string | null | undefined) => formatRelative(iso, locale),
      number: (n: number) => new Intl.NumberFormat(locale).format(n),
    }),
    [locale],
  );
}

/** Translated option lists for the shared enums. */
export function useOptions() {
  const { t } = useTranslation('admin');
  return useMemo(
    () => ({
      serviceStatus: SERVICE_STATUSES.map((s) => ({ value: s, label: t(`common:status.${s}`) })),
      impactStatus: IMPACT_STATUSES.map((s) => ({ value: s, label: t(`common:status.${s}`) })),
      incidentStatus: INCIDENT_STATUSES.map((s) => ({ value: s, label: t(`common:incidentStatus.${s}`) })),
      incidentImpact: INCIDENT_IMPACTS.map((s) => ({ value: s, label: t(`common:impact.${s}`) })),
      maintenanceStatus: MAINTENANCE_STATUSES.map((s) => ({ value: s, label: t(`common:maintenanceStatus.${s}`) })),
      region: REGIONS.map((s) => ({ value: s, label: t(`common:region.${s}`) })),
      role: USER_ROLES.map((s) => ({ value: s, label: t(`roles.${s}`) })),
      visibility: [
        { value: 'public' as const, label: t('visibility.public') },
        { value: 'hidden' as const, label: t('visibility.hidden') },
      ],
    }),
    [t],
  );
}
