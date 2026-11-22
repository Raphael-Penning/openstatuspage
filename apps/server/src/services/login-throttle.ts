/**
 * Failed password logins per account (normalised e-mail), in memory per instance.
 *
 * The per-client rate limit of the login route keys on the client address, which
 * an attacker holding many addresses (or spoofing X-Forwarded-For behind an
 * over-trusting proxy setup) can rotate. This throttle bounds online guessing
 * against one account whatever the source: after FREE_FAILURES failures each
 * further failure blocks the account for an exponentially growing delay, capped
 * at MAX_DELAY_MS. The cap keeps the price of a deliberate lockout low: a
 * legitimate user waits at most that long before the next attempt.
 *
 * An attempt is counted as a failure synchronously, before the password is
 * checked (`attempt`), and a valid password then clears the count
 * (`recordSuccess`). Counting after the asynchronous password check instead would
 * let a burst of concurrent attempts all pass the check before the first failure
 * is recorded.
 *
 * Unknown e-mails are counted the same way, so the throttle reveals nothing
 * about which accounts exist.
 */
export interface LoginThrottleOptions {
  /** Failures without any delay. */
  freeFailures?: number;
  /** Delay after the first failure past freeFailures; doubles with each further one. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Failures are forgotten this long after the last one. */
  resetAfterMs?: number;
  /** Accounts tracked at most (oldest entries go first). */
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  failures: number;
  lastFailure: number;
  blockedUntil: number;
}

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly freeFailures: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly resetAfterMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: LoginThrottleOptions = {}) {
    this.freeFailures = options.freeFailures ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    this.resetAfterMs = options.resetAfterMs ?? 15 * 60_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  static key(email: string): string {
    return email.trim().toLowerCase();
  }

  private current(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.lastFailure >= this.resetAfterMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Milliseconds until the next attempt for this account is allowed (0: now). */
  retryAfterMs(email: string): number {
    const entry = this.current(LoginThrottle.key(email));
    return entry ? Math.max(0, entry.blockedUntil - this.now()) : 0;
  }

  /**
   * Checks and reserves one attempt in a single synchronous step: returns the
   * milliseconds to wait while the account is blocked (nothing recorded), or 0
   * after counting the attempt as a failure. Call recordSuccess when the password
   * turns out valid.
   */
  attempt(email: string): number {
    const retryAfterMs = this.retryAfterMs(email);
    if (retryAfterMs > 0) return retryAfterMs;
    this.recordFailure(email);
    return 0;
  }

  recordFailure(email: string): void {
    const key = LoginThrottle.key(email);
    const now = this.now();
    const entry = this.current(key) ?? { failures: 0, lastFailure: now, blockedUntil: 0 };
    entry.failures += 1;
    entry.lastFailure = now;
    const over = entry.failures - this.freeFailures;
    if (over > 0) {
      const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(over - 1, 30));
      entry.blockedUntil = now + delay;
    }
    // Re-insert so the Map order is by last failure; evict the oldest beyond the bound.
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  recordSuccess(email: string): void {
    this.entries.delete(LoginThrottle.key(email));
  }
}
