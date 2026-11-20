/**
 * /world-map.svg: the countries of the world map as one SVG, for the map that
 * is rendered on the server and shown without JavaScript (StaticWorldMap.tsx).
 * Generated at build time (and served by the dev server) by the Vite plugin in
 * vite.config.ts, so neither the server nor the HTML carries the country data.
 *
 * The page uses it as a CSS mask over a theme color, so the map follows the
 * theme; the country borders are cut out of the land by an SVG mask.
 */
import { geoNaturalEarth1, geoPath, type ExtendedFeature, type ExtendedFeatureCollection } from 'd3-geo';
import { feature } from 'topojson-client';
import world from 'world-atlas/countries-110m.json' with { type: 'json' };
import { MAP_HEIGHT, MAP_SCALE, MAP_TRANSLATE, MAP_WIDTH } from '../src/public/utils/map-projection.ts';

/** Antarctica only takes space on a map of data centers. */
const ANTARCTICA = '010';

/** The countries the map shows (the same for the interactive map). */
export function worldCountries(): ExtendedFeatureCollection<ExtendedFeature> {
  const topology = world as unknown as Parameters<typeof feature>[0];
  const all = feature(topology, 'countries') as unknown as ExtendedFeatureCollection<ExtendedFeature>;
  return { ...all, features: all.features.filter((f) => f.id !== ANTARCTICA) };
}

export function worldMapSvg(): string {
  const projection = geoNaturalEarth1()
    .scale(MAP_SCALE)
    .translate([...MAP_TRANSLATE]);
  const path = geoPath(projection).digits(1);
  const d = worldCountries()
    .features.map((f) => path(f) ?? '')
    .join('');
  const size = `width="${MAP_WIDTH}" height="${MAP_HEIGHT}"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}" ${size}>` +
    `<defs><path id="c" d="${d}"/>` +
    `<mask id="m"><rect ${size} fill="#fff"/><use href="#c" fill="none" stroke="#000" stroke-width="1.2"/></mask></defs>` +
    `<use href="#c" mask="url(#m)"/></svg>\n`
  );
}
