/**
 * Pure rules for check bundles (weighted voting). No I/O, unit tested.
 *
 * A bundle groups checks that watch the same target from several places
 * (e.g. Uptime Kuma instances in different data centres). Every member has a
 * number of votes. Only members that currently report take part; the bundle
 * is down only when MORE than half of the reporting votes say so:
 *
 *   critical  if critical votes            > 50 % of reporting votes
 *   warning   else if critical + warning   > 50 % of reporting votes
 *   ok        otherwise
 *   unknown   when no member reports
 *
 * Exactly 50 % is not a majority.
 */
import type { BundleMemberReason, BundleVoteSummary, CheckState } from '@openstatuspage/shared';

/**
 * A pull source counts as reporting while its last successful poll is at most
 * this many poll intervals old; without a recent successful poll, the age of
 * the check result decides ...
 */
export const STALE_POLL_INTERVALS = 3;
/** ... but at least this long. */
export const MIN_STALE_MS = 5 * 60_000;
/**
 * How far a result time may lie ahead of the server clock (clock skew between
 * the monitoring system and this server). Ingest caps later times at the
 * server clock; a stored time further in the future never counts as fresh.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
/** Default for push-only sources (no poll interval): BUNDLE_PUSH_STALE_SECONDS. */
export const DEFAULT_PUSH_STALE_SECONDS = 60 * 60;

export interface MemberSourceInfo {
  enabled: boolean;
  /** True for sources the server polls (icinga2, uptimekuma, openitcockpit). */
  pollable: boolean;
  pollIntervalSeconds: number;
  /** Outcome of the last poll, null when never polled. */
  lastPollOk: boolean | null;
  /** Time of the last poll (ISO), null when never polled. */
  lastPollAt: string | null;
}

export interface MemberCheckInfo {
  state: CheckState;
  lastCheckAt: string | null;
}

/** How long a result of this source stays valid. */
export function staleAfterMs(source: Pick<MemberSourceInfo, 'pollable' | 'pollIntervalSeconds'>, pushStaleMs: number): number {
  if (!source.pollable) return pushStaleMs;
  return Math.max(STALE_POLL_INTERVALS * source.pollIntervalSeconds * 1000, MIN_STALE_MS);
}

/** Decides whether a member takes part in the vote, and why not. */
export function memberReason(
  check: MemberCheckInfo,
  source: MemberSourceInfo,
  now: number,
  pushStaleMs: number = DEFAULT_PUSH_STALE_SECONDS * 1000,
): BundleMemberReason {
  if (!source.enabled) return 'source_disabled';
  if (source.pollable && source.lastPollOk === false) return 'poll_failed';
  if (check.state === 'unknown') return 'state_unknown';
  if (!check.lastCheckAt) return 'never_checked';
  const at = Date.parse(check.lastCheckAt);
  if (!Number.isFinite(at)) return 'never_checked';
  const limit = staleAfterMs(source, pushStaleMs);
  // A recent successful poll proves that the node reports and that the value is
  // current, even when the monitoring system ran the check itself a while ago
  // (Icinga 2 / openITCockpit report the time of the check, which with a
  // 5-minute check interval regularly ages past the window between two runs).
  if (source.pollable && source.lastPollOk === true && source.lastPollAt) {
    const polledAt = Date.parse(source.lastPollAt);
    if (Number.isFinite(polledAt) && now - polledAt <= limit) return 'reporting';
  }
  // A result from the future (beyond clock skew) would otherwise stay fresh for as
  // long as the producer chose; it never proves that the member still reports.
  if (now - at > limit || at - now > MAX_CLOCK_SKEW_MS) return 'stale';
  return 'reporting';
}

export interface VotingMember {
  votes: number;
  state: CheckState;
  reporting: boolean;
}

/** Weighted majority vote over the reporting members. */
export function evaluateBundle(members: readonly VotingMember[]): BundleVoteSummary {
  const summary: BundleVoteSummary = {
    state: 'unknown',
    totalVotes: 0,
    reportingVotes: 0,
    criticalVotes: 0,
    warningVotes: 0,
    okVotes: 0,
  };
  for (const m of members) {
    const votes = Math.max(0, Math.floor(m.votes));
    summary.totalVotes += votes;
    // Unknown states never report (see memberReason); guard anyway.
    if (!m.reporting || m.state === 'unknown') continue;
    summary.reportingVotes += votes;
    if (m.state === 'critical') summary.criticalVotes += votes;
    else if (m.state === 'warning') summary.warningVotes += votes;
    else summary.okVotes += votes;
  }
  const base = summary.reportingVotes;
  if (base === 0) summary.state = 'unknown';
  else if (summary.criticalVotes * 2 > base) summary.state = 'critical';
  else if ((summary.criticalVotes + summary.warningVotes) * 2 > base) summary.state = 'warning';
  else summary.state = 'ok';
  return summary;
}

/**
 * Short internal output of the bundle check, e.g.
 * "critical: 2 of 3 reporting votes down, 0 warning; 1 of 4 votes not reporting".
 * Contains no member names (outputs are internal anyway, never public).
 */
export function bundleOutput(summary: BundleVoteSummary): string {
  if (summary.totalVotes === 0) return 'No members';
  const notReporting = summary.totalVotes - summary.reportingVotes;
  if (summary.reportingVotes === 0) return `unknown: none of ${summary.totalVotes} votes reporting`;
  let text =
    `${summary.state}: ${summary.criticalVotes} of ${summary.reportingVotes} reporting votes down, ` +
    `${summary.warningVotes} warning`;
  if (notReporting > 0) text += `; ${notReporting} of ${summary.totalVotes} votes not reporting`;
  return text;
}
