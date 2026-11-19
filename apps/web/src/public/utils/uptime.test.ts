import type { DailyUptime } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import {
  averageUptime,
  barDaysForWidth,
  dayIndexAt,
  dayPattern,
  formatPercent,
  lastDays,
  outageMinutes,
  statusMinutes,
  tooltipAlign,
} from './uptime';

function day(date: string, uptime: number | null, minutes: DailyUptime['minutes'] = {}): DailyUptime {
  return { date, status: uptime === null ? null : 'operational', uptime, minutes };
}

describe('barDaysForWidth', () => {
  it('shows 30/60/90 days depending on the viewport width', () => {
    expect(barDaysForWidth(375, 90)).toBe(30);
    expect(barDaysForWidth(800, 90)).toBe(60);
    expect(barDaysForWidth(1280, 90)).toBe(90);
  });

  it('never exceeds the available days', () => {
    expect(barDaysForWidth(1280, 14)).toBe(14);
    expect(barDaysForWidth(375, 7)).toBe(7);
  });

  it('uses a custom desktop range', () => {
    expect(barDaysForWidth(1600, 180, 180)).toBe(180);
  });
});

describe('lastDays', () => {
  const days = [day('2026-01-01', 100), day('2026-01-02', 99), day('2026-01-03', 98)];

  it('returns the newest buckets in original order', () => {
    expect(lastDays(days, 2).map((d) => d.date)).toEqual(['2026-01-02', '2026-01-03']);
  });

  it('handles counts larger than the input and zero', () => {
    expect(lastDays(days, 10)).toHaveLength(3);
    expect(lastDays(days, 0)).toEqual([]);
  });
});

describe('averageUptime', () => {
  it('ignores buckets without data', () => {
    expect(averageUptime([day('a', null), day('b', 100), day('c', 99)])).toBe(99.5);
  });

  it('returns null without data', () => {
    expect(averageUptime([day('a', null)])).toBeNull();
    expect(averageUptime([])).toBeNull();
  });

  it('rounds to two decimals', () => {
    expect(averageUptime([day('a', 100), day('b', 100), day('c', 99.99)])).toBe(100);
    expect(averageUptime([day('a', 99.123), day('b', 99.123)])).toBe(99.12);
  });
});

describe('minutes', () => {
  const d = day('2026-01-01', 95, { degraded: 30, partial_outage: 20, major_outage: 52, maintenance: 0 });

  it('counts partial and major outages as downtime', () => {
    expect(outageMinutes(d)).toBe(72);
    expect(outageMinutes(day('x', 100))).toBe(0);
  });

  it('lists non-zero statuses worst first', () => {
    expect(statusMinutes(d)).toEqual([
      { status: 'major_outage', minutes: 52 },
      { status: 'partial_outage', minutes: 20 },
      { status: 'degraded', minutes: 30 },
    ]);
  });
});

describe('formatPercent', () => {
  it('formats locale aware', () => {
    expect(formatPercent(99.95, 'en')).toBe('99.95%');
    expect(formatPercent(100, 'en')).toBe('100%');
    expect(formatPercent(99.5, 'de')).toMatch(/^99,5\s%$/);
  });
});

describe('tooltipAlign', () => {
  it('keeps tooltips near the edges inside the bar', () => {
    expect(tooltipAlign(0, 90)).toBe('start');
    expect(tooltipAlign(45, 90)).toBe('center');
    expect(tooltipAlign(89, 90)).toBe('end');
    expect(tooltipAlign(0, 1)).toBe('center');
  });
});

describe('dayIndexAt', () => {
  it('maps the pointer position to the day under it', () => {
    expect(dayIndexAt(0, 900, 90)).toBe(0);
    expect(dayIndexAt(9.9, 900, 90)).toBe(0);
    expect(dayIndexAt(10, 900, 90)).toBe(1);
    expect(dayIndexAt(899, 900, 90)).toBe(89);
  });

  it('clamps positions outside the bar and handles empty bars', () => {
    expect(dayIndexAt(-5, 900, 90)).toBe(0);
    expect(dayIndexAt(1200, 900, 90)).toBe(89);
    expect(dayIndexAt(10, 0, 90)).toBe(0);
    expect(dayIndexAt(10, 900, 0)).toBe(0);
  });
});

describe('dayPattern', () => {
  it('marks days by pattern as well as by color', () => {
    expect(dayPattern('operational')).toBe('solid');
    expect(dayPattern('maintenance')).toBe('striped');
    expect(dayPattern('degraded')).toBe('striped');
    expect(dayPattern('major_outage')).toBe('striped');
    expect(dayPattern(null)).toBe('outline');
  });
});
