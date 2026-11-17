/**
 * Tiny in-memory token bucket, one bucket per key (e.g. monitoring source).
 * Good enough for a single instance; with several replicas each one limits on its own.
 */
export interface TokenBucketOptions {
  /** Bucket size = requests allowed in a burst. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
  /** Maximum number of tracked keys; idle full buckets are evicted first. */
  maxKeys?: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(private readonly options: TokenBucketOptions) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  /** Consumes one token. Returns 0 when allowed, otherwise the seconds until the next token. */
  take(key: string): number {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.evict(now);
      bucket = { tokens: this.options.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    } else {
      this.refill(bucket, now);
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - bucket.tokens) / this.options.refillPerSecond));
  }

  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }

  private refill(bucket: Bucket, now: number): void {
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.options.capacity, bucket.tokens + elapsed * this.options.refillPerSecond);
    bucket.updatedAt = now;
  }

  private evict(now: number): void {
    for (const [key, bucket] of this.buckets) {
      this.refill(bucket, now);
      if (bucket.tokens >= this.options.capacity) this.buckets.delete(key);
    }
    // Still full: drop the oldest entry.
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
  }
}
