/**
 * Pure helpers of the subscribers page.
 */
import { SubscriberListQuery, type AdminSubscriber } from '@openstatuspage/shared';

export type SubscriberStatusFilter = SubscriberListQuery['status'];

/** Reads page, status and search of the subscriber list from the URL; invalid values fall back to the defaults. */
export function subscriberQueryFromParams(params: URLSearchParams, pageSize: number): SubscriberListQuery {
  const pick = (key: string) => params.get(key)?.trim() || undefined;
  const parse = (raw: Record<string, unknown>) => SubscriberListQuery.safeParse({ ...raw, pageSize });
  const full = parse({ page: pick('page'), status: pick('status'), q: pick('q') });
  if (full.success) return full.data;
  // Keep the valid parts (e.g. a search with an unknown status).
  const page = parse({ page: pick('page') });
  const status = parse({ status: pick('status') });
  const q = parse({ q: pick('q') });
  return {
    page: page.success ? page.data.page : 1,
    pageSize,
    status: status.success ? status.data.status : 'all',
    q: q.success ? q.data.q : undefined,
  };
}

/** URL parameters for a subscriber list query (defaults are omitted). */
export function subscriberParams(query: Pick<SubscriberListQuery, 'page' | 'status' | 'q'>): Record<string, string> {
  const out: Record<string, string> = {};
  if (query.status !== 'all') out.status = query.status;
  if (query.q) out.q = query.q;
  if (query.page > 1) out.page = String(query.page);
  return out;
}

/**
 * Page to jump to when the requested page lies past the end of the list (e.g.
 * after deleting the last subscriber of the last page, or an outdated link):
 * the last page with entries. Null when the page is fine.
 */
export function pageAfterEnd(data: { items: readonly unknown[]; total: number; page: number; pageSize: number }): number | null {
  if (data.items.length > 0 || data.total <= 0 || data.page <= 1) return null;
  const last = Math.max(1, Math.ceil(data.total / data.pageSize));
  // Always move backwards, so an inconsistent response cannot cause a loop.
  return Math.min(last, data.page - 1);
}

/** "All updates" or the names of the selected services. */
export function subscriberScope(subscriber: Pick<AdminSubscriber, 'allServices' | 'services'>, allLabel: string): string {
  if (subscriber.allServices) return allLabel;
  return subscriber.services.map((s) => s.name).join(', ') || '–';
}
