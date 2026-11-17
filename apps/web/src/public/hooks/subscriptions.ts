/**
 * Queries and mutations of the public email subscription API. The manage
 * token travels in the X-Subscription-Token header, never in API URLs.
 */
import {
  SUBSCRIPTION_TOKEN_HEADER,
  type PublicSubscription,
  type SubscribeInput,
  type SubscriptionPreferencesInput,
} from '@openstatuspage/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';

const BASE = '/api/public/subscriptions';

export interface ConfirmResult {
  subscription: PublicSubscription;
  manageToken: string;
}

const path = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const withToken = (token: string) => ({ headers: { [SUBSCRIPTION_TOKEN_HEADER]: token } });

/** Never retry client errors (invalid link, validation, rate limit). */
function retry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 1;
}

export const subscriptionKey = (id: string) => ['subscription', id] as const;

export function useSubscribe() {
  return useMutation({ mutationFn: (body: SubscribeInput) => api.post<{ ok: true }>(BASE, body) });
}

/**
 * Confirms a subscription once per link. A query (not a mutation) so a
 * re-render or StrictMode does not post twice; the endpoint is idempotent anyway.
 */
export function useConfirmSubscription(id: string, token: string) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['subscription-confirm', id, token],
    queryFn: async () => {
      const result = await api.post<ConfirmResult>(`${path(id)}/confirm`, { token });
      queryClient.setQueryData(subscriptionKey(id), result.subscription);
      return result;
    },
    retry,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useSubscription(id: string, token: string) {
  return useQuery({
    queryKey: subscriptionKey(id),
    queryFn: () => api.get<PublicSubscription>(path(id), undefined, withToken(token)),
    retry,
    refetchOnWindowFocus: false,
  });
}

export function useUpdateSubscription(id: string, token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SubscriptionPreferencesInput) => api.put<PublicSubscription>(path(id), body, withToken(token)),
    onSuccess: (saved) => queryClient.setQueryData(subscriptionKey(id), saved),
  });
}

/** Deletes the subscriber completely (the page shows its own "unsubscribed" state afterwards). */
export function useDeleteSubscription(id: string, token: string) {
  return useMutation({ mutationFn: () => api.delete(path(id), withToken(token)) });
}
