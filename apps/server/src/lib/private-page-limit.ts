/**
 * The one budget of private page requests per client: page views (/p/<token>,
 * app.ts) and requests of the private page API (routes/public.ts), GET and HEAD
 * alike, take from the same bucket, so PRIVATE_PAGE_REQUESTS_PER_MINUTE is the
 * total a client gets against guessing tokens.
 *
 * Clients are keyed like the other rate limits (@fastify/rate-limit): an IPv4
 * address, or the /64 network of an IPv6 address, so one IPv6 host cannot pick
 * a fresh address per request.
 */
import { normalizeIP } from '@fastify/rate-limit';
import { PRIVATE_PAGE_REQUESTS_PER_MINUTE } from '@openstatuspage/shared';
import { TokenBucketLimiter } from '../adapters/rate-limit.js';
import type { AppContext } from '../context.js';
import { RATE_LIMIT_KEYS } from '../routes/index.js';

const limiters = new WeakMap<AppContext, TokenBucketLimiter>();

/** The client a request counts against: the IPv4 address or the IPv6 /64 network. */
export function rateLimitClient(ip: string): string {
  return normalizeIP(ip);
}

/** Takes one private page request of this client: 0 when allowed, otherwise the seconds until the next one. */
export function takePrivatePageRequest(ctx: AppContext, ip: string): number {
  let limiter = limiters.get(ctx);
  if (!limiter) {
    limiter = new TokenBucketLimiter({
      capacity: PRIVATE_PAGE_REQUESTS_PER_MINUTE,
      refillPerSecond: PRIVATE_PAGE_REQUESTS_PER_MINUTE / 60,
      maxKeys: RATE_LIMIT_KEYS,
    });
    limiters.set(ctx, limiter);
  }
  return limiter.take(rateLimitClient(ip));
}
