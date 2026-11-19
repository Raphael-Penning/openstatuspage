/**
 * Marker shapes per status for the world map and its legend. Each status has
 * its own shape in addition to its color, so the map does not rely on color
 * alone (WCAG 1.4.1). Paths are centered on 0,0 and fit a circle of radius r.
 */
import type { ServiceStatus } from '@openstatuspage/shared';

const f = (n: number) => Number(n.toFixed(3));

export type StatusShape = 'circle' | 'square' | 'triangle' | 'diamond' | 'cross';

export const STATUS_SHAPE: Record<ServiceStatus, StatusShape> = {
  operational: 'circle',
  maintenance: 'square',
  degraded: 'triangle',
  partial_outage: 'diamond',
  major_outage: 'cross',
};

/** SVG path data of the marker of `status` with radius `r`. */
export function statusShapePath(status: ServiceStatus, r: number): string {
  switch (STATUS_SHAPE[status]) {
    case 'circle':
      return `M${f(-r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
    case 'square': {
      const s = r * 0.85;
      return `M${f(-s)} ${f(-s)}H${f(s)}V${f(s)}H${f(-s)}Z`;
    }
    case 'triangle': {
      const h = r * 1.1;
      return `M0 ${f(-h)}L${f(h)} ${f(h * 0.8)}H${f(-h)}Z`;
    }
    case 'diamond': {
      const d = r * 1.15;
      return `M0 ${f(-d)}L${f(d)} 0L0 ${f(d)}L${f(-d)} 0Z`;
    }
    case 'cross': {
      // A plus sign rotated by 45°: an "X" with arms of width w.
      const a = r * 1.05;
      const w = r * 0.42;
      const pts: [number, number][] = [
        [-w, -a], [w, -a], [w, -w], [a, -w], [a, w], [w, w], [w, a], [-w, a], [-w, w], [-a, w], [-a, -w], [-w, -w],
      ];
      const rot = Math.SQRT1_2;
      const rotated = pts.map(([x, y]) => [x * rot - y * rot, x * rot + y * rot] as const);
      return `M${rotated.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
    }
  }
}
