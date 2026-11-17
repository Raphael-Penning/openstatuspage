import { MonitorSourceInput, SECRET_MASK, ServiceInput, type AdminMonitorSource, type AdminService } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import { parseCoordinate } from './countries';
import { bySortOrder, groupByParent, moveId, nextSortOrder } from './ordering';
import { emptyServiceForm, serviceFormToPayload, serviceToForm } from './service-form';
import { emptySourceForm, hasStoredSecret, sourceFormToPayload, sourceToForm } from './source-form';

const source = (over: Partial<AdminMonitorSource> = {}): AdminMonitorSource => ({
  id: 'src-1',
  name: 'Monitoring',
  type: 'icinga2',
  enabled: true,
  pollIntervalSeconds: 60,
  config: { baseUrl: 'https://monitoring.example.com:5665', username: 'status', password: SECRET_MASK, includeHosts: false, verifyTls: true },
  ingestUrl: 'https://status.example.com/api/ingest/src-1',
  lastPollAt: null,
  lastPollOk: null,
  lastError: null,
  checkCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('source form', () => {
  it('keeps stored secrets by sending SECRET_MASK when the input stays empty', () => {
    const s = source();
    const values = sourceToForm(s);
    expect(values.password).toBe('');
    expect(values.includeHosts).toBe(false);
    const payload = sourceFormToPayload(values, s);
    expect(payload.config).toMatchObject({ password: SECRET_MASK, username: 'status' });
    expect(MonitorSourceInput.safeParse(payload).success).toBe(true);
  });

  it('replaces secrets that were typed', () => {
    const s = source();
    const payload = sourceFormToPayload({ ...sourceToForm(s), password: 'new-secret' }, s);
    expect(payload.config).toMatchObject({ password: 'new-secret' });
  });

  it('requires new secrets when the type changes', () => {
    const s = source();
    expect(hasStoredSecret(s, 'apiKey', 'uptimekuma')).toBe(false);
    const payload = sourceFormToPayload({ ...sourceToForm(s), type: 'uptimekuma', apiKey: '' }, s);
    const res = MonitorSourceInput.safeParse(payload);
    expect(res.success).toBe(false);
  });

  it('builds type specific configs', () => {
    const base = { ...emptySourceForm(), name: 'Kuma', baseUrl: 'https://uptime.example.com', apiKey: 'key' };
    expect(sourceFormToPayload({ ...base, type: 'uptimekuma' }).config).toEqual({
      baseUrl: 'https://uptime.example.com',
      apiKey: 'key',
      verifyTls: true,
    });
    const webhook = sourceFormToPayload({ ...emptySourceForm(), name: 'Push', type: 'webhook', pollIntervalSeconds: '' });
    expect(webhook).toMatchObject({ type: 'webhook', config: {}, pollIntervalSeconds: 60 });
    expect(MonitorSourceInput.safeParse(webhook).success).toBe(true);
  });

  it('rejects an empty poll interval for pull sources', () => {
    const payload = sourceFormToPayload({ ...sourceToForm(source()), pollIntervalSeconds: '' }, source());
    expect(Number.isNaN(payload.pollIntervalSeconds)).toBe(true);
    expect(MonitorSourceInput.safeParse(payload).success).toBe(false);
  });
});

describe('service form', () => {
  it('converts empty strings to null and drops the URL for non-sites', () => {
    const payload = serviceFormToPayload({ ...emptyServiceForm(3), name: ' API ', url: 'https://example.com' });
    expect(payload).toMatchObject({ name: 'API', slug: null, description: null, url: null, groupId: null, sortOrder: 3 });
    expect(ServiceInput.safeParse(payload).success).toBe(true);
  });

  it('round-trips a stored service without embedded check details', () => {
    const svc = {
      id: 's1',
      slug: 'web',
      name: 'Web',
      description: null,
      kind: 'site',
      url: 'https://www.example.com',
      groupId: 'g1',
      sortOrder: 2,
      isPublic: true,
      statusMode: 'auto',
      manualStatus: 'operational',
      aggregation: 'quorum',
      status: 'operational',
      monitorStatus: 'operational',
      statusChangedAt: null,
      locationIds: ['l1'],
      checks: [
        {
          checkId: 'c1',
          warningStatus: null,
          criticalStatus: 'partial_outage',
          unknownStatus: null,
          check: { id: 'c1', name: 'HTTPS', host: 'web-1' },
        },
      ],
      createdAt: '',
      updatedAt: '',
    } as unknown as AdminService;
    const payload = serviceFormToPayload(serviceToForm(svc));
    expect(payload.url).toBe('https://www.example.com');
    expect(payload.checks).toEqual([{ checkId: 'c1', warningStatus: null, criticalStatus: 'partial_outage', unknownStatus: null }]);
    expect(ServiceInput.safeParse(payload).success).toBe(true);
  });
});

describe('ordering', () => {
  it('moves ids up and down and ignores out of range moves', () => {
    expect(moveId(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveId(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveId(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveId(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('groups items by parent in display order', () => {
    const groups = [
      { id: 'g2', name: 'B', sortOrder: 1 },
      { id: 'g1', name: 'A', sortOrder: 0 },
    ];
    const items = [
      { id: 's1', name: 'One', sortOrder: 1, groupId: 'g1' },
      { id: 's2', name: 'Two', sortOrder: 0, groupId: 'g1' },
      { id: 's3', name: 'Three', sortOrder: 0, groupId: null },
      { id: 's4', name: 'Four', sortOrder: 0, groupId: 'gone' },
    ];
    const res = groupByParent(items, groups);
    expect(res.groups.map((g) => g.group.id)).toEqual(['g1', 'g2']);
    expect(res.groups[0]!.items.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(res.ungrouped.map((s) => s.id)).toEqual(['s4', 's3']);
    expect([...items].sort(bySortOrder)[0]!.sortOrder).toBe(0);
  });

  it('computes the next sort order', () => {
    expect(nextSortOrder([])).toBe(0);
    expect(nextSortOrder([{ sortOrder: 0 }, { sortOrder: 4 }])).toBe(5);
  });
});

describe('parseCoordinate', () => {
  it('accepts dot and comma decimals', () => {
    expect(parseCoordinate('50.11')).toBe(50.11);
    expect(parseCoordinate('-8,5')).toBe(-8.5);
    expect(parseCoordinate(' ')).toBeNull();
    expect(Number.isNaN(parseCoordinate('abc'))).toBe(true);
  });
});
