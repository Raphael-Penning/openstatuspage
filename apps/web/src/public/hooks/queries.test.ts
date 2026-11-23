import type { PublicIncident, PublicMaintenance, PublicPageSettings, PublicSubscription, PublicSummary } from '@openstatuspage/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import * as fx from '../a11y/fixtures';
import { fetchHistory, fetchLocations, fetchServices, type PublicServiceDetail } from './queries';

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    const { status, body } = fx.respond(init?.method ?? 'GET', url.pathname);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/vnd.api+json' } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Plain fixtures and deserialized documents agree on every field the pages use. */
describe('public API round trip', () => {
  it('summary and settings', async () => {
    const summary = await api.get<PublicSummary>('/api/public/summary');
    expect(summary).toMatchObject(fx.summary);
    expect(await api.get<PublicPageSettings>('/api/public/settings')).toEqual({ ...fx.siteSettings, id: 'site' });
  });

  it('services, service detail and locations', async () => {
    const services = await fetchServices();
    expect(services).toMatchObject({ groups: fx.groups, ungrouped: fx.ungrouped });
    expect(services.groups.map((g) => g.services.length)).toEqual(fx.groups.map((g) => g.services.length));
    const detail = await api.get<PublicServiceDetail>('/api/public/services/api');
    expect(detail.incidents).toMatchObject([fx.incident, fx.resolvedIncident]);
    expect(detail.maintenances).toMatchObject([fx.maintenance]);
    expect(await fetchLocations()).toMatchObject(fx.locations);
  });

  it('incidents, maintenance and history', async () => {
    expect(await api.get<PublicIncident>('/api/public/incidents/inc-1')).toMatchObject(fx.incident);
    expect(await api.get<PublicMaintenance>('/api/public/maintenances/m-1')).toMatchObject(fx.maintenance);
    const history = await fetchHistory({ page: 1, pageSize: 20 });
    expect(history).toMatchObject(fx.history);
  });
});

describe('subscription documents', () => {
  it('subscription, confirm result and subscribe answer', async () => {
    expect(await api.get<PublicSubscription>('/api/public/subscriptions/sub-1')).toMatchObject(fx.subscription);
    const confirmed = await api.post<PublicSubscription & { manageToken: string }>('/api/public/subscriptions/sub-1/confirm', {
      token: fx.SUBSCRIPTION_TOKEN,
    });
    expect(confirmed).toMatchObject({ ...fx.subscription, manageToken: fx.SUBSCRIPTION_TOKEN });
    expect(await api.post('/api/public/subscriptions', { email: 'jane@example.com' })).toEqual({ accepted: true });
  });
});
