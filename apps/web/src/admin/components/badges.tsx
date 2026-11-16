import type { IncidentImpact, IncidentStatus, MaintenanceStatus } from '@openstatuspage/shared';
import { useTranslation } from 'react-i18next';
import { Badge } from './ui';

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  const { t } = useTranslation('admin');
  const tone = status === 'resolved' ? 'success' : status === 'monitoring' ? 'info' : 'warning';
  return <Badge tone={tone}>{t(`common:incidentStatus.${status}`)}</Badge>;
}

export function ImpactBadge({ impact }: { impact: IncidentImpact }) {
  const { t } = useTranslation('admin');
  const tone = impact === 'critical' || impact === 'major' ? 'danger' : impact === 'minor' ? 'warning' : 'neutral';
  return <Badge tone={tone}>{t('incidents.impactLabel', { impact: t(`common:impact.${impact}`) })}</Badge>;
}

export function MaintenanceStatusBadge({ status }: { status: MaintenanceStatus }) {
  const { t } = useTranslation('admin');
  const tone =
    status === 'in_progress' ? 'info' : status === 'scheduled' ? 'accent' : status === 'completed' ? 'success' : 'neutral';
  return <Badge tone={tone}>{t(`common:maintenanceStatus.${status}`)}</Badge>;
}
