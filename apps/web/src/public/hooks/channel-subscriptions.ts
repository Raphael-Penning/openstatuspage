/**
 * The webhook or SMS subscription of a manage link (JSON:API
 * "channel-subscriptions"). In the browser the token travels in the
 * X-Subscription-Token header; on the server (the route loader of the manage
 * page) the in-process source takes it as the `token` value. The pages post
 * plain forms (FORM_PATHS), with and without JavaScript.
 */
import { deserialize, SUBSCRIPTION_TOKEN_HEADER, type PublicChannelSubscription } from '@openstatuspage/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { GetDocument } from './queries';

const path = (id: string) => `/api/public/channel-subscriptions/${encodeURIComponent(id)}`;

function retry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 1;
}

export function channelSubscriptionQuery(id: string, token: string, get?: GetDocument) {
  return queryOptions({
    queryKey: ['channel-subscription', id] as const,
    queryFn: get
      ? async () => deserialize<PublicChannelSubscription>(await get(path(id), { token }))
      : () => api.get<PublicChannelSubscription>(path(id), undefined, { headers: { [SUBSCRIPTION_TOKEN_HEADER]: token } }),
    retry,
    refetchOnWindowFocus: false,
  });
}

export function useChannelSubscription(id: string, token: string) {
  return useQuery(channelSubscriptionQuery(id, token));
}
