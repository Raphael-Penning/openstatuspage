/**
 * The email subscription as plain HTML forms (they work without JavaScript; with
 * JavaScript the pages use the JSON:API instead). Same steps, checks and rate
 * limits as routes/subscriptions.ts, on the same subscription flow
 * (services/subscription-flow.ts: the osp_public database functions on a
 * restricted PostgreSQL public role).
 *
 *   POST /subscribe                  email, locale, scope, service…, group…, website → 303 /subscribe?sent=1
 *   POST /subscription/confirm       id, token                                       → 303 manage page (?confirmed=1)
 *   POST /subscription/manage        id, token, locale, scope, service…, group…      → 303 manage page (?saved=1)
 *   POST /subscription/unsubscribe   id, token                                       → 303 /subscription/manage?unsubscribed=1
 *
 * Post/Redirect/Get: success redirects to a page that shows the outcome (a query
 * flag). Invalid input is answered with the page itself (422): the submitted
 * values, an error summary and the field errors, rendered on the server. Wrong
 * or expired links redirect to the page's "invalid link" state (?error=invalid).
 * Without the server-side rendering bundle the answer is a redirect with
 * ?error=<code> instead.
 *
 * `scope` is `all` or `selected`; `group` selects every public service of a
 * group (the group checkbox of the service list), `service` single services.
 */
import {
  FORM_PATHS,
  SubscribeInput,
  SubscriptionPreferencesInput,
  zId,
  type FormIssue,
  type SsrFormState,
} from '@openstatuspage/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import type { DB } from '../db/index.js';
import { HttpError } from '../lib/errors.js';
import { unique } from '../lib/http.js';
import { subscribeAfterAnswer } from '../routes/subscriptions.js';
import type { FormPage } from '../ssr/pages.js';
import { confirm, getManaged, unsubscribe, updateManaged } from '../services/subscription-flow.js';
import { assertPublicServices, subscriptionsAvailable } from '../services/subscriptions.js';
import { field, fieldList, formFields, isCrossSite, rejectCrossSite, seeOther, withQuery, type FormFields } from './http.js';

/** Renders a page answering a form (SsrPages.sendForm); false when it cannot be rendered. */
export type FormPageRenderer = (req: FastifyRequest, reply: FastifyReply, page: FormPage) => Promise<boolean>;

/** The same limits as the JSON:API routes. preHandler: the rate-limited answer still shows what was entered. */
const SUBSCRIBE_LIMIT = { rateLimit: { max: 5, timeWindow: '1 minute', hook: 'preHandler' as const } };
const MANAGE_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute', hook: 'preHandler' as const } };

const MANAGE_PAGE = '/subscription/manage';
const CONFIRM_PAGE = '/subscription/confirm';
const SUBSCRIBE_PAGE = '/subscribe';

/** Fields echoed back into a re-rendered form (never the honeypot). */
const ECHOED = ['email', 'locale', 'scope', 'service', 'group', 'id', 'token'];

function echo(fields: FormFields): SsrFormState['values'] {
  const values: SsrFormState['values'] = {};
  for (const name of ECHOED) {
    const list = fields.get(name);
    if (!list) continue;
    values[name] = name === 'service' || name === 'group' ? list.slice(0, 500) : (list[0] ?? '').slice(0, 1000);
  }
  return values;
}

const issuesOf = (issues: readonly { path: readonly PropertyKey[]; code: string }[]): FormIssue[] =>
  issues.map((i) => ({ path: i.path.map((p) => (typeof p === 'number' ? p : String(p))), code: i.code }));

/** Public services of the selected public groups (the group checkboxes). */
async function servicesOfGroups(db: DB, groupIds: string[]): Promise<string[]> {
  const ids = unique(groupIds.filter((id) => zId.safeParse(id).success)).slice(0, 100);
  if (ids.length === 0) return [];
  const rows = await db
    .selectFrom('services')
    .innerJoin('service_groups', 'service_groups.id', 'services.group_id')
    .select('services.id')
    .where('services.group_id', 'in', ids)
    .where('services.is_public', '=', 1)
    .where('service_groups.is_public', '=', 1)
    .execute();
  return rows.map((r) => r.id);
}

/** The scope fields as the API input: all services, or the checked services and groups. */
async function scopeOf(db: DB, fields: FormFields): Promise<{ allServices: boolean; serviceIds: string[] }> {
  const allServices = field(fields, 'scope') !== 'selected';
  if (allServices) return { allServices, serviceIds: [] };
  const serviceIds = unique([...fieldList(fields, 'service'), ...(await servicesOfGroups(db, fieldList(fields, 'group')))]);
  return { allServices, serviceIds };
}

/** Link parameters of the confirm and manage forms; null when malformed. */
function linkOf(fields: FormFields): { id: string; token: string } | null {
  const id = field(fields, 'id').trim();
  const token = field(fields, 'token').trim();
  if (!zId.safeParse(id).success || token.length < 16 || token.length > 256) return null;
  return { id, token };
}

const isStatus = (err: unknown, status: number) => err instanceof HttpError && err.statusCode === status;

/** Issue for service ids the server rejected (unknown or no longer public). */
const UNKNOWN_SERVICES: FormIssue[] = [{ path: ['serviceIds'], code: 'invalid_value' }];

export function registerSubscriptionForms(scope: FastifyInstance, renderPage: FormPageRenderer): void {
  const ctx: AppContext = scope.ctx;

  /** Answers with the page and the form state; without rendering, a redirect with the error code. */
  async function answerWithPage(req: FastifyRequest, reply: FastifyReply, page: FormPage, error: string) {
    if (await renderPage(req, reply, page)) return reply;
    const [path, query = ''] = page.url.split('?');
    const params = new URLSearchParams(query);
    params.set('error', error);
    return seeOther(reply, `${path}?${params.toString()}`);
  }

  const managePage = (link: { id: string; token: string }, flags: Record<string, string> = {}) =>
    withQuery(MANAGE_PAGE, { id: link.id, token: link.token, ...flags });

  // Rate limited (thrown by @fastify/rate-limit in preHandler): the page with the message and what was entered.
  scope.setErrorHandler(async (err, req, reply) => {
    if ((err as { statusCode?: number }).statusCode !== 429) throw err;
    const fields = formFields(req);
    const path = req.routeOptions.url;
    const link = linkOf(fields);
    const url =
      path === FORM_PATHS.subscribe
        ? SUBSCRIBE_PAGE
        : path === FORM_PATHS.confirm && link
          ? withQuery(CONFIRM_PAGE, link)
          : link
            ? managePage(link)
            : withQuery(MANAGE_PAGE, {});
    return answerWithPage(req, reply, { url, form: { values: echo(fields), error: 'rate_limited' }, status: 429 }, 'rate_limited');
  });

  scope.post(FORM_PATHS.subscribe, { config: SUBSCRIBE_LIMIT }, async (req, reply) => {
    if (isCrossSite(req, ctx.config.PUBLIC_BASE_URL)) return rejectCrossSite(reply);
    // The page itself says that subscriptions are not offered.
    if (!(await subscriptionsAvailable(ctx))) return seeOther(reply, SUBSCRIBE_PAGE);
    const fields = formFields(req);
    const invalid = (issues: FormIssue[]) =>
      answerWithPage(req, reply, { url: SUBSCRIBE_PAGE, form: { values: echo(fields), issues }, status: 422 }, 'invalid');

    const parsed = SubscribeInput.safeParse({
      email: field(fields, 'email').trim(),
      locale: field(fields, 'locale') || undefined,
      ...(await scopeOf(ctx.db, fields)),
      website: field(fields, 'website') || undefined,
    });
    if (!parsed.success) return invalid(issuesOf(parsed.error.issues));
    const sent = withQuery(SUBSCRIBE_PAGE, { sent: '1' });
    // Honeypot filled in (bots): the same answer as a real subscribe, nothing happens.
    if (parsed.data.website) return seeOther(reply, sent);
    let serviceIds: string[];
    try {
      serviceIds = parsed.data.allServices ? [] : await assertPublicServices(ctx.db, parsed.data.serviceIds);
    } catch (err) {
      if (isStatus(err, 400)) return invalid(UNKNOWN_SERVICES);
      throw err;
    }
    subscribeAfterAnswer(ctx, reply, { ...parsed.data, serviceIds });
    return seeOther(reply, sent);
  });

  scope.post(FORM_PATHS.confirm, { config: MANAGE_LIMIT }, async (req, reply) => {
    if (isCrossSite(req, ctx.config.PUBLIC_BASE_URL)) return rejectCrossSite(reply);
    const link = linkOf(formFields(req));
    if (!link) return seeOther(reply, withQuery(CONFIRM_PAGE, { error: 'invalid' }));
    try {
      const { subscription, manageToken } = await confirm(ctx, link.id, link.token);
      return seeOther(reply, managePage({ id: subscription.id, token: manageToken }, { confirmed: '1' }));
    } catch (err) {
      if (isStatus(err, 404)) return seeOther(reply, withQuery(CONFIRM_PAGE, { error: 'invalid' }));
      throw err;
    }
  });

  scope.post(FORM_PATHS.manage, { config: MANAGE_LIMIT }, async (req, reply) => {
    if (isCrossSite(req, ctx.config.PUBLIC_BASE_URL)) return rejectCrossSite(reply);
    const fields = formFields(req);
    const link = linkOf(fields);
    const invalidLink = () => seeOther(reply, withQuery(MANAGE_PAGE, { error: 'invalid' }));
    if (!link) return invalidLink();
    const invalid = (issues: FormIssue[]) =>
      answerWithPage(req, reply, { url: managePage(link), form: { values: echo(fields), issues }, status: 422 }, 'invalid');

    const parsed = SubscriptionPreferencesInput.safeParse({
      locale: field(fields, 'locale') || undefined,
      ...(await scopeOf(ctx.db, fields)),
    });
    try {
      // The link is checked first: a wrong token never learns whether the input was valid.
      await getManaged(ctx, link.id, link.token);
      if (!parsed.success) return invalid(issuesOf(parsed.error.issues));
      await updateManaged(ctx, link.id, link.token, parsed.data);
    } catch (err) {
      if (isStatus(err, 404)) return invalidLink();
      if (isStatus(err, 400)) return invalid(UNKNOWN_SERVICES);
      throw err;
    }
    return seeOther(reply, managePage(link, { saved: '1' }));
  });

  scope.post(FORM_PATHS.unsubscribe, { config: MANAGE_LIMIT }, async (req, reply) => {
    if (isCrossSite(req, ctx.config.PUBLIC_BASE_URL)) return rejectCrossSite(reply);
    const link = linkOf(formFields(req));
    if (!link) return seeOther(reply, withQuery(MANAGE_PAGE, { error: 'invalid' }));
    try {
      await unsubscribe(ctx, link.id, link.token);
    } catch (err) {
      if (isStatus(err, 404)) return seeOther(reply, withQuery(MANAGE_PAGE, { error: 'invalid' }));
      throw err;
    }
    return seeOther(reply, withQuery(MANAGE_PAGE, { unsubscribed: '1' }));
  });
}
