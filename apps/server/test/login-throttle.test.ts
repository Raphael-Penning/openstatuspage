import { describe, expect, it } from 'vitest';
import { LoginThrottle } from '../src/services/login-throttle.js';

describe('LoginThrottle', () => {
  const make = (options: ConstructorParameters<typeof LoginThrottle>[0] = {}) => {
    const clock = { now: 1_000_000 };
    const throttle = new LoginThrottle({ now: () => clock.now, ...options });
    return { throttle, clock };
  };

  it('backs off exponentially after the free failures, capped at one minute', () => {
    const { throttle, clock } = make();
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      clock.now += 120_000; // wait out any block, well within the reset window
      throttle.recordFailure('Jane@Example.com ');
      delays.push(throttle.retryAfterMs('jane@example.com'));
    }
    expect(delays).toEqual([0, 0, 0, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });

  it('forgets failures after a success or the reset window', () => {
    const { throttle, clock } = make();
    for (let i = 0; i < 5; i++) throttle.recordFailure('a@example.com');
    expect(throttle.retryAfterMs('a@example.com')).toBeGreaterThan(0);
    throttle.recordSuccess('A@example.com');
    expect(throttle.retryAfterMs('a@example.com')).toBe(0);

    for (let i = 0; i < 5; i++) throttle.recordFailure('a@example.com');
    clock.now += 15 * 60_000;
    expect(throttle.retryAfterMs('a@example.com')).toBe(0);
    throttle.recordFailure('a@example.com');
    expect(throttle.retryAfterMs('a@example.com')).toBe(0); // counting starts over
  });

  it('keeps a bounded number of accounts', () => {
    const { throttle } = make({ maxEntries: 2, freeFailures: 0 });
    throttle.recordFailure('a@example.com');
    throttle.recordFailure('b@example.com');
    throttle.recordFailure('c@example.com');
    expect(throttle.retryAfterMs('a@example.com')).toBe(0);
    expect(throttle.retryAfterMs('c@example.com')).toBeGreaterThan(0);
  });
});
