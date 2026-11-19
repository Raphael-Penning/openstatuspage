import { CheckBundleInput } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import { bundleFormToPayload, bundleToForm, majorityThreshold, totalVotes } from './bundle-form';

describe('bundle form', () => {
  it('builds a valid payload', () => {
    const payload = bundleFormToPayload({
      name: '  Website ',
      description: ' ',
      members: [
        { checkId: 'a', sourceId: 's1', votes: '2' },
        { checkId: 'b', sourceId: 's2', votes: '1' },
      ],
    });
    expect(payload).toEqual({
      name: 'Website',
      description: null,
      members: [
        { checkId: 'a', votes: 2 },
        { checkId: 'b', votes: 1 },
      ],
    });
    expect(CheckBundleInput.safeParse(payload).success).toBe(true);
  });

  it('rejects empty, zero and fractional votes', () => {
    for (const votes of ['', '0', '1.5', '-1']) {
      const payload = bundleFormToPayload({ name: 'X', description: '', members: [{ checkId: 'a', sourceId: 's', votes }] });
      const res = CheckBundleInput.safeParse(payload);
      expect(res.success).toBe(false);
      expect(res.error?.issues[0]?.path).toEqual(['members', 0, 'votes']);
    }
  });

  it('starts empty for a new bundle', () => {
    expect(bundleToForm()).toEqual({ name: '', description: '', members: [] });
  });

  it('computes the majority threshold', () => {
    expect(totalVotes([{ votes: '2' }, { votes: '1' }, { votes: '' }, { votes: '0.5' }])).toBe(3);
    expect(majorityThreshold(1)).toBe(1);
    expect(majorityThreshold(2)).toBe(2);
    expect(majorityThreshold(3)).toBe(2);
    expect(majorityThreshold(4)).toBe(3);
  });
});
