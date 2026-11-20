import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { describe, expect, it } from 'vitest';
import { worldCountries, worldMapSvg } from '../../../tools/world-map';
import { MAP_HEIGHT, MAP_SCALE, MAP_TRANSLATE, MAP_WIDTH, projectPoint } from './map-projection';

describe('map projection', () => {
  const countries = worldCountries();
  const fitted = geoNaturalEarth1().fitWidth(MAP_WIDTH, countries);

  it('is Natural Earth 1 fitted to the map width', () => {
    expect(fitted.scale()).toBeCloseTo(MAP_SCALE, 9);
    expect(fitted.translate()[0]).toBeCloseTo(MAP_TRANSLATE[0], 9);
    expect(fitted.translate()[1]).toBeCloseTo(MAP_TRANSLATE[1], 9);
    expect(Math.ceil(geoPath(fitted).bounds(countries)[1][1])).toBe(MAP_HEIGHT);
  });

  it('projects points like d3-geo', () => {
    for (const [lon, lat] of [
      [8.68, 50.11],
      [-122.42, 37.77],
      [151.21, -33.87],
      [0, 0],
      [-179.9, 84],
    ] as [number, number][]) {
      const [x, y] = fitted([lon, lat])!;
      const [px, py] = projectPoint(lon, lat);
      expect(px).toBeCloseTo(x, 6);
      expect(py).toBeCloseTo(y, 6);
    }
  });

  it('generates the country shapes of the static map', () => {
    const svg = worldMapSvg();
    expect(svg).toMatch(new RegExp(`^<svg [^>]*viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}"`));
    expect(svg).toContain('<mask id="m">');
    expect(svg.length).toBeLessThan(160_000);
  });
});
