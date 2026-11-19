import type { ServiceStatus } from '@openstatuspage/shared';
import { statusShapePath } from '../utils/shapes';

export function statusVar(status: ServiceStatus): string {
  return `var(--status-${status.replace('_', '-')})`;
}

/** Small inline SVG of a map marker, used by the map legend. */
export function StatusMarkerIcon({ status, className }: { status: ServiceStatus; className?: string }) {
  return (
    <svg aria-hidden viewBox="-8 -8 16 16" className={className} width="12" height="12" focusable="false">
      <path d={statusShapePath(status, 6)} style={{ fill: statusVar(status) }} className="stroke-surface" strokeWidth={1.5} />
    </svg>
  );
}
