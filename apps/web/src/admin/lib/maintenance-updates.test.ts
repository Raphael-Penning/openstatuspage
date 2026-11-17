import { describe, expect, it } from 'vitest';
import { postUpdateDefaults, transitionDefaults } from './maintenance-updates';

describe('postUpdateDefaults', () => {
  it('starts from the stored notify flag', () => {
    expect(postUpdateDefaults({ status: 'scheduled', notify: true })).toEqual({ status: 'scheduled', message: '', notify: true });
    expect(postUpdateDefaults({ status: 'in_progress', notify: false })).toEqual({
      status: 'in_progress',
      message: '',
      notify: false,
    });
  });
});

describe('transitionDefaults', () => {
  it('pre-fills the message and starts from the stored notify flag', () => {
    expect(transitionDefaults({ notify: false }, 'Maintenance started.')).toEqual({ message: 'Maintenance started.', notify: false });
    expect(transitionDefaults({ notify: true }, 'Maintenance completed.')).toEqual({ message: 'Maintenance completed.', notify: true });
  });
});
