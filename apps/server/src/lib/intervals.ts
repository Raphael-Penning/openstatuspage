/**
 * Half-open time intervals [start, end) in epoch milliseconds. Pure helpers,
 * used by the history import (gap calculation, clipping, merging).
 */

export interface Span {
  start: number;
  end: number;
}

export interface Valued<T> extends Span {
  value: T;
}

/** Sorts and merges overlapping or touching spans. Empty spans are dropped. */
export function unionSpans(spans: readonly Span[]): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

/** `range` minus the union of `covered`: the uncovered parts ("gaps"), sorted. */
export function subtractSpans(range: Span, covered: readonly Span[]): Span[] {
  if (range.end <= range.start) return [];
  const gaps: Span[] = [];
  let cursor = range.start;
  for (const c of unionSpans(covered)) {
    if (c.end <= cursor) continue;
    if (c.start >= range.end) break;
    if (c.start > cursor) gaps.push({ start: cursor, end: Math.min(c.start, range.end) });
    cursor = Math.max(cursor, c.end);
    if (cursor >= range.end) break;
  }
  if (cursor < range.end) gaps.push({ start: cursor, end: range.end });
  return gaps;
}

/** Parts of the valued spans that lie inside `windows` (windows must be sorted and disjoint). */
export function clipToWindows<T>(items: readonly Valued<T>[], windows: readonly Span[]): Valued<T>[] {
  const out: Valued<T>[] = [];
  for (const item of items) {
    for (const w of windows) {
      if (w.start >= item.end) break;
      const start = Math.max(item.start, w.start);
      const end = Math.min(item.end, w.end);
      if (end > start) out.push({ start, end, value: item.value });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Sorts and joins adjacent spans with the same value (touching only, gaps are kept). */
export function mergeAdjacent<T>(items: readonly Valued<T>[]): Valued<T>[] {
  const sorted = items.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Valued<T>[] = [];
  for (const item of sorted) {
    const last = out[out.length - 1];
    if (last && last.value === item.value && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else out.push({ ...item });
  }
  return out;
}

/** Total length of the union of spans in ms. */
export function totalLength(spans: readonly Span[]): number {
  return unionSpans(spans).reduce((sum, s) => sum + (s.end - s.start), 0);
}

/**
 * Turns point events (state changes or samples) into intervals: each event's
 * value holds until the next event, but at most `maxHoldMs` (when given) and
 * never beyond `end`. Events must not be empty-valued; order does not matter.
 */
export function eventsToIntervals<T>(
  events: readonly { at: number; value: T }[],
  end: number,
  maxHoldMs?: number,
): Valued<T>[] {
  const sorted = events.filter((e) => Number.isFinite(e.at)).sort((a, b) => a.at - b.at);
  const out: Valued<T>[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (e.at >= end) break;
    let stop = i + 1 < sorted.length ? Math.min(sorted[i + 1]!.at, end) : end;
    if (maxHoldMs !== undefined) stop = Math.min(stop, e.at + maxHoldMs);
    if (stop > e.at) out.push({ start: e.at, end: stop, value: e.value });
  }
  return mergeAdjacent(out);
}

/** Binary search: the value of the span containing `t`, or undefined (spans sorted, disjoint). */
export function valueAt<T>(items: readonly Valued<T>[], t: number): T | undefined {
  let lo = 0;
  let hi = items.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const it = items[mid]!;
    if (t < it.start) hi = mid - 1;
    else if (t >= it.end) lo = mid + 1;
    else return it.value;
  }
  return undefined;
}
