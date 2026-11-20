/**
 * Constants of the email subscriptions. Kept out of schemas.ts (zod), so the
 * public pages can use them without loading zod.
 */

/** Languages of subscription emails. */
export const SUBSCRIPTION_LOCALES = ['en', 'de'] as const;
export type SubscriptionLocale = (typeof SUBSCRIPTION_LOCALES)[number];

/** Header carrying the manage token for GET/PUT/DELETE /api/public/subscriptions/:id. */
export const SUBSCRIPTION_TOKEN_HEADER = 'x-subscription-token';
