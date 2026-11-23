/**
 * Webhook and SMS subscriptions as plain HTML forms (they work without
 * JavaScript). Same steps, checks and rate limits as the JSON:API
 * (routes/channel-subscriptions.ts).
 *
 *   POST /subscribe/webhook                kind, url, locale, scope, service…, group…, website → 303 /subscription/verify?ref=…&channel=webhook
 *   POST /subscribe/sms                    phone, locale, scope, service…, group…, website   → 303 /subscription/verify?ref=…&channel=sms
 *   POST /subscription/verify              ref, code, channel → 303 /subscription/channel?id=…&token=…&confirmed=1
 *   POST /subscription/channel             id, token, locale, scope, service…, group…       → 303 manage page (?saved=1)
 *   POST /subscription/channel/unsubscribe id, token                                        → 303 /subscription/channel?unsubscribed=1
 *
 * Invalid input is answered with the page itself (422, the values and the
 * errors), like the email forms; a wrong code too (the code page with its error).
 */
import { ChannelPreferencesInput, ChannelSubscribeInput, FORM_PATHS, type FormIssue, type SsrFormState } from '@openstatuspage/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { HttpError } from '../lib/errors.js';
import { acceptChannelSubscription } from '../routes/channel-subscriptions.js';
import { subscribeRateLimit } from '../routes/subscriptions.js';
import {
  confirmChannel,
  referenceOf,
  getChannelSubscription,
  unsubscribeChannel,
  updateChannelSubscription,
} from '../services/channels/subscriptions.js';
import { assertPublicServices } from '../services/subscriptions.js';
import type { FormPage } from '../ssr/pages.js';
import { field, formFields, isCrossSite, rejectCrossSite, seeOther, withQuery, type FormFields } from './http.js';
import { isStatus, issuesOf, scopeOf, type FormPageRenderer } from './subscriptions.js';

const MANAGE_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute', hook: 'preHandler' as const } };
const VERIFY_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute', hook: 'preHandler' as const } };

const VERIFY_PAGE = '/subscription/verify';
const MANAGE_PAGE = '/subscription/channel';

/** Fields echoed back into a re-rendered form (never the honeypot or the code). */
const ECHOED = ['kind', 'url', 'phone', 'locale', 'scope', 'service', 'group', 'id', 'token', 'ref', 'channel'];

function echo(fields: FormFields): SsrFormState['values'] {
  const values: SsrFormState['values'] = {};
  for (const name of ECHOED) {
    const list = fields.get(name);
    if (!list) continue;
    values[name] = name === 'service' || name === 'group' ? list.slice(0, 500) : (list[0] ?? '').slice(0, 2048);
  }
  return values;
}

/** Field issues of a 400 thrown by the subscription flow (url, phone, services). */
function issuesOfError(err: HttpError): FormIssue[] {
  const list = Array.isArray(err.issues) ? (err.issues as { path?: unknown; code?: unknown }[]) : [];
  const issues = list
    .filter((i) => Array.isArray(i.path) && typeof i.code === 'string')
    .map((i) => ({ path: (i.path as unknown[]).map((p) => (typeof p === 'number' ? p : String(p))), code: i.code as string }));
  // assertPublicServices: unknown or hidden services.
  return issues.length > 0 ? issues : [{ path: ['serviceIds'], code: 'invalid_value' }];
}

function linkOf(fields: FormFields): { id: string; token: string } | null {
  const id = field(fields, 'id').trim();
  const token = field(fields, 'token').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id) || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  return { id, token };
}

const channelOf = (fields: FormFields): 'webhook' | 'sms' => (field(fields, 'channel') === 'sms' ? 'sms' : 'webhook');

export function registerChannelSubscriptionForms(scope: FastifyInstance, renderPage: FormPageRenderer): void {
  const ctx: AppContext = scope.ctx;

  async function answerWithPage(req: FastifyRequest, reply: FastifyReply, page: FormPage, error: string) {
    if (await renderPage(req, reply, page)) return reply;
    const [path, query = ''] = page.url.split('?');
    const params = new URLSearchParams(query);
    params.set('error', error);
    return seeOther(reply, `${path}?${params.toString()}`);
  }

  const managePage = (link: { id: string; token: string }, flags: Record<string, string> = {}) =>
    withQuery(MANAGE_PAGE, { id: link.id, token: link.token, ...flags });
  const verifyPage = (ref: string, channel: string) => withQuery(VERIFY_PAGE, { ref, channel });

  // Rate limited: the page with the message and what was entered.
  scope.setErrorHandler(async (err, req, reply) => {
    if ((err as { statusCode?: number }).statusCode !== 429) throw err;
    const fields = formFields(req);
    const path = req.routeOptions.url;
    const link = linkOf(fields);
    const url =
      path === FORM_PATHS.subscribeWebhook || path === FORM_PATHS.subscribeSms
        ? path
        : path === FORM_PATHS.verify
          ? verifyPage(field(fields, 'ref').slice(0, 128), channelOf(fields))
          : link
            ? managePage(link)
            : MANAGE_PAGE;
    return answerWithPage(req, reply, { url, form: { values: echo(fields), error: 'rate_limited' }, status: 429 }, 'rate_limited');
  });

  const subscribe = (channel: 'webhook' | 'sms', path: string) =>
    scope.post(path, { preHandler: subscribeRateLimit(scope) }, async (req, reply) => {
      if (isCrossSite(req, ctx.config.PUBLIC_BASE_URL)) return rejectCrossSite(reply);
      const fields = formFields(req);
      const invalid = (issues: FormIssue[]) =>
        answerWithPage(req, reply, { url: path, form: { values: echo(fields), issues }, status: 422 }, 'invalid');
      const parsed = ChannelSubscribeInput.safeParse({
        channel,
        ...(channel === 'webhook'
          ? { webhookKind: field(fields, 'kind') || undefined, url: field(fields, 'url').trim() || undefined }
          : { phone: field(fields, 'phone').trim() || undefined }),
        locale: field(fields, 'locale') || undefined,
        ...(await scopeOf(ctx.db, fields)),
        website: field(fields, 'website') || undefined,
      });
      if (!parsed.success) return invalid(issuesOf(parsed.error.issues));
      // Honeypot (bots): the same answer, nothing happens.
      if (parsed.data.website) return seeOther(reply, verifyPage(referenceOf(ctx.config, null), channel));
      try {
        const reference = await acceptChannelSubscription(ctx, reply, parsed.data);
        return seeOther(reply, verifyPage(reference, channel));
      } catch (err) {
        // Not offered (any more): the page says so.
        if (isStatus(err, 404)) return seeOther(reply, path);
        if (isStatus(err, 400)) return invalid(issuesOfError(err as HttpError));
        throw err;
      }
    });
  subscribe('webhook', FORM_PATHS.subscribeWebhook);
  subscribe('sms', FORM_PATHS.subscribeSms);

  scope.post(FORM_PATHS.verify, { config: VERIFY_LIMIT }, async (req, reply) => {
    if (isCrossSite(req, ctx.config.PUBLIC_BASE_URL)) return rejectCrossSite(reply);
    const fields = formFields(req);
    const ref = field(fields, 'ref').trim();
    const code = field(fields, 'code').replace(/\s/g, '');
    const channel = channelOf(fields);
    const wrong = (issueCode: string) =>
      answerWithPage(
        req,
        reply,
        { url: verifyPage(ref.slice(0, 128), channel), form: { values: echo(fields), issues: [{ path: ['code'], code: issueCode }] }, status: 422 },
        'code',
      );
    if (!/^\d{6}$/.test(code)) return wrong('invalid_format');
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(ref)) return wrong('invalid_value');
    try {
      const { subscription, manageToken } = await confirmChannel(ctx, ref, code);
      return seeOther(reply, managePage({ id: subscription.id, token: manageToken }, { confirmed: '1' }));
    } catch (err) {
      if (isStatus(err, 404)) return wrong('invalid_value');
      throw err;
    }
  });

  scope.post(FORM_PATHS.channelManage, { config: MANAGE_LIMIT }, async (req, reply) => {
    if (isCrossSite(req, ctx.config.PUBLIC_BASE_URL)) return rejectCrossSite(reply);
    const fields = formFields(req);
    const link = linkOf(fields);
    const invalidLink = () => seeOther(reply, withQuery(MANAGE_PAGE, { error: 'invalid' }));
    if (!link) return invalidLink();
    const invalid = (issues: FormIssue[]) =>
      answerWithPage(req, reply, { url: managePage(link), form: { values: echo(fields), issues }, status: 422 }, 'invalid');
    const parsed = ChannelPreferencesInput.safeParse({ locale: field(fields, 'locale') || undefined, ...(await scopeOf(ctx.db, fields)) });
    try {
      // The link is checked first: a wrong token never learns whether the input was valid.
      await getChannelSubscription(ctx, link.id, link.token);
      if (!parsed.success) return invalid(issuesOf(parsed.error.issues));
      const serviceIds = parsed.data.allServices ? [] : await assertPublicServices(ctx.db, parsed.data.serviceIds);
      await updateChannelSubscription(ctx, link.id, link.token, { ...parsed.data, serviceIds });
    } catch (err) {
      if (isStatus(err, 404)) return invalidLink();
      if (isStatus(err, 400)) return invalid([{ path: ['serviceIds'], code: 'invalid_value' }]);
      throw err;
    }
    return seeOther(reply, managePage(link, { saved: '1' }));
  });

  scope.post(FORM_PATHS.channelUnsubscribe, { config: MANAGE_LIMIT }, async (req, reply) => {
    if (isCrossSite(req, ctx.config.PUBLIC_BASE_URL)) return rejectCrossSite(reply);
    const link = linkOf(formFields(req));
    if (!link) return seeOther(reply, withQuery(MANAGE_PAGE, { error: 'invalid' }));
    try {
      await unsubscribeChannel(ctx, link.id, link.token);
    } catch (err) {
      if (isStatus(err, 404)) return seeOther(reply, withQuery(MANAGE_PAGE, { error: 'invalid' }));
      throw err;
    }
    return seeOther(reply, withQuery(MANAGE_PAGE, { unsubscribed: '1' }));
  });
}

