/**
 * Form model of a check bundle (see BundlesPage). Pure helpers, unit tested.
 */
import type { AdminCheckBundle } from '@openstatuspage/shared';

export interface BundleMemberRow {
  checkId: string;
  sourceId: string;
  /** Text of the votes input. */
  votes: string;
}

export interface BundleFormValues {
  name: string;
  description: string;
  members: BundleMemberRow[];
}

export function bundleToForm(bundle?: AdminCheckBundle): BundleFormValues {
  return {
    name: bundle?.name ?? '',
    description: bundle?.description ?? '',
    members: (bundle?.members ?? []).map((m) => ({ checkId: m.checkId, sourceId: m.sourceId, votes: String(m.votes) })),
  };
}

/** CheckBundleInput payload. Invalid vote inputs become NaN so validation flags them. */
export function bundleFormToPayload(v: BundleFormValues) {
  return {
    name: v.name.trim(),
    description: v.description.trim() || null,
    members: v.members.map((m) => ({
      checkId: m.checkId,
      votes: m.votes.trim() === '' ? Number.NaN : Number(m.votes),
    })),
  };
}

/** Sum of the valid votes (whole numbers >= 1) in the form. */
export function totalVotes(members: readonly Pick<BundleMemberRow, 'votes'>[]): number {
  return members.reduce((sum, m) => {
    const n = Number(m.votes);
    return m.votes.trim() !== '' && Number.isInteger(n) && n > 0 ? sum + n : sum;
  }, 0);
}

/** Votes needed for "down" when every member reports: more than half. */
export function majorityThreshold(total: number): number {
  return Math.floor(total / 2) + 1;
}
