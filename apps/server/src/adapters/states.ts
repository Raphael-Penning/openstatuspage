/**
 * State normalization shared by adapters.
 * Nagios-style systems (Icinga 2, openITCockpit/Naemon) use
 * services: 0 OK, 1 WARNING, 2 CRITICAL, 3 UNKNOWN and
 * hosts:    0 UP, 1 DOWN, 2 UNREACHABLE.
 */
import { CHECK_STATES, type CheckState } from '@openstatuspage/shared';

const SERVICE_BY_NUMBER: readonly CheckState[] = ['ok', 'warning', 'critical', 'unknown'];

const SERVICE_BY_NAME: Record<string, CheckState> = {
  ok: 'ok',
  warning: 'warning',
  warn: 'warning',
  critical: 'critical',
  crit: 'critical',
  unknown: 'unknown',
};

const HOST_BY_NAME: Record<string, CheckState> = {
  up: 'ok',
  ok: 'ok',
  down: 'critical',
  unreachable: 'critical',
};

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value)) return Math.round(Number(value));
  return null;
}

/** Service state from a number (0..3) or a name (OK, WARNING, ...). Anything else is `unknown`. */
export function serviceState(value: unknown): CheckState {
  const n = toInt(value);
  if (n !== null) return SERVICE_BY_NUMBER[n] ?? 'unknown';
  if (typeof value === 'string') return SERVICE_BY_NAME[value.trim().toLowerCase()] ?? 'unknown';
  return 'unknown';
}

/** Host state from a number (0 up, 1 down, 2 unreachable) or a name. Anything else is `unknown`. */
export function hostState(value: unknown): CheckState {
  const n = toInt(value);
  if (n !== null) return n === 0 ? 'ok' : n === 1 || n === 2 ? 'critical' : 'unknown';
  if (typeof value === 'string') return HOST_BY_NAME[value.trim().toLowerCase()] ?? 'unknown';
  return 'unknown';
}

export function isCheckState(value: unknown): value is CheckState {
  return typeof value === 'string' && (CHECK_STATES as readonly string[]).includes(value);
}

/** Converts a unix timestamp (seconds, may be fractional) or a parseable date to ISO-8601, else null. */
export function timestampToIso(value: unknown): string | null {
  if (value == null || value === '') return null;
  let d: Date;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Heuristic: values below 1e11 are seconds, larger ones milliseconds.
    d = new Date(value < 1e11 ? value * 1000 : value);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return timestampToIso(Number(trimmed));
    d = new Date(trimmed);
  } else {
    return null;
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Returns a trimmed non-empty string or null. */
export function str(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
