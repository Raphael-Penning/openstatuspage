/**
 * The projection of the world map: Natural Earth 1, fitted to a width of 960
 * for the countries of world-atlas without Antarctica (map-projection.test.ts
 * checks these numbers against d3-geo's fitWidth).
 *
 * The interactive map (WorldMap.tsx) draws the countries with d3-geo; the map
 * rendered on the server and shown without JavaScript (StaticWorldMap.tsx) uses
 * the country shapes of /world-map.svg (generated at build time, see
 * tools/world-map.ts) and places the markers with projectPoint, which needs
 * neither d3-geo nor the country data on the server.
 */
export const MAP_WIDTH = 960;
export const MAP_HEIGHT = 418;
export const MAP_SCALE = 177.61248501421676;
export const MAP_TRANSLATE: readonly [number, number] = [480, 244.88114144273612];

const RADIANS = Math.PI / 180;

/** Map coordinates of a longitude/latitude (the formula of d3-geo's geoNaturalEarth1Raw). */
export function projectPoint(longitude: number, latitude: number): [number, number] {
  const lambda = longitude * RADIANS;
  const phi = latitude * RADIANS;
  const phi2 = phi * phi;
  const phi4 = phi2 * phi2;
  const x = lambda * (0.8707 - 0.131979 * phi2 + phi4 * (-0.013791 + phi4 * (0.003971 * phi2 - 0.001529 * phi4)));
  const y = phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4)));
  return [MAP_TRANSLATE[0] + MAP_SCALE * x, MAP_TRANSLATE[1] - MAP_SCALE * y];
}
