import type { PublicLocation, PublicService, PublicServiceGroup } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import { filterServices, groupByRegion, incidentTone, maintenanceTone, matchesCounter, toCounters } from './status';

function service(name: string, status: PublicService['status'] = 'operational'): PublicService {
  return {
    id: name,
    slug: name.toLowerCase(),
    name,
    description: null,
    kind: 'service',
    url: null,
    groupId: null,
    status,
    locationIds: [],
    uptimePercent: null,
  };
}

function group(name: string, services: PublicService[]): PublicServiceGroup {
  return { id: name, slug: name.toLowerCase(), name, description: null, collapsedByDefault: false, status: 'operational', services };
}

describe('tones', () => {
  it('maps incidents to colors', () => {
    expect(incidentTone({ status: 'investigating', impact: 'critical' })).toBe('major_outage');
    expect(incidentTone({ status: 'identified', impact: 'major' })).toBe('partial_outage');
    expect(incidentTone({ status: 'monitoring', impact: 'none' })).toBe('degraded');
    expect(incidentTone({ status: 'resolved', impact: 'critical' })).toBe('operational');
  });

  it('maps maintenance to colors', () => {
    expect(maintenanceTone('in_progress')).toBe('maintenance');
    expect(maintenanceTone('scheduled')).toBe('maintenance');
    expect(maintenanceTone('completed')).toBe('operational');
    expect(maintenanceTone('cancelled')).toBeNull();
  });
});

describe('counters', () => {
  it('merges partial and major outages into offline', () => {
    expect(toCounters({ operational: 5, degraded: 1, partial_outage: 2, major_outage: 1, maintenance: 0 })).toEqual({
      operational: 5,
      degraded: 1,
      offline: 3,
      maintenance: 0,
    });
    expect(matchesCounter('major_outage', 'offline')).toBe(true);
    expect(matchesCounter('degraded', 'offline')).toBe(false);
  });
});

describe('filterServices', () => {
  const groups = [
    group('Platform', [service('Web Application'), service('Public API', 'degraded')]),
    group('Network', [service('DNS'), service('Zürich Edge')]),
  ];
  const ungrouped = [service('Mail', 'major_outage')];

  it('matches service names case and accent insensitive', () => {
    const r = filterServices(groups, ungrouped, { query: 'zurich' });
    expect(r.groups.map((g) => g.services.map((s) => s.name))).toEqual([['Zürich Edge']]);
    expect(r.ungrouped).toEqual([]);
  });

  it('keeps all services of a matching group', () => {
    const r = filterServices(groups, ungrouped, { query: 'platform' });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]?.services).toHaveLength(2);
  });

  it('filters by counter', () => {
    const r = filterServices(groups, ungrouped, { counter: 'offline' });
    expect(r.groups).toEqual([]);
    expect(r.ungrouped.map((s) => s.name)).toEqual(['Mail']);
  });
});

describe('groupByRegion', () => {
  it('uses the canonical region order and drops empty regions', () => {
    const loc = (name: string, region: PublicLocation['region']): PublicLocation => ({
      id: name,
      slug: name,
      name,
      code: null,
      city: null,
      country: null,
      region,
      latitude: null,
      longitude: null,
      description: null,
      status: 'operational',
      serviceIds: [],
    });
    const r = groupByRegion([loc('Sydney', 'oceania'), loc('Frankfurt', 'europe'), loc('Paris', 'europe')]);
    expect(r.map((g) => [g.region, g.locations.length])).toEqual([
      ['europe', 2],
      ['oceania', 1],
    ]);
  });
});
