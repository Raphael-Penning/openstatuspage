import { describe, expect, it } from 'vitest';
import { averageUptime, computeDailyUptime } from '../src/services/uptime.js';

describe('computeDailyUptime', () => {
  const now = new Date('2026-01-10T12:00:00.000Z');

  it('returns one bucket per day, oldest first, with null before data exists', () => {
    const days = computeDailyUptime(
      [{ status: 'operational', started_at: '2026-01-09T00:00:00.000Z', ended_at: null }],
      3,
      now,
    );
    expect(days.map((d) => d.date)).toEqual(['2026-01-08', '2026-01-09', '2026-01-10']);
    expect(days[0]!.status).toBeNull();
    expect(days[0]!.uptime).toBeNull();
    expect(days[1]!.uptime).toBe(100);
  });

  it('counts outages as downtime and degraded as uptime', () => {
    const days = computeDailyUptime(
      [
        { status: 'operational', started_at: '2026-01-09T00:00:00.000Z', ended_at: '2026-01-09T06:00:00.000Z' },
        { status: 'major_outage', started_at: '2026-01-09T06:00:00.000Z', ended_at: '2026-01-09T12:00:00.000Z' },
        { status: 'degraded', started_at: '2026-01-09T12:00:00.000Z', ended_at: '2026-01-10T00:00:00.000Z' },
        { status: 'operational', started_at: '2026-01-10T00:00:00.000Z', ended_at: null },
      ],
      2,
      now,
    );
    expect(days[0]).toMatchObject({ date: '2026-01-09', status: 'major_outage', uptime: 75 });
    expect(days[0]!.minutes).toEqual({ major_outage: 360, degraded: 720 });
    expect(days[1]).toMatchObject({ status: 'operational', uptime: 100 });
  });

  it('averages over observed time', () => {
    expect(
      averageUptime(
        [
          { status: 'operational', started_at: '2026-01-10T00:00:00.000Z', ended_at: '2026-01-10T09:00:00.000Z' },
          { status: 'partial_outage', started_at: '2026-01-10T09:00:00.000Z', ended_at: null },
        ],
        new Date('2026-01-01T00:00:00.000Z'),
        now,
      ),
    ).toBe(75);
  });
});
