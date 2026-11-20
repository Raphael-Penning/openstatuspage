/**
 * /api/public/subscriptions: email subscriptions with double opt-in (no login), JSON:API.
 *
 *   POST   /api/public/subscriptions                 subscribe (always 202, work runs after the answer, rate limited)
 *   POST   /api/public/subscriptions/:id/confirm     confirm with the emailed token
 *   GET    /api/public/subscriptions/:id             \
 *   PATCH  /api/public/subscriptions/:id              } manage, token in X-Subscription-Token
 *   DELETE /api/public/subscriptions/:id             /
 *   POST   /api/public/subscriptions/:id/unsubscribe?token=   RFC 8058 one-click (native form body)
 *   GET    /api/public/subscriptions/:id/unsubscribe?token=   browser redirect to the manage page (not JSON:API)
 *
 * Subscriptions are "subscriptions" resources with a `services` relationship
 * (`serviceIds` on the plain object). The confirm response also carries the
 * `manageToken` attribute for the following manage requests.
 *
 * Unknown ids and wrong tokens get the same 404. Managing and unsubscribing keep
 * working when subscriptions are disabled later; only subscribing needs them enabled.
 */
import {
  SUBSCRIPTION_TOKEN_HEADER,
  SubscribeInput,
  SubscriptionConfirmInput,
  SubscriptionPreferencesInput,
} from '@openstatuspage/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound } from '../lib/errors.js';
import { IdParams, parse } from '../lib/http.js';
import { document, metaDocument, noContent } from '../lib/jsonapi.js';
import { useJsonApi } from '../plugins/jsonapi.js';
import { AUTH_TYPES, subscriptionResource } from '../serializers/auth-users.js';
import { confirm, getManaged, startSubscription, unsubscribe, updateManaged } from '../services/subscription-flow.js';
import { assertPublicServices, subscriberLinks, subscriptionsAvailable } from '../services/subscriptions.js';

const TokenQuery = z.object({ token: z.string().max(256).optional() });
/** Relationships of a subscription request document. */
const SUBSCRIPTION_RELATIONSHIPS = { services: AUTH_TYPES.service };

function headerToken(req: FastifyRequest): string | undefined {
  const value = req.headers[SUBSCRIPTION_TOKEN_HEADER];
  return typeof value === 'string' && value.length <= 256 ? value : undefined;
}

export async function registerSubscriptionRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    const { ctx } = app;

    // Responses carry personal data and tokens: never cache them.
    scope.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });

    // RFC 8058 one-click requests post "List-Unsubscribe=One-Click" as a form; the body is not needed.
    scope.addContentTypeParser(
      ['application/x-www-form-urlencoded', 'multipart/form-data'],
      { parseAs: 'string', bodyLimit: 4096 },
      (_req, body, done) => done(null, body),
    );

    const manageRoute = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
    // Tokens in the query string: keep these routes out of info-level request logs.
    const queryTokenRoute = { ...manageRoute, logLevel: 'warn' as const };

    // A browser opening the List-Unsubscribe URL lands on the manage page (GET never deletes).
    scope.get('/api/public/subscriptions/:id/unsubscribe', queryTokenRoute, async (req, reply) => {
      const { id } = parse(IdParams, req.params);
      const { token } = parse(TokenQuery, req.query);
      // Checks the token (404 otherwise); valid means it is the subscriber's manage token.
      const sub = await getManaged(ctx, id, token);
      // The manage page reads the token from the URL fragment.
      const links = subscriberLinks(ctx.config, sub.id, { confirm: '', manage: token! });
      return reply.redirect(links.unsubscribeUrl, 303);
    });

    await scope.register(async (api) => {
      useJsonApi(api);
      registerSubscriptionApi(api, manageRoute, queryTokenRoute);
    });
  });
}

type ManageRoute = { config: { rateLimit: { max: number; timeWindow: string } } };

/** The JSON:API routes (everything except the browser redirect). */
function registerSubscriptionApi(
  scope: FastifyInstance,
  manageRoute: ManageRoute,
  queryTokenRoute: ManageRoute & { logLevel: 'warn' },
): void {
  const { ctx } = scope;
  /** The answer to every subscribe request, whatever happens afterwards. */
  const accepted = () => metaDocument({ accepted: true });

  scope.post(
    '/api/public/subscriptions',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' }, jsonapi: { type: AUTH_TYPES.subscription, relationships: SUBSCRIPTION_RELATIONSHIPS } } },
    async (req, reply) => {
      if (!(await subscriptionsAvailable(ctx))) throw notFound('Subscriptions');
      const input = parse(SubscribeInput, req.body);
      // Honeypot filled in (bots): answer like a successful subscribe, but create and send nothing.
      if (input.website) return reply.status(202).send(accepted());
      // Checked before answering (400 on unknown or hidden services); does not look at subscribers.
      const serviceIds = input.allServices ? [] : await assertPublicServices(ctx.db, input.serviceIds);
      // What happens next, and how long it takes, depends on whether the address is
      // new, pending or confirmed. It runs once the answer has been sent, so neither
      // the answer nor its timing reveals whether an address is subscribed.
      const answered = new Promise<void>((resolve) => reply.raw.once('close', () => resolve()));
      ctx.worker.runDetached('subscribe', async () => {
        await answered;
        await startSubscription(ctx, { ...input, serviceIds });
      });
      return reply.status(202).send(accepted());
    },
  );

  // Action: `{ data: { type: "subscriptions", id, attributes: { token } } }` → the subscription with `manageToken`.
  scope.post('/api/public/subscriptions/:id/confirm', { config: { ...manageRoute.config, jsonapi: { allowId: true } } }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const { token } = parse(SubscriptionConfirmInput, req.body);
    const { subscription, manageToken } = await confirm(ctx, id, token);
    return document(subscriptionResource(subscription, { manageToken }));
  });

  scope.get('/api/public/subscriptions/:id', manageRoute, async (req) => {
    const { id } = parse(IdParams, req.params);
    return document(subscriptionResource(await getManaged(ctx, id, headerToken(req))));
  });

  scope.patch(
    '/api/public/subscriptions/:id',
    { config: { ...manageRoute.config, jsonapi: { type: AUTH_TYPES.subscription, relationships: SUBSCRIPTION_RELATIONSHIPS } } },
    async (req) => {
      const { id } = parse(IdParams, req.params);
      const token = headerToken(req);
      // Partial update: what is left out keeps its value.
      const current = await getManaged(ctx, id, token);
      const input = parse(SubscriptionPreferencesInput, {
        locale: current.locale,
        allServices: current.allServices,
        serviceIds: current.serviceIds,
        ...(req.body as object),
      });
      return document(subscriptionResource(await updateManaged(ctx, id, token, input)));
    },
  );

  scope.delete('/api/public/subscriptions/:id', manageRoute, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    await unsubscribe(ctx, id, headerToken(req));
    return noContent(reply);
  });

  // RFC 8058 one-click: mail clients post a form body ("List-Unsubscribe=One-Click"), not JSON:API.
  scope.post(
    '/api/public/subscriptions/:id/unsubscribe',
    { ...queryTokenRoute, config: { ...queryTokenRoute.config, jsonapi: { requestBody: 'native' } } },
    async (req, reply) => {
      const { id } = parse(IdParams, req.params);
      const { token } = parse(TokenQuery, req.query);
      await unsubscribe(ctx, id, token);
      return noContent(reply);
    },
  );
}
