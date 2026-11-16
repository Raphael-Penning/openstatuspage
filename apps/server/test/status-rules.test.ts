import { describe, expect, it } from 'vitest';
import { aggregateMonitorStatus, computeEffectiveStatus, type CheckLinkState } from '../src/services/status-rules.js';

const link = (state: CheckLinkState['state'], critical: CheckLinkState['criticalStatus'] = 'major_outage'): CheckLinkState => ({
  state,
  warningStatus: 'degraded',
  criticalStatus: critical,
  unknownStatus: null,
});

describe('aggregateMonitorStatus', () => {
  it('is operational without checks', () => {
    expect(aggregateMonitorStatus('worst', [])).toBe('operational');
  });
  it('worst: any critical check wins', () => {
    expect(aggregateMonitorStatus('worst', [link('ok'), link('critical')])).toBe('major_outage');
    expect(aggregateMonitorStatus('worst', [link('ok'), link('warning')])).toBe('degraded');
  });
  it('ignores unknown by default and ignored mappings', () => {
    expect(aggregateMonitorStatus('worst', [link('unknown')])).toBe('operational');
    expect(aggregateMonitorStatus('worst', [link('critical', null)])).toBe('operational');
  });
  it('quorum: partial failure caps at partial_outage', () => {
    expect(aggregateMonitorStatus('quorum', [link('ok'), link('critical')])).toBe('partial_outage');
  });
  it('quorum: all failing yields the mapped status', () => {
    expect(aggregateMonitorStatus('quorum', [link('critical'), link('critical')])).toBe('major_outage');
  });
  it('quorum: warnings cap at degraded', () => {
    expect(aggregateMonitorStatus('quorum', [link('warning'), link('warning')])).toBe('degraded');
  });
});

describe('computeEffectiveStatus', () => {
  const base = { statusMode: 'auto' as const, manualStatus: 'operational' as const, incidentStatuses: [], inMaintenance: false };
  it('uses monitor status in auto mode', () => {
    expect(computeEffectiveStatus({ ...base, monitorStatus: 'degraded' })).toBe('degraded');
  });
  it('uses manual status in manual mode', () => {
    expect(computeEffectiveStatus({ ...base, statusMode: 'manual', manualStatus: 'partial_outage', monitorStatus: 'operational' })).toBe('partial_outage');
  });
  it('incidents override when worse', () => {
    expect(computeEffectiveStatus({ ...base, monitorStatus: 'degraded', incidentStatuses: ['major_outage'] })).toBe('major_outage');
  });
  it('maintenance hides failing checks but not incidents', () => {
    expect(computeEffectiveStatus({ ...base, monitorStatus: 'major_outage', inMaintenance: true })).toBe('maintenance');
    expect(computeEffectiveStatus({ ...base, monitorStatus: 'operational', inMaintenance: true, incidentStatuses: ['partial_outage'] })).toBe('partial_outage');
  });
});
