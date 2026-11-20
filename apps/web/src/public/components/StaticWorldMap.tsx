/**
 * The world map as the server renders it, shown without JavaScript and until
 * the interactive map (WorldMap.tsx) has loaded: the countries come from
 * /world-map.svg (a CSS mask over the theme's surface color, so it follows the
 * theme), the markers are SVG with the same projection, shapes and colors.
 * Same size as the interactive map, so swapping them moves nothing. The list of
 * locations below the map is its text alternative.
 */
import type { PublicLocation } from '@openstatuspage/shared';
import { useTranslation } from 'react-i18next';
import { MAP_HEIGHT, MAP_WIDTH, projectPoint } from '../utils/map-projection';
import { statusShapePath } from '../utils/shapes';
import { statusVar } from './StatusMarker';

const MARKER = 6;
const COUNTRIES = 'url(/world-map.svg)';

export function StaticWorldMap({ locations }: { locations: PublicLocation[] }) {
  const { t } = useTranslation('public');
  const markers = locations
    .filter((l) => l.latitude !== null && l.longitude !== null)
    .map((l) => ({ location: l, point: projectPoint(l.longitude!, l.latitude!) }));
  return (
    <div
      role="img"
      aria-label={t('locations.mapLabel', { count: markers.length })}
      className="relative w-full"
      style={{ aspectRatio: `${MAP_WIDTH} / ${MAP_HEIGHT}` }}
    >
      <div
        className="absolute inset-0 bg-surface-2"
        style={{ maskImage: COUNTRIES, WebkitMaskImage: COUNTRIES, maskSize: '100% 100%', WebkitMaskSize: '100% 100%' }}
      />
      <svg viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} className="absolute inset-0 block size-full" aria-hidden focusable="false">
        {markers.map(({ location: l, point: [x, y] }) => (
          <g key={l.id} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
            <circle r={MARKER * 2.4} style={{ fill: statusVar(l.status) }} opacity={0.18} />
            <path d={statusShapePath(l.status, MARKER)} style={{ fill: statusVar(l.status) }} className="stroke-surface" strokeWidth={MARKER / 2.5} />
          </g>
        ))}
      </svg>
    </div>
  );
}
