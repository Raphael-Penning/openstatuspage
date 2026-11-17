/**
 * Pure helpers of the email subscription pages: the grouped service checklist,
 * locale mapping, link parameters and mapping of validation issues.
 */
import {
  SUBSCRIPTION_LOCALES,
  type PublicService,
  type PublicServiceGroup,
  type SubscriptionLocale,
} from '@openstatuspage/shared';

export interface ServiceSection {
  /** Group id, or null for the services without a group. */
  id: string | null;
  /** Group name, or null for the services without a group. */
  name: string | null;
  services: { id: string; name: string }[];
}

/** Groups in display order followed by the ungrouped services. Empty sections are dropped. */
export function serviceSections(groups: PublicServiceGroup[], ungrouped: PublicService[]): ServiceSection[] {
  const pick = (s: PublicService) => ({ id: s.id, name: s.name });
  const sections: ServiceSection[] = groups.map((g) => ({ id: g.id, name: g.name, services: g.services.map(pick) }));
  sections.push({ id: null, name: null, services: ungrouped.map(pick) });
  return sections.filter((s) => s.services.length > 0);
}

/** All service ids of the sections. */
export function sectionServiceIds(sections: ServiceSection[]): string[] {
  return sections.flatMap((s) => s.services.map((x) => x.id));
}

export type SelectionState = 'all' | 'some' | 'none';

/** How many of `ids` are selected: all, some or none (an empty `ids` counts as none). */
export function selectionState(selected: readonly string[], ids: readonly string[]): SelectionState {
  if (ids.length === 0) return 'none';
  const set = new Set(selected);
  const count = ids.filter((id) => set.has(id)).length;
  if (count === 0) return 'none';
  return count === ids.length ? 'all' : 'some';
}

/** Selects (`on`) or deselects all `ids`, keeping the order of the existing selection without duplicates. */
export function setSelected(selected: readonly string[], ids: readonly string[], on: boolean): string[] {
  if (!on) {
    const remove = new Set(ids);
    return selected.filter((id) => !remove.has(id));
  }
  const out = [...new Set(selected)];
  const present = new Set(out);
  for (const id of ids) {
    if (!present.has(id)) {
      out.push(id);
      present.add(id);
    }
  }
  return out;
}

/** Keeps only ids that are still offered (services may have been removed or hidden since subscribing). */
export function knownServiceIds(selected: readonly string[], sections: ServiceSection[]): string[] {
  const known = new Set(sectionServiceIds(sections));
  return selected.filter((id) => known.has(id));
}

/** Maps a UI language ("de", "de-AT", "en-US") to a supported subscription locale, defaulting to English. */
export function toSubscriptionLocale(language: string | null | undefined): SubscriptionLocale {
  const base = (language ?? '').slice(0, 2).toLowerCase();
  return (SUBSCRIPTION_LOCALES as readonly string[]).includes(base) ? (base as SubscriptionLocale) : 'en';
}

/** Reads a parameter of a URL fragment ("#token=…&x=…"), percent-decoded; null when absent or malformed. */
export function hashParam(hash: string, name: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    if (key !== name) continue;
    try {
      // decodeURIComponent keeps "+" literal (base64 tokens), unlike URLSearchParams.
      return decodeURIComponent(eq === -1 ? '' : part.slice(eq + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export interface LinkParams {
  id: string;
  token: string;
}

/**
 * Reads `id` and `token` of a confirmation or manage link; null when one is
 * missing or blank. The id comes from the query, the token from the URL
 * fragment (`#token=…`, never sent to the server, proxies or logs). A token in
 * the query is still accepted as a fallback for older links.
 */
export function linkParams(params: URLSearchParams, hash = ''): LinkParams | null {
  const id = params.get('id')?.trim();
  const token = hashParam(hash, 'token')?.trim() || params.get('token')?.trim();
  return id && token ? { id, token } : null;
}

/** Path of the manage page for a subscription; the token goes into the fragment. */
export function managePath(id: string, token: string, options: { unsubscribe?: boolean } = {}): string {
  const query = new URLSearchParams({ id });
  if (options.unsubscribe) query.set('unsubscribe', '1');
  return `/subscription/manage?${query.toString()}#token=${encodeURIComponent(token)}`;
}

/** Form fields of the subscription forms that can carry an error. */
export type SubscriptionField = 'email' | 'serviceIds' | 'form';

/** Error message keys (public namespace) per field. */
export type SubscriptionErrors = Partial<Record<SubscriptionField, string>>;

interface IssueLike {
  code?: string;
  path?: readonly PropertyKey[];
}

/**
 * Maps zod issues (client-side safeParse or a server 400 response) to message
 * keys. Issues the user cannot fix in a field (e.g. the honeypot) become a
 * form-level error.
 */
export function subscriptionErrors(issues: unknown): SubscriptionErrors {
  const out: SubscriptionErrors = {};
  if (!Array.isArray(issues)) return { form: 'subscription.errors.invalid' };
  for (const raw of issues as IssueLike[]) {
    const field = String(raw?.path?.[0] ?? '');
    if (field === 'email') {
      out.email ??= 'subscription.errors.email';
    } else if (field === 'serviceIds') {
      const missing = raw.code === 'custom' || raw.code === 'too_small';
      out.serviceIds ??= missing ? 'subscription.errors.services' : 'subscription.errors.servicesInvalid';
    } else {
      out.form ??= 'subscription.errors.invalid';
    }
  }
  return Object.keys(out).length > 0 ? out : { form: 'subscription.errors.invalid' };
}
