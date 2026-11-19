/**
 * Corrected status history: the measured `service_status_history` segments of
 * a service overlaid with retroactive maintenance windows and status
 * corrections. Pure functions, all calculations in UTC milliseconds.
 *
 * The measured data itself is never changed; corrections are applied whenever
 * history or uptime is computed, so they can be edited or deleted at any time.
 *
 * Precedence (later layers replace earlier ones where they overlap):
 *   measured  <  retroactive maintenance  <  corrections (older < newer)
 * i.e. for overlapping corrections the one created last wins.
 */
import type { DailyUptime, HistorySegmentSource, ServiceStatus } from '@openstatuspage/shared';
import { startOfUtcDay, type StatusSegment } from './uptime.js';

const DAY_MS = 86_400_000;

export interface CorrectionLayer {
  kind: 'maintenance' | 'correction';
  id: string;
  status: ServiceStatus;
  start: string;
  /** Exclusive end; null = still running (until now). */
  end: string | null;
  /** Tie breaker within one kind: higher wins (creation time of corrections). */
  order: string;
}

export interface CorrectedSegment extends StatusSegment {
  source: HistorySegmentSource;
  sourceId: string | null;
}

interface Piece {
  status: ServiceStatus;
  start: number;
  end: number;
  /** Measured open segment that still reaches `now`. */
  open: boolean;
  source: HistorySegmentSource;
  sourceId: string | null;
}

const KIND_RANK: Record<CorrectionLayer['kind'], number> = { maintenance: 0, correction: 1 };

/** Sorts layers by precedence, lowest first. */
export function sortLayers(layers: readonly CorrectionLayer[]): CorrectionLayer[] {
  return [...layers].sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      (a.order < b.order ? -1 : a.order > b.order ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Removes [start, end) from every piece (splitting pieces that span it). */
function cut(pieces: Piece[], start: number, end: number): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    if (p.end <= start || p.start >= end) {
      out.push(p);
      continue;
    }
    if (p.start < start) out.push({ ...p, end: start, open: false });
    if (p.end > end) out.push({ ...p, start: end });
  }
  return out;
}

/**
 * Overlays `segments` (one service, any order) with `layers`.
 * Everything is clipped at `now`; corrections may also cover time without
 * measured data. Adjacent pieces with the same status and origin are merged.
 */
export function applyCorrections(
  segments: readonly StatusSegment[],
  layers: readonly CorrectionLayer[],
  now: Date,
): CorrectedSegment[] {
  const nowMs = now.getTime();
  let pieces: Piece[] = [];
  for (const s of segments) {
    const start = new Date(s.started_at).getTime();
    const end = s.ended_at ? Math.min(new Date(s.ended_at).getTime(), nowMs) : nowMs;
    if (end <= start) continue;
    pieces.push({
      status: s.status,
      start,
      end,
      open: s.ended_at === null,
      source: 'measured',
      sourceId: null,
    });
  }

  for (const layer of sortLayers(layers)) {
    const start = new Date(layer.start).getTime();
    const end = layer.end ? Math.min(new Date(layer.end).getTime(), nowMs) : nowMs;
    if (end <= start) continue;
    pieces = cut(pieces, start, end);
    pieces.push({ status: layer.status, start, end, open: false, source: layer.kind, sourceId: layer.id });
  }

  pieces.sort((a, b) => a.start - b.start);
  const merged: Piece[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.end === p.start && last.status === p.status && last.source === p.source && last.sourceId === p.sourceId) {
      last.end = p.end;
      last.open = p.open;
    } else {
      merged.push({ ...p });
    }
  }

  return merged.map((p) => ({
    status: p.status,
    started_at: new Date(p.start).toISOString(),
    ended_at: p.open ? null : new Date(p.end).toISOString(),
    source: p.source,
    sourceId: p.sourceId,
  }));
}

export interface PublicCorrectionMark {
  start: string;
  end: string;
  note: string | null;
}

/**
 * Adds `corrected: true` and the public notes to every day bucket that a public
 * correction overlaps (up to `now`). Returns new objects, the input is not changed.
 */
export function markCorrectedDays(
  days: readonly DailyUptime[],
  marks: readonly PublicCorrectionMark[],
  now: Date,
): DailyUptime[] {
  if (marks.length === 0) return [...days];
  const nowMs = now.getTime();
  const parsed = marks.map((m) => ({
    start: new Date(m.start).getTime(),
    end: Math.min(new Date(m.end).getTime(), nowMs),
    note: m.note?.trim() || null,
  }));
  return days.map((day) => {
    const dayStart = new Date(`${day.date}T00:00:00.000Z`).getTime();
    const dayEnd = Math.min(dayStart + DAY_MS, nowMs);
    const hits = parsed.filter((m) => m.start < dayEnd && m.end > dayStart);
    if (hits.length === 0) return day;
    const notes = [...new Set(hits.map((h) => h.note).filter((n): n is string => n !== null))];
    return { ...day, corrected: true, correctionNotes: notes };
  });
}

/** UTC day start of the oldest of `days` buckets ending today. */
export function rangeStart(days: number, now: Date): Date {
  return new Date(startOfUtcDay(now).getTime() - (days - 1) * DAY_MS);
}
