/**
 * Error mapping of the webhook and SMS subscription forms (answers of the
 * server's form handlers, see apps/server/src/forms/channel-subscriptions.ts).
 */
import type { SsrFormState } from '@openstatuspage/shared';

export type ChannelField = 'kind' | 'url' | 'phone' | 'code' | 'serviceIds' | 'form';
export type ChannelErrors = Partial<Record<ChannelField, string>>;

interface IssueLike {
  code?: string;
  path?: readonly PropertyKey[];
}

/** Message keys (public namespace) of the issues of a form answer. */
export function channelErrors(issues: unknown): ChannelErrors {
  const out: ChannelErrors = {};
  if (!Array.isArray(issues)) return { form: 'subscription.errors.invalid' };
  for (const raw of issues as IssueLike[]) {
    const field = String(raw?.path?.[0] ?? '');
    if (field === 'url') {
      out.url ??=
        raw.code === 'webhook_host' ? 'channels.errors.urlHost' : raw.code === 'webhook_insecure' ? 'channels.errors.urlInsecure' : 'channels.errors.url';
    } else if (field === 'webhookKind') {
      out.kind ??= 'channels.errors.kind';
    } else if (field === 'phone') {
      out.phone ??= raw.code === 'phone_country' ? 'channels.errors.phoneCountry' : 'channels.errors.phone';
    } else if (field === 'code') {
      out.code ??= raw.code === 'invalid_format' ? 'channels.errors.codeFormat' : 'channels.errors.code';
    } else if (field === 'serviceIds') {
      const missing = raw.code === 'custom' || raw.code === 'too_small';
      out.serviceIds ??= missing ? 'subscription.errors.services' : 'subscription.errors.servicesInvalid';
    } else {
      out.form ??= 'subscription.errors.invalid';
    }
  }
  return Object.keys(out).length > 0 ? out : { form: 'subscription.errors.invalid' };
}

/** Errors of a form the server answered: its issues, or the code of the answer or of `?error=`. */
export function channelFormErrors(form: SsrFormState | null, queryError: string | null): ChannelErrors {
  if (form?.issues?.length) return channelErrors(form.issues);
  const code = form?.error ?? queryError;
  if (code === 'rate_limited') return { form: 'subscription.errors.rateLimited' };
  if (code === 'code') return { code: 'channels.errors.code' };
  if (code === 'invalid') return { form: 'subscription.errors.invalid' };
  return {};
}

/** Path of the manage page of a webhook or SMS subscription. */
export function channelManagePath(id: string, token: string): string {
  return `/subscription/channel?${new URLSearchParams({ id, token }).toString()}`;
}
