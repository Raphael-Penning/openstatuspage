/** Helpers for manual ordering (sortOrder + up/down buttons). */

interface Sortable {
  id: string;
  name: string;
  sortOrder: number;
}

export const bySortOrder = (a: Sortable, b: Sortable) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/** Moves the item at `index` by `delta` and returns the new id order (unchanged when out of range). */
export function moveId(ids: readonly string[], index: number, delta: number): string[] {
  const target = index + delta;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}

/** Items grouped by `groupId` in group order; items without a known group are returned separately. */
export function groupByParent<G extends Sortable, T extends Sortable & { groupId: string | null }>(items: T[], groups: G[]) {
  const sortedGroups = [...groups].sort(bySortOrder);
  const known = new Set(sortedGroups.map((g) => g.id));
  return {
    groups: sortedGroups.map((group) => ({ group, items: items.filter((s) => s.groupId === group.id).sort(bySortOrder) })),
    ungrouped: items.filter((s) => !s.groupId || !known.has(s.groupId)).sort(bySortOrder),
  };
}

/** sortOrder for a new item appended at the end of `siblings`. */
export function nextSortOrder(siblings: { sortOrder: number }[]): number {
  return siblings.reduce((max, s) => Math.max(max, s.sortOrder + 1), 0);
}
