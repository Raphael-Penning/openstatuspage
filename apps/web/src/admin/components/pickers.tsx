/**
 * Entity pickers shared by incident and maintenance forms.
 */
import type { AdminLocation, AdminService, ImpactStatus, IncidentImpact } from '@openstatuspage/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useOptions } from '../lib/format';
import { useGroups, useLocations, useServices } from '../lib/queries';
import { InlineSelect, MultiSelect } from './fields';

export interface AffectedValue {
  serviceId: string;
  status: ImpactStatus;
}

/** Suggested service impact for a newly selected service, derived from the incident impact. */
export function defaultImpactStatus(impact: IncidentImpact): ImpactStatus {
  if (impact === 'critical') return 'major_outage';
  if (impact === 'major') return 'partial_outage';
  return 'degraded';
}

function useServiceOptions(services: AdminService[] | undefined) {
  const { t } = useTranslation('admin');
  const groups = useGroups();
  return useMemo(() => {
    const groupName = new Map((groups.data ?? []).map((g) => [g.id, g.name]));
    return (services ?? []).map((s) => ({
      value: s.id,
      label: s.name,
      hint: [s.groupId ? groupName.get(s.groupId) : null, s.isPublic ? null : t('visibility.hidden')].filter(Boolean).join(' · ') || undefined,
    }));
  }, [services, groups.data, t]);
}

export function AffectedServicesPicker({
  value,
  onChange,
  defaultStatus,
  error,
  label,
  disabled,
}: {
  value: AffectedValue[];
  onChange: (v: AffectedValue[]) => void;
  defaultStatus: ImpactStatus;
  error?: string;
  label?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation('admin');
  const services = useServices();
  const options = useServiceOptions(services.data);
  const opts = useOptions();
  const statusOf = new Map(value.map((v) => [v.serviceId, v.status]));
  const nameOf = new Map((services.data ?? []).map((s) => [s.id, s.name]));

  return (
    <MultiSelect
      label={label ?? t('incidents.affectedServices')}
      help={t('incidents.affectedServicesHelp')}
      error={error}
      disabled={disabled}
      options={options}
      selected={value.map((v) => v.serviceId)}
      onChange={(ids) => onChange(ids.map((id) => ({ serviceId: id, status: statusOf.get(id) ?? defaultStatus })))}
      renderExtra={(id) => (
        <InlineSelect
          className="w-auto min-w-[11rem] sm:w-48"
          label={t('incidents.impactFor', { name: nameOf.get(id) ?? '' })}
          value={statusOf.get(id) ?? defaultStatus}
          options={opts.impactStatus}
          disabled={disabled}
          onValue={(status) => onChange(value.map((v) => (v.serviceId === id ? { ...v, status } : v)))}
        />
      )}
    />
  );
}

export function ServicesPicker({
  value,
  onChange,
  label,
  help,
  error,
  disabled,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  label: string;
  help?: string;
  error?: string;
  disabled?: boolean;
}) {
  const services = useServices();
  const options = useServiceOptions(services.data);
  return <MultiSelect label={label} help={help} error={error} options={options} selected={value} onChange={onChange} disabled={disabled} />;
}

export function locationLabel(l: AdminLocation): string {
  return l.code ? `${l.name} (${l.code})` : l.name;
}

export function LocationsPicker({
  value,
  onChange,
  label,
  help,
  error,
  disabled,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  label: string;
  help?: string;
  error?: string;
  disabled?: boolean;
}) {
  const locations = useLocations();
  const options = useMemo(
    () => (locations.data ?? []).map((l) => ({ value: l.id, label: locationLabel(l), hint: l.city ?? undefined })),
    [locations.data],
  );
  return <MultiSelect label={label} help={help} error={error} options={options} selected={value} onChange={onChange} disabled={disabled} />;
}
