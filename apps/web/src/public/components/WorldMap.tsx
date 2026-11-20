/**
 * World map with location markers. The map data (Natural Earth 1:110m via
 * world-atlas) is bundled, so no tiles or other third-party requests are made.
 * Loaded lazily from the locations page.
 */
import type { PublicLocation } from '@openstatuspage/shared';
import { clsx } from 'clsx';
import { geoNaturalEarth1, geoPath, type ExtendedFeature, type ExtendedFeatureCollection } from 'd3-geo';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Maximize2, Minus, Plus } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { feature } from 'topojson-client';
import world from 'world-atlas/countries-110m.json';
import { useCountryName } from '../hooks/countries';
import { MAP_HEIGHT, MAP_SCALE, MAP_TRANSLATE, MAP_WIDTH } from '../utils/map-projection';
import { statusShapePath } from '../utils/shapes';
import { statusVar } from './StatusMarker';
import { StatusPill } from './ui';

const WIDTH = MAP_WIDTH;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
/** Antarctica only takes space on a map of data centers. */
const ANTARCTICA = '010';

type Countries = ExtendedFeatureCollection<ExtendedFeature>;

const countries: Countries = (() => {
  const topology = world as unknown as Parameters<typeof feature>[0];
  const all = feature(topology, 'countries') as unknown as Countries;
  return { ...all, features: all.features.filter((f) => f.id !== ANTARCTICA) };
})();

// The same projection as the map rendered on the server (StaticWorldMap), so markers do not move.
const projection = geoNaturalEarth1()
  .scale(MAP_SCALE)
  .translate([...MAP_TRANSLATE]);
const path = geoPath(projection);
const HEIGHT = MAP_HEIGHT;
const countryPaths = countries.features.map((f, i) => ({ id: String(f.id ?? i), d: path(f) ?? '' }));

interface View {
  k: number;
  cx: number;
  cy: number;
}

const INITIAL: View = { k: 1, cx: WIDTH / 2, cy: HEIGHT / 2 };

function clampView(v: View): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k));
  const halfW = WIDTH / (2 * k);
  const halfH = HEIGHT / (2 * k);
  return {
    k,
    cx: Math.min(WIDTH - halfW, Math.max(halfW, v.cx)),
    cy: Math.min(HEIGHT - halfH, Math.max(halfH, v.cy)),
  };
}

interface WorldMapProps {
  locations: PublicLocation[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export default function WorldMap({ locations, selectedId, onSelect }: WorldMapProps) {
  const { t } = useTranslation('public');
  const countryName = useCountryName();
  const [view, setView] = useState<View>(INITIAL);
  const [hoverId, setHoverIdNow] = useState<string | null>(null);
  /** Tooltip hidden with Escape until another marker is hovered, focused or selected (WCAG 1.4.13). */
  const [tooltipHidden, setTooltipHidden] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const hintId = useId();
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const markers = useMemo(
    () =>
      locations
        .filter((l) => l.latitude !== null && l.longitude !== null)
        .map((l) => {
          const p = projection([l.longitude!, l.latitude!]);
          return p ? { location: l, x: p[0], y: p[1] } : null;
        })
        .filter((m): m is { location: PublicLocation; x: number; y: number } => m !== null),
    [locations],
  );

  // Leaving a marker hides its tooltip a moment later, so the pointer can move onto the tooltip.
  function setHoverId(id: string | null) {
    window.clearTimeout(hideTimer.current);
    if (id === null) {
      hideTimer.current = window.setTimeout(() => setHoverIdNow(null), 300);
      return;
    }
    setTooltipHidden(false);
    setHoverIdNow(id);
  }
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  useEffect(() => setTooltipHidden(false), [selectedId]);

  const tooltipShown = (hoverId ?? selectedId) !== null && !tooltipHidden;
  useEffect(() => {
    if (!tooltipShown) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setTooltipHidden(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tooltipShown]);

  // Bring a marker selected from the list into view when zoomed in.
  useEffect(() => {
    const m = markers.find((x) => x.location.id === selectedId);
    if (m) setView((v) => (v.k > 1 ? clampView({ ...v, cx: m.x, cy: m.y }) : v));
  }, [selectedId, markers]);

  const vbW = WIDTH / view.k;
  const vbH = HEIGHT / view.k;
  const vbX = view.cx - vbW / 2;
  const vbY = view.cy - vbH / 2;
  const activeId = hoverId ?? selectedId;
  const active = markers.find((m) => m.location.id === activeId);

  const zoom = (factor: number) => setView((v) => clampView({ ...v, k: v.k * factor }));
  // Buttons for panning: dragging must not be the only way (WCAG 2.5.7, 2.1.1).
  const pan = (dx: number, dy: number) =>
    setView((v) => clampView({ ...v, cx: v.cx + (dx * WIDTH) / (4 * v.k), cy: v.cy + (dy * HEIGHT) / (4 * v.k) }));

  function onPointerDown(e: PointerEvent<SVGSVGElement>) {
    if (view.k <= 1 || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, view, moved: false };
  }

  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    const svg = svgRef.current;
    if (!d || !svg) return;
    const rect = svg.getBoundingClientRect();
    const dx = ((e.clientX - d.x) / rect.width) * (WIDTH / d.view.k);
    const dy = ((e.clientY - d.y) / rect.height) * (HEIGHT / d.view.k);
    if (!d.moved && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) {
      d.moved = true;
      svg.setPointerCapture(e.pointerId);
    }
    if (d.moved) setView(clampView({ ...d.view, cx: d.view.cx - dx, cy: d.view.cy - dy }));
  }

  function onPointerUp() {
    drag.current = null;
  }

  function onMarkerKey(e: KeyboardEvent<SVGGElement>, id: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(selectedId === id ? null : id);
    } else if (e.key === 'Escape') {
      onSelect(null);
    }
  }

  const r = 6 / Math.sqrt(view.k);
  const left = active ? ((active.x - vbX) / vbW) * 100 : 0;
  const top = active ? ((active.y - vbY) / vbH) * 100 : 0;
  const below = top < 30;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        role="group"
        aria-label={t('locations.mapLabel', { count: markers.length })}
        aria-describedby={hintId}
        className={clsx('block h-auto w-full touch-pan-y select-none', view.k > 1 && 'cursor-grab active:cursor-grabbing')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <g aria-hidden>
          {countryPaths.map((c) => (
            <path
              key={c.id}
              d={c.d}
              className="fill-surface-2 stroke-border"
              strokeWidth={0.6}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
        {markers.map(({ location: l, x, y }) => {
          const isActive = l.id === activeId;
          const label = [
            l.name,
            l.code,
            l.city,
            countryName(l.country),
          ]
            .filter(Boolean)
            .join(', ');
          return (
            <g
              key={l.id}
              role="button"
              tabIndex={0}
              aria-pressed={selectedId === l.id}
              aria-label={`${label}: ${t(`common:status.${l.status}`)}`}
              transform={`translate(${x} ${y})`}
              onPointerEnter={() => setHoverId(l.id)}
              onPointerLeave={() => setHoverId(null)}
              onFocus={() => setHoverId(l.id)}
              onBlur={() => setHoverId(null)}
              onClick={() => {
                if (!drag.current?.moved) onSelect(selectedId === l.id ? null : l.id);
              }}
              onKeyDown={(e) => onMarkerKey(e, l.id)}
              className="cursor-pointer outline-none [&:focus-visible>path]:stroke-[color:var(--focus)]"
            >
              <circle r={r * 2.4} style={{ fill: statusVar(l.status) }} opacity={isActive ? 0.35 : 0.18} />
              <path
                d={statusShapePath(l.status, isActive ? r * 1.35 : r)}
                style={{ fill: statusVar(l.status) }}
                className="stroke-surface"
                strokeWidth={r / 2.5}
              />
            </g>
          );
        })}
      </svg>

      <p id={hintId} className="sr-only">
        {t('locations.mapHint')}
      </p>

      {active && !tooltipHidden && (
        <div
          role="tooltip"
          onPointerEnter={() => active && setHoverId(active.location.id)}
          onPointerLeave={() => setHoverId(null)}
          className={clsx(
            'absolute z-10 w-max max-w-60 -translate-x-1/2 rounded-xl border border-border bg-surface px-3 py-2 text-sm shadow-lg',
            below ? 'mt-3' : '-mt-3 -translate-y-full',
          )}
          style={{ left: `${Math.min(88, Math.max(12, left))}%`, top: `${top}%` }}
        >
          <p className="font-semibold">
            {active.location.name}
            {active.location.code && <span className="ml-1.5 font-normal text-muted">{active.location.code}</span>}
          </p>
          {(active.location.city || active.location.country) && (
            <p className="text-xs text-muted">
              {[active.location.city, countryName(active.location.country)].filter(Boolean).join(', ')}
            </p>
          )}
          <StatusPill status={active.location.status} className="mt-1.5" />
        </div>
      )}

      <div className="absolute right-3 bottom-3 flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
        <MapButton label={t('locations.zoomIn')} onClick={() => zoom(1.6)} disabled={view.k >= MAX_ZOOM}>
          <Plus aria-hidden className="size-4" />
        </MapButton>
        <MapButton label={t('locations.zoomOut')} onClick={() => zoom(1 / 1.6)} disabled={view.k <= MIN_ZOOM}>
          <Minus aria-hidden className="size-4" />
        </MapButton>
        <MapButton label={t('locations.resetZoom')} onClick={() => setView(INITIAL)} disabled={view.k === 1}>
          <Maximize2 aria-hidden className="size-4" />
        </MapButton>
      </div>

      {view.k > 1 && (
        <div
          role="group"
          aria-label={t('locations.pan')}
          className="absolute bottom-3 left-3 grid grid-cols-3 overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
        >
          <span />
          <MapButton label={t('locations.panUp')} onClick={() => pan(0, -1)}>
            <ArrowUp aria-hidden className="size-4" />
          </MapButton>
          <span />
          <MapButton label={t('locations.panLeft')} onClick={() => pan(-1, 0)}>
            <ArrowLeft aria-hidden className="size-4" />
          </MapButton>
          <span />
          <MapButton label={t('locations.panRight')} onClick={() => pan(1, 0)}>
            <ArrowRight aria-hidden className="size-4" />
          </MapButton>
          <span />
          <MapButton label={t('locations.panDown')} onClick={() => pan(0, 1)}>
            <ArrowDown aria-hidden className="size-4" />
          </MapButton>
          <span />
        </div>
      )}
    </div>
  );
}

function MapButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-9 place-items-center text-fg hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:text-muted disabled:opacity-50"
    >
      {children}
    </button>
  );
}
