import type { CheckState } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import {
  bundleOutput,
  evaluateBundle,
  MAX_CLOCK_SKEW_MS,
  memberReason,
  MIN_STALE_MS,
  staleAfterMs,
  type MemberSourceInfo,
  type VotingMember,
} from '../src/services/bundle-rules.js';

const m = (state: CheckState, votes = 1, reporting = true): VotingMember => ({ state, votes, reporting });

describe('evaluateBundle', () => {
  it('is unknown without members', () => {
    expect(evaluateBundle([])).toEqual({
      state: 'unknown',
      totalVotes: 0,
      reportingVotes: 0,
      criticalVotes: 0,
      warningVotes: 0,
      okVotes: 0,
    });
  });

  it('is unknown when no member reports', () => {
    const r = evaluateBundle([m('critical', 2, false), m('ok', 1, false), m('unknown', 3)]);
    expect(r.state).toBe('unknown');
    expect(r.totalVotes).toBe(6);
    expect(r.reportingVotes).toBe(0);
  });

  it('needs more than half of the votes: one of two down is not down', () => {
    expect(evaluateBundle([m('critical'), m('ok')]).state).toBe('ok');
  });

  it('treats exactly 50 % as no majority', () => {
    expect(evaluateBundle([m('critical', 2), m('ok', 1), m('ok', 1)]).state).toBe('ok');
    expect(evaluateBundle([m('critical', 3), m('ok', 3)]).state).toBe('ok');
  });

  it('is critical with a majority of critical votes', () => {
    expect(evaluateBundle([m('critical'), m('critical'), m('ok')]).state).toBe('critical');
    expect(evaluateBundle([m('critical'), m('critical')]).state).toBe('critical');
    expect(evaluateBundle([m('critical')]).state).toBe('critical');
  });

  it('weights members by their votes', () => {
    // One heavy node outvotes two light ones ...
    expect(evaluateBundle([m('critical', 3), m('ok', 1), m('ok', 1)]).state).toBe('critical');
    // ... but not when the others together hold as much.
    expect(evaluateBundle([m('critical', 2), m('ok', 1), m('ok', 1)]).state).toBe('ok');
    // Two light nodes cannot outvote a heavy one.
    expect(evaluateBundle([m('ok', 3), m('critical', 1), m('critical', 1)]).state).toBe('ok');
  });

  it('is warning when critical and warning votes together have the majority', () => {
    expect(evaluateBundle([m('critical'), m('warning'), m('ok')]).state).toBe('warning');
    expect(evaluateBundle([m('warning'), m('warning'), m('ok')]).state).toBe('warning');
    expect(evaluateBundle([m('warning'), m('ok')]).state).toBe('ok');
    expect(evaluateBundle([m('warning', 2), m('critical', 2), m('ok', 4)]).state).toBe('ok');
    expect(evaluateBundle([m('warning', 2), m('critical', 2), m('ok', 3)]).state).toBe('warning');
  });

  it('prefers critical over warning when critical alone has the majority', () => {
    expect(evaluateBundle([m('critical', 3), m('warning', 1), m('ok', 1)]).state).toBe('critical');
  });

  it('counts only reporting members as the base', () => {
    // 1 down of 1 reporting (two silent nodes) = down.
    const r = evaluateBundle([m('critical', 1), m('ok', 1, false), m('ok', 1, false)]);
    expect(r).toMatchObject({ state: 'critical', totalVotes: 3, reportingVotes: 1, criticalVotes: 1, okVotes: 0 });
    // A silent node that last said "critical" does not count either.
    expect(evaluateBundle([m('critical', 5, false), m('ok', 1)]).state).toBe('ok');
  });

  it('never counts unknown states as reporting', () => {
    const r = evaluateBundle([m('unknown', 5, true), m('critical', 1)]);
    expect(r).toMatchObject({ state: 'critical', reportingVotes: 1 });
  });

  it('sums the votes per state', () => {
    expect(evaluateBundle([m('critical', 2), m('warning', 3), m('ok', 4), m('ok', 1, false)])).toEqual({
      state: 'warning',
      totalVotes: 10,
      reportingVotes: 9,
      criticalVotes: 2,
      warningVotes: 3,
      okVotes: 4,
    });
  });
});

describe('memberReason', () => {
  const now = Date.parse('2026-01-10T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  // lastPollAt null: these cases are judged by the age of the result alone.
  const pull: MemberSourceInfo = { enabled: true, pollable: true, pollIntervalSeconds: 60, lastPollOk: true, lastPollAt: null };
  const push: MemberSourceInfo = { enabled: true, pollable: false, pollIntervalSeconds: 60, lastPollOk: null, lastPollAt: null };

  it('reports with a fresh result', () => {
    expect(memberReason({ state: 'critical', lastCheckAt: ago(60_000) }, pull, now)).toBe('reporting');
    expect(memberReason({ state: 'ok', lastCheckAt: ago(0) }, push, now)).toBe('reporting');
  });

  it('does not report when the source is disabled', () => {
    expect(memberReason({ state: 'ok', lastCheckAt: ago(0) }, { ...pull, enabled: false }, now)).toBe('source_disabled');
  });

  it('does not report when the last poll failed', () => {
    expect(memberReason({ state: 'ok', lastCheckAt: ago(0) }, { ...pull, lastPollOk: false }, now)).toBe('poll_failed');
    // Never polled yet: judged by the result age only.
    expect(memberReason({ state: 'ok', lastCheckAt: ago(0) }, { ...pull, lastPollOk: null }, now)).toBe('reporting');
  });

  it('does not report unknown states or missing results', () => {
    expect(memberReason({ state: 'unknown', lastCheckAt: ago(0) }, pull, now)).toBe('state_unknown');
    expect(memberReason({ state: 'ok', lastCheckAt: null }, pull, now)).toBe('never_checked');
    expect(memberReason({ state: 'ok', lastCheckAt: 'garbage' }, pull, now)).toBe('never_checked');
  });

  it('uses 3 poll intervals, but at least 5 minutes, for pull sources', () => {
    expect(staleAfterMs({ pollable: true, pollIntervalSeconds: 60 }, 0)).toBe(MIN_STALE_MS);
    expect(staleAfterMs({ pollable: true, pollIntervalSeconds: 300 }, 0)).toBe(900_000);
    expect(memberReason({ state: 'ok', lastCheckAt: ago(MIN_STALE_MS) }, pull, now)).toBe('reporting');
    expect(memberReason({ state: 'ok', lastCheckAt: ago(MIN_STALE_MS + 1) }, pull, now)).toBe('stale');
    const slow = { ...pull, pollIntervalSeconds: 600 };
    expect(memberReason({ state: 'ok', lastCheckAt: ago(29 * 60_000) }, slow, now)).toBe('reporting');
    expect(memberReason({ state: 'ok', lastCheckAt: ago(31 * 60_000) }, slow, now)).toBe('stale');
  });

  it('keeps a pull member reporting while its source polls successfully, however old the check run is', () => {
    // Icinga 2 style: the check ran 5-6 minutes ago (5-minute check interval), the poll a minute ago.
    const icinga = { ...pull, lastPollAt: ago(60_000) };
    expect(memberReason({ state: 'ok', lastCheckAt: ago(5 * 60_000 + 30_000) }, icinga, now)).toBe('reporting');
    expect(memberReason({ state: 'critical', lastCheckAt: ago(6 * 60_000) }, icinga, now)).toBe('reporting');
    expect(memberReason({ state: 'ok', lastCheckAt: ago(2 * 60 * 60_000) }, icinga, now)).toBe('reporting');
  });

  it('falls back to the result age when the last successful poll is itself stale', () => {
    const silent = { ...pull, lastPollAt: ago(MIN_STALE_MS + 1) };
    expect(memberReason({ state: 'ok', lastCheckAt: ago(6 * 60_000) }, silent, now)).toBe('stale');
    expect(memberReason({ state: 'ok', lastCheckAt: ago(60_000) }, silent, now)).toBe('reporting');
    expect(memberReason({ state: 'ok', lastCheckAt: ago(6 * 60_000) }, { ...pull, lastPollAt: 'garbage' }, now)).toBe('stale');
  });

  it('does not let a fresh poll override a failed poll, an unknown state or a disabled source', () => {
    const polled = { ...pull, lastPollAt: ago(0) };
    expect(memberReason({ state: 'ok', lastCheckAt: ago(0) }, { ...polled, lastPollOk: false }, now)).toBe('poll_failed');
    expect(memberReason({ state: 'unknown', lastCheckAt: ago(0) }, polled, now)).toBe('state_unknown');
    expect(memberReason({ state: 'ok', lastCheckAt: ago(0) }, { ...polled, enabled: false }, now)).toBe('source_disabled');
  });

  it('ignores poll times for push-only sources', () => {
    expect(memberReason({ state: 'ok', lastCheckAt: ago(61 * 60_000) }, { ...push, lastPollOk: true, lastPollAt: ago(0) }, now)).toBe(
      'stale',
    );
  });

  it('uses the push staleness for push-only sources', () => {
    expect(memberReason({ state: 'ok', lastCheckAt: ago(59 * 60_000) }, push, now)).toBe('reporting');
    expect(memberReason({ state: 'ok', lastCheckAt: ago(61 * 60_000) }, push, now)).toBe('stale');
    expect(memberReason({ state: 'ok', lastCheckAt: ago(11 * 60_000) }, push, now, 10 * 60_000)).toBe('stale');
  });

  it('never counts a result from the future beyond clock skew as fresh', () => {
    const ahead = (ms: number) => new Date(now + ms).toISOString();
    expect(memberReason({ state: 'ok', lastCheckAt: ahead(MAX_CLOCK_SKEW_MS) }, push, now)).toBe('reporting');
    expect(memberReason({ state: 'ok', lastCheckAt: ahead(MAX_CLOCK_SKEW_MS + 1) }, push, now)).toBe('stale');
    expect(memberReason({ state: 'ok', lastCheckAt: '2099-01-01T00:00:00.000Z' }, push, now)).toBe('stale');
    expect(memberReason({ state: 'ok', lastCheckAt: '2099-01-01T00:00:00.000Z' }, pull, now)).toBe('stale');
  });

  it('checks the source before the result', () => {
    expect(memberReason({ state: 'unknown', lastCheckAt: null }, { ...pull, enabled: false }, now)).toBe('source_disabled');
  });
});

describe('bundleOutput', () => {
  it('summarizes the vote without member names', () => {
    expect(bundleOutput(evaluateBundle([m('critical'), m('critical'), m('ok')]))).toBe(
      'critical: 2 of 3 reporting votes down, 0 warning',
    );
    expect(bundleOutput(evaluateBundle([m('critical'), m('ok'), m('ok', 2, false)]))).toBe(
      'ok: 1 of 2 reporting votes down, 0 warning; 2 of 4 votes not reporting',
    );
    expect(bundleOutput(evaluateBundle([m('ok', 1, false)]))).toBe('unknown: none of 1 votes reporting');
    expect(bundleOutput(evaluateBundle([]))).toBe('No members');
  });
});
