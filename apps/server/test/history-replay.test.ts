import type { CheckState, ServiceStatus } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import {
  clipToWindows,
  eventsToIntervals,
  mergeAdjacent,
  subtractSpans,
  totalLength,
  unionSpans,
  valueAt,
  type Valued,
} from '../src/lib/intervals.js';
import { replayServiceHistory, type ReplayInput, type ReplayLink } from '../src/services/history-replay.js';

const H = 3_600_000;
const v = <T>(start: number, end: number, value: T): Valued<T> => ({ start: start * H, end: end * H, value });
const span = (start: number, end: number) => ({ start: start * H, end: end * H });
const hours = <T>(items: Valued<T>[]) => items.map((i) => [i.start / H, i.end / H, i.value]);

describe('interval helpers', () => {
  it('unions, subtracts and measures spans', () => {
    expect(unionSpans([span(5, 6), span(0, 2), span(1, 3), span(3, 4)])).toEqual([span(0, 4), span(5, 6)]);
    expect(subtractSpans(span(0, 10), [span(2, 3), span(-5, 1), span(8, 20)])).toEqual([span(1, 2), span(3, 8)]);
    expect(subtractSpans(span(0, 10), [])).toEqual([span(0, 10)]);
    expect(subtractSpans(span(0, 10), [span(-1, 11)])).toEqual([]);
    expect(totalLength([span(0, 2), span(1, 3)])).toBe(3 * H);
  });

  it('clips to windows and merges equal neighbours', () => {
    const items = [v(0, 5, 'ok'), v(5, 10, 'critical')];
    expect(hours(clipToWindows(items, [span(1, 2), span(4, 6)]))).toEqual([
      [1, 2, 'ok'],
      [4, 5, 'ok'],
      [5, 6, 'critical'],
    ]);
    expect(hours(mergeAdjacent([v(2, 3, 'ok'), v(0, 2, 'ok'), v(4, 5, 'ok')]))).toEqual([
      [0, 3, 'ok'],
      [4, 5, 'ok'],
    ]);
  });

  it('turns events into intervals with an optional maximum hold time', () => {
    const events = [
      { at: 0, value: 'ok' },
      { at: 1 * H, value: 'ok' },
      { at: 2 * H, value: 'critical' },
      { at: 10 * H, value: 'ok' },
    ];
    expect(hours(eventsToIntervals(events, 12 * H))).toEqual([
      [0, 2, 'ok'],
      [2, 10, 'critical'],
      [10, 12, 'ok'],
    ]);
    // A sample is valid for at most 3 hours: a silent period becomes a gap.
    expect(hours(eventsToIntervals(events, 12 * H, 3 * H))).toEqual([
      [0, 2, 'ok'],
      [2, 5, 'critical'],
      [10, 12, 'ok'],
    ]);
  });

  it('finds the value at a point in time', () => {
    const items = [v(0, 2, 'a'), v(3, 5, 'b')];
    expect(valueAt(items, 1 * H)).toBe('a');
    expect(valueAt(items, 2 * H)).toBeUndefined();
    expect(valueAt(items, 3 * H)).toBe('b');
    expect(valueAt(items, 5 * H)).toBeUndefined();
  });
});

const link = (checkId: string, critical: ServiceStatus | null = 'major_outage'): ReplayLink => ({
  checkId,
  warningStatus: 'degraded',
  criticalStatus: critical as ReplayLink['criticalStatus'],
  unknownStatus: null,
});

function input(partial: Partial<ReplayInput> & Pick<ReplayInput, 'services' | 'checks'>): ReplayInput {
  return { bundles: new Map(), incidents: [], maintenances: [], ...partial };
}

describe('replayServiceHistory', () => {
  it('maps check states through the link mapping, only inside the windows', () => {
    const result = replayServiceHistory(
      input({
        services: [{ id: 's', aggregation: 'worst', links: [link('a')], windows: [span(0, 10)] }],
        checks: new Map([['a', [v(-5, 3, 'ok'), v(3, 4, 'critical'), v(4, 6, 'warning'), v(6, 20, 'ok')]]]),
      }),
    );
    expect(hours(result.get('s')!)).toEqual([
      [0, 3, 'operational'],
      [3, 4, 'major_outage'],
      [4, 6, 'degraded'],
      [6, 10, 'operational'],
    ]);
  });

  it('leaves periods without any check data empty and ignores checks without data', () => {
    const result = replayServiceHistory(
      input({
        services: [{ id: 's', aggregation: 'worst', links: [link('a'), link('b')], windows: [span(0, 10)] }],
        checks: new Map([
          ['a', [v(2, 8, 'ok')]],
          ['b', [v(4, 6, 'critical')]],
        ]),
      }),
    );
    expect(hours(result.get('s')!)).toEqual([
      [2, 4, 'operational'],
      [4, 6, 'major_outage'],
      [6, 8, 'operational'],
    ]);
  });

  it('applies quorum aggregation like the live engine', () => {
    const checks = new Map<string, Valued<CheckState>[]>([
      ['a', [v(0, 2, 'critical'), v(2, 4, 'critical')]],
      ['b', [v(0, 2, 'ok'), v(2, 4, 'critical')]],
    ]);
    const result = replayServiceHistory(
      input({ services: [{ id: 's', aggregation: 'quorum', links: [link('a'), link('b')], windows: [span(0, 4)] }], checks }),
    );
    expect(hours(result.get('s')!)).toEqual([
      [0, 2, 'partial_outage'],
      [2, 4, 'major_outage'],
    ]);
  });

  it('replays maintenance windows and incidents on top of the monitor status', () => {
    const result = replayServiceHistory(
      input({
        services: [{ id: 's', aggregation: 'worst', links: [link('a')], windows: [span(0, 10)] }],
        checks: new Map([['a', [v(0, 10, 'critical')]]]),
        maintenances: [{ serviceId: 's', start: 1 * H, end: 3 * H }],
        incidents: [
          { serviceId: 's', status: 'degraded', start: 5 * H, end: 6 * H },
          { serviceId: 'other', status: 'major_outage', start: 0, end: null },
        ],
      }),
    );
    expect(hours(result.get('s')!)).toEqual([
      [0, 1, 'major_outage'],
      [1, 3, 'maintenance'],
      [3, 10, 'major_outage'],
    ]);

    const okWithIncident = replayServiceHistory(
      input({
        services: [{ id: 's', aggregation: 'worst', links: [link('a')], windows: [span(0, 10)] }],
        checks: new Map([['a', [v(0, 10, 'ok')]]]),
        incidents: [{ serviceId: 's', status: 'partial_outage', start: 5 * H, end: null }],
      }),
    );
    expect(hours(okWithIncident.get('s')!)).toEqual([
      [0, 5, 'operational'],
      [5, 10, 'partial_outage'],
    ]);
  });

  it('computes bundle checks by weighted vote; members without data do not report', () => {
    const checks = new Map<string, Valued<CheckState>[]>([
      // Member a (2 votes) has data the whole time, b and c (1 vote each) only partly.
      ['a', [v(0, 4, 'critical'), v(4, 10, 'ok')]],
      ['b', [v(0, 2, 'ok'), v(2, 10, 'critical')]],
      ['c', [v(0, 6, 'ok')]],
    ]);
    const result = replayServiceHistory(
      input({
        services: [{ id: 's', aggregation: 'worst', links: [link('bundle')], windows: [span(0, 10)] }],
        checks,
        bundles: new Map([
          [
            'bundle',
            [
              { checkId: 'a', votes: 2 },
              { checkId: 'b', votes: 1 },
              { checkId: 'c', votes: 1 },
            ],
          ],
        ]),
      }),
    );
    // 0-2: a critical (2 of 4) = exactly half → not down
    // 2-4: a + b critical (3 of 4) → down
    // 4-6: b critical (1 of 4) → ok
    // 6-10: c silent: b critical (1 of 3 reporting) → ok
    expect(hours(result.get('s')!)).toEqual([
      [0, 2, 'operational'],
      [2, 4, 'major_outage'],
      [4, 10, 'operational'],
    ]);
  });

  it('prefers recorded bundle history over the computed vote and handles unknown members', () => {
    const result = replayServiceHistory(
      input({
        services: [
          {
            id: 's',
            aggregation: 'worst',
            links: [{ ...link('bundle'), unknownStatus: 'degraded' }],
            windows: [span(0, 6)],
          },
        ],
        checks: new Map<string, Valued<CheckState>[]>([
          ['a', [v(0, 6, 'unknown')]],
          ['bundle', [v(4, 6, 'critical')]],
        ]),
        bundles: new Map([['bundle', [{ checkId: 'a', votes: 1 }]]]),
      }),
    );
    // Only an unknown member → the vote is unknown (mapped to degraded here); recorded history wins from 4h.
    expect(hours(result.get('s')!)).toEqual([
      [0, 4, 'degraded'],
      [4, 6, 'major_outage'],
    ]);
  });

  it('uses explicit service statuses (CSV) where present', () => {
    const result = replayServiceHistory(
      input({
        services: [{ id: 's', aggregation: 'worst', links: [link('a')], windows: [span(0, 10)] }],
        checks: new Map([['a', [v(0, 10, 'ok')]]]),
        explicit: new Map([['s', [v(2, 3, 'major_outage')]]]),
      }),
    );
    expect(hours(result.get('s')!)).toEqual([
      [0, 2, 'operational'],
      [2, 3, 'major_outage'],
      [3, 10, 'operational'],
    ]);
  });
});
