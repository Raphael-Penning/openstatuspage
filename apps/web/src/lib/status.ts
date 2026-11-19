import type { ServiceStatus } from '@openstatuspage/shared';

/** Tailwind classes per status. Keep in sync with the CSS tokens in styles.css. */
export const STATUS_BG: Record<ServiceStatus, string> = {
  operational: 'bg-status-operational',
  maintenance: 'bg-status-maintenance',
  degraded: 'bg-status-degraded',
  partial_outage: 'bg-status-partial-outage',
  major_outage: 'bg-status-major-outage',
};

export const STATUS_TEXT: Record<ServiceStatus, string> = {
  operational: 'text-status-operational-text',
  maintenance: 'text-status-maintenance-text',
  degraded: 'text-status-degraded-text',
  partial_outage: 'text-status-partial-outage-text',
  major_outage: 'text-status-major-outage-text',
};
