import type { DailyUptime } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import { applyCorrections, markCorrectedDays, sortLayers, type CorrectionLayer } from '../src/services/history-corrections.js';
import { averageUptime, computeDailyUptime, type StatusSegment } from '../src/services/uptime.js';

const now = new Date('2026-01-10T12:00:00.000Z');
const T = (s: string) => `2026-01-${s}:00.000Z`;

const seg = (status: StatusSegment['status'], start: string, end: string | null): StatusSegment => ({
  status,
  started_at: T(start),
  ended_at: end === null ? null : T(end),
});

const correction = (
  id: string,
  status: CorrectionLayer['status'],
  start: string,
  end: string,
  order = '2026-01-10T00:00:00.000Z',
): CorrectionLayer => ({ kind: 'correction', id, status, start: T(start), end: T(end), order });

const maintenance = (id: string, start: string, end: string | null): CorrectionLayer => ({
  kind: 'maintenance',
  id,
  status: 'maintenance',
  start: T(start),
  end: end === null ? null : T(end),
  order: '2026-01-01T00:00:00.000Z',
});

const simple = (segments: ReturnType<typeof applyCorrections>) =>
  segments.map((s) => [s.status, s.started_at.slice(8, 16), s.ended_at?.slice(8, 16) ?? null, s.source, s.sourceId]);

describe('applyCorrections', () => {
  it('returns the measured history unchanged without layers', () => {
    const measured = [seg('operational', '08T00:00', '09T06:00'), seg('major_outage', '09T06:00', null)];
    expect(simple(applyCorrections(measured, [], now))).toEqual([
      ['operational', '08T00:00', '09T06:00', 'measured', null],
      ['major_outage', '09T06:00', null, 'measured', null],
    ]);
  });

  it('replaces a partially overlapped segment and keeps both remainders', () => {
    const measured = [seg('major_outage', '09T00:00', '09T12:00')];
    const result = applyCorrections(measured, [correction('c1', 'operational', '09T03:00', '09T06:00')], now);
    expect(simple(result)).toEqual([
      ['major_outage', '09T00:00', '09T03:00', 'measured', null],
      ['operational', '09T03:00', '09T06:00', 'correction', 'c1'],
      ['major_outage', '09T06:00', '09T12:00', 'measured', null],
    ]);
  });

  it('spans several segments and cuts the edges', () => {
    const measured = [
      seg('operational', '09T00:00', '09T04:00'),
      seg('major_outage', '09T04:00', '09T05:00'),
      seg('degraded', '09T05:00', '09T08:00'),
    ];
    const result = applyCorrections(measured, [correction('c1', 'operational', '09T03:30', '09T06:00')], now);
    expect(simple(result)).toEqual([
      ['operational', '09T00:00', '09T03:30', 'measured', null],
      ['operational', '09T03:30', '09T06:00', 'correction', 'c1'],
      ['degraded', '09T06:00', '09T08:00', 'measured', null],
    ]);
  });

  it('keeps an open measured segment open after the correction', () => {
    const measured = [seg('major_outage', '09T00:00', null)];
    const result = applyCorrections(measured, [correction('c1', 'operational', '09T00:00', '09T10:00')], now);
    expect(simple(result)).toEqual([
      ['operational', '09T00:00', '09T10:00', 'correction', 'c1'],
      ['major_outage', '09T10:00', null, 'measured', null],
    ]);
  });

  it('clips everything at now (running maintenance, correction reaching into the future)', () => {
    const measured = [seg('major_outage', '10T00:00', null)];
    expect(simple(applyCorrections(measured, [maintenance('m1', '10T06:00', null)], now))).toEqual([
      ['major_outage', '10T00:00', '10T06:00', 'measured', null],
      ['maintenance', '10T06:00', '10T12:00', 'maintenance', 'm1'],
    ]);
    expect(simple(applyCorrections(measured, [correction('c1', 'operational', '10T11:00', '10T18:00')], now))).toEqual([
      ['major_outage', '10T00:00', '10T11:00', 'measured', null],
      ['operational', '10T11:00', '10T12:00', 'correction', 'c1'],
    ]);
    // Completely in the future: ignored.
    expect(applyCorrections(measured, [correction('c2', 'operational', '10T13:00', '10T14:00')], now)).toHaveLength(1);
  });

  it('fills time without measured data', () => {
    const measured = [seg('operational', '09T12:00', null)];
    const result = applyCorrections(measured, [correction('c1', 'major_outage', '09T06:00', '09T13:00')], now);
    expect(simple(result)).toEqual([
      ['major_outage', '09T06:00', '09T13:00', 'correction', 'c1'],
      ['operational', '09T13:00', null, 'measured', null],
    ]);
  });

  it('lets the newer correction win where corrections overlap', () => {
    const measured = [seg('operational', '09T00:00', '09T12:00')];
    const older = correction('old', 'major_outage', '09T02:00', '09T06:00', '2026-01-09T13:00:00.000Z');
    const newer = correction('new', 'degraded', '09T04:00', '09T08:00', '2026-01-09T14:00:00.000Z');
    for (const layers of [
      [older, newer],
      [newer, older],
    ]) {
      expect(simple(applyCorrections(measured, layers, now))).toEqual([
        ['operational', '09T00:00', '09T02:00', 'measured', null],
        ['major_outage', '09T02:00', '09T04:00', 'correction', 'old'],
        ['degraded', '09T04:00', '09T08:00', 'correction', 'new'],
        ['operational', '09T08:00', '09T12:00', 'measured', null],
      ]);
    }
  });

  it('applies corrections over retroactive maintenance', () => {
    const measured = [seg('major_outage', '09T00:00', '09T12:00')];
    const layers = [correction('c1', 'operational', '09T02:00', '09T03:00'), maintenance('m1', '09T01:00', '09T04:00')];
    expect(sortLayers(layers).map((l) => l.id)).toEqual(['m1', 'c1']);
    expect(simple(applyCorrections(measured, layers, now))).toEqual([
      ['major_outage', '09T00:00', '09T01:00', 'measured', null],
      ['maintenance', '09T01:00', '09T02:00', 'maintenance', 'm1'],
      ['operational', '09T02:00', '09T03:00', 'correction', 'c1'],
      ['maintenance', '09T03:00', '09T04:00', 'maintenance', 'm1'],
      ['major_outage', '09T04:00', '09T12:00', 'measured', null],
    ]);
  });

  it('keeps adjacent corrections apart and merges measured pieces only with themselves', () => {
    const measured = [seg('operational', '09T00:00', '09T12:00')];
    const layers = [correction('a', 'major_outage', '09T02:00', '09T04:00'), correction('b', 'major_outage', '09T04:00', '09T06:00')];
    expect(simple(applyCorrections(measured, layers, now))).toEqual([
      ['operational', '09T00:00', '09T02:00', 'measured', null],
      ['major_outage', '09T02:00', '09T04:00', 'correction', 'a'],
      ['major_outage', '09T04:00', '09T06:00', 'correction', 'b'],
      ['operational', '09T06:00', '09T12:00', 'measured', null],
    ]);
  });

  it('ignores empty layers and segments', () => {
    const measured = [seg('operational', '09T00:00', '09T00:00'), seg('operational', '09T00:00', '09T12:00')];
    const result = applyCorrections(measured, [correction('c', 'major_outage', '09T05:00', '09T05:00')], now);
    expect(simple(result)).toEqual([['operational', '09T00:00', '09T12:00', 'measured', null]]);
  });

  it('splits correctly at UTC midnight and changes the daily uptime', () => {
    // An outage over midnight that was really a forgotten maintenance.
    const measured = [
      seg('operational', '07T00:00', '08T22:00'),
      seg('major_outage', '08T22:00', '09T02:00'),
      seg('operational', '09T02:00', null),
    ];
    const before = computeDailyUptime(measured, 3, now);
    expect(before.map((d) => d.uptime)).toEqual([round((22 / 24) * 100), round((22 / 24) * 100), 100]);

    const corrected = applyCorrections(measured, [maintenance('m1', '08T22:00', '09T02:00')], now);
    const after = computeDailyUptime(corrected, 3, now);
    expect(after.map((d) => d.uptime)).toEqual([100, 100, 100]);
    expect(after.map((d) => d.status)).toEqual(['maintenance', 'maintenance', 'operational']);
    expect(after[0]!.minutes).toEqual({ maintenance: 120 });
    expect(after[1]!.minutes).toEqual({ maintenance: 120 });
    expect(averageUptime(corrected, new Date(T('08T00:00')), now)).toBe(100);
  });

  it('corrects each service independently', () => {
    const a = [seg('major_outage', '09T00:00', null)];
    const b = [seg('major_outage', '09T00:00', null)];
    const layersA = [correction('c', 'operational', '09T00:00', '10T00:00')];
    expect(applyCorrections(a, layersA, now)[0]!.status).toBe('operational');
    expect(applyCorrections(b, [], now)[0]!.status).toBe('major_outage');
  });
});

describe('markCorrectedDays', () => {
  const day = (date: string): DailyUptime => ({ date, status: 'operational', uptime: 100, minutes: {} });
  const days = [day('2026-01-08'), day('2026-01-09'), day('2026-01-10')];

  const measured = [seg('operational', '08T00:00', null)];

  it('marks every day a public correction overlaps, with distinct notes', () => {
    const corrected = applyCorrections(
      measured,
      [
        correction('c1', 'operational', '08T23:00', '09T01:00'),
        correction('c2', 'operational', '09T05:00', '09T06:00'),
        correction('c3', 'operational', '09T07:00', '09T08:00'),
        correction('internal', 'major_outage', '10T01:00', '10T02:00'),
      ],
      now,
    );
    const notes = new Map<string, string | null>([
      ['c1', 'False alarm'],
      ['c2', 'False alarm'],
      ['c3', '  '],
    ]);
    const result = markCorrectedDays(days, corrected, notes, now);
    expect(result[0]).toMatchObject({ corrected: true, correctionNotes: ['False alarm'] });
    expect(result[1]).toMatchObject({ corrected: true, correctionNotes: ['False alarm'] });
    expect(result[2]!.corrected).toBeUndefined();
    expect(days[0]!.corrected).toBeUndefined();
  });

  it('treats the end as exclusive at UTC midnight', () => {
    const corrected = applyCorrections(measured, [correction('c1', 'operational', '08T20:00', '09T00:00')], now);
    const result = markCorrectedDays(days, corrected, new Map([['c1', null]]), now);
    expect(result.map((d) => d.corrected ?? false)).toEqual([true, false, false]);
    expect(result[0]!.correctionNotes).toEqual([]);
  });

  it('does not mark a public correction that a newer internal one fully replaces', () => {
    const corrected = applyCorrections(
      measured,
      [
        correction('public', 'operational', '09T05:00', '09T06:00', '2026-01-09T00:00:00.000Z'),
        correction('internal', 'major_outage', '09T04:00', '09T07:00', '2026-01-10T00:00:00.000Z'),
      ],
      now,
    );
    const result = markCorrectedDays(days, corrected, new Map([['public', 'Note']]), now);
    expect(result.map((d) => d.corrected ?? false)).toEqual([false, false, false]);
  });

  it('keeps the mark for the part of a public correction that is still in effect', () => {
    const corrected = applyCorrections(
      measured,
      [
        correction('public', 'operational', '08T22:00', '09T06:00', '2026-01-09T00:00:00.000Z'),
        correction('internal', 'major_outage', '08T20:00', '09T00:00', '2026-01-10T00:00:00.000Z'),
      ],
      now,
    );
    const result = markCorrectedDays(days, corrected, new Map([['public', 'Note']]), now);
    expect(result.map((d) => d.corrected ?? false)).toEqual([false, true, false]);
  });
});

function round(n: number) {
  return Math.round(n * 100) / 100;
}
