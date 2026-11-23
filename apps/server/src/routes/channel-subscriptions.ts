/**
 * /api/public/channel-subscriptions: webhook and SMS subscriptions of visitors
 * (JSON:API, no login). services/channels/subscriptions.ts describes the flow.
 *
 *   POST   /api/public/channel-subscriptions           subscribe → always 202 with meta { accepted, reference }
 *                                                       (the work runs after the answer; rate limited
 *                                                       together with every other way to subscribe)
 *   POST   /api/public/channel-subscriptions/confirm   { reference, code } → the subscription with `manageToken`
 *   GET    /api/public/channel-subscriptions/:id       \
 *   PATCH  /api/public/channel-subscriptions/:id        } manage, token in X-Subscription-Token
 *   DELETE /api/public/channel-subscriptions/:id       /
 *   GET    /s/:id/:token                               short manage link of the messages → 303 manage page
 *
 * 404 when the channel is not offered (subscribe) and for wrong codes, ids or
 * tokens (all the same). 400 for invalid input, with the field (url, phone).
 */
import {
  ChannelConfirmInput,
  ChannelPreferencesInput,
  ChannelSubscribeInput,
  SUBSCRIPTION_TOKEN_HEADER,
  type PublicChannelSubscription,
} from '@openstatuspage/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { IdParams, parse } from '../lib/http.js';
import { document, metaDocument, noContent, resource, toMany } from '../lib/jsonapi.js';
import { useJsonApi } from '../plugins/jsonapi.js';
import {
  channelManagePage,
  checkTarget,
  confirmChannel,
  getChannelSubscription,
  referenceOf,
  startChannelSubscription,
  unsubscribeChannel,
  updateChannelSubscription,
  type CheckedTarget,
} from '../services/channels/subscriptions.js';
import { channelOptions } from '../services/channels/settings.js';
import { assertPublicServices } from '../services/subscriptions.js';
import { subscribeRateLimit } from './subscriptions.js';

export const CHANNEL_SUBSCRIPTION_TYPE = 'channel-subscriptions';
const RELATIONSHIPS = { services: 'services' };

/** Confirm attempts per client and minute (the code also has its own attempt limit). */
export const CONFIRM_REQUESTS_PER_MINUTE = 10;

export function channelSubscriptionResource(sub: PublicChannelSubscription, extra: { manageToken?: string } = {}) {
  const { serviceIds, ...attributes } = sub;
  return resource(
    CHANNEL_SUBSCRIPTION_TYPE,
    sub.id,
    { ...attributes, ...extra },
    {
      relationships: { services: toMany('services', serviceIds) },
      links: { self: `/api/public/channel-subscriptions/${encodeURIComponent(sub.id)}` },
    },
  );
}

function headerToken(req: FastifyRequest): string | undefined {
  const value = req.headers[SUBSCRIPTION_TOKEN_HEADER];
  return typeof value === 'string' && value.length <= 256 ? value : undefined;
}

/**
 * Checks a subscribe request (channel offered, target, public services) and starts
 * it once the answer is sent. Returns the reference for the code form. Used by
 * the JSON:API and the forms (forms/channel-subscriptions.ts). Throws 400/404.
 */
export async function acceptChannelSubscription(
  ctx: AppContext,
  reply: FastifyReply,
  input: ChannelSubscribeInput,
): Promise<string> {
  const options = await channelOptions(ctx.db, ctx.config);
  const checked: CheckedTarget = checkTarget(input, options);
  const serviceIds = input.allServices ? [] : await assertPublicServices(ctx.db, input.serviceIds);
  // After the answer: neither it nor its timing tells whether the target is known.
  const answered = new Promise<void>((resolve) => reply.raw.once('close', () => resolve()));
  ctx.worker.runDetached('channel-subscribe', async () => {
    await answered;
    await startChannelSubscription(ctx, { ...input, serviceIds }, checked);
  });
  return referenceOf(ctx.config, checked);
}

export async function registerChannelSubscriptionRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    const { ctx } = app;
    scope.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });
    const manageRoute = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

    // The short link of SMS and webhook messages: checks the token, then the manage page.
    const ShortParams = z.object({ id: z.string().min(1).max(64), token: z.string().min(1).max(64) });
    scope.get('/s/:id/:token', { ...manageRoute, logLevel: 'warn' }, async (req, reply) => {
      const { id, token } = parse(ShortParams, req.params);
      try {
        await getChannelSubscription(ctx, id, token);
      } catch {
        return reply.header('referrer-policy', 'no-referrer').redirect('/subscription/channel?error=invalid', 303);
      }
      return reply.header('referrer-policy', 'no-referrer').redirect(channelManagePage(ctx.config, id, token), 303);
    });

    await scope.register(async (api) => {
      useJsonApi(api);
      const subscribeLimit = subscribeRateLimit(app);

      api.post(
        '/api/public/channel-subscriptions',
        { onRequest: subscribeLimit, config: { jsonapi: { type: CHANNEL_SUBSCRIPTION_TYPE, relationships: RELATIONSHIPS } } },
        async (req, reply) => {
          const input = parse(ChannelSubscribeInput, req.body);
          // Honeypot (bots): the same answer, with a reference that matches nothing.
          if (input.website) return reply.status(202).send(metaDocument({ accepted: true, reference: referenceOf(ctx.config, null) }));
          const reference = await acceptChannelSubscription(ctx, reply, input);
          return reply.status(202).send(metaDocument({ accepted: true, reference }));
        },
      );

      api.post(
        '/api/public/channel-subscriptions/confirm',
        { config: { rateLimit: { max: CONFIRM_REQUESTS_PER_MINUTE, timeWindow: '1 minute' }, jsonapi: { type: CHANNEL_SUBSCRIPTION_TYPE } } },
        async (req) => {
          const { reference, code } = parse(ChannelConfirmInput, req.body);
          const { subscription, manageToken } = await confirmChannel(ctx, reference, code);
          return document(channelSubscriptionResource(subscription, { manageToken }));
        },
      );

      api.get('/api/public/channel-subscriptions/:id', manageRoute, async (req) => {
        const { id } = parse(IdParams, req.params);
        return document(channelSubscriptionResource(await getChannelSubscription(ctx, id, headerToken(req))));
      });

      api.patch(
        '/api/public/channel-subscriptions/:id',
        { config: { ...manageRoute.config, jsonapi: { type: CHANNEL_SUBSCRIPTION_TYPE, relationships: RELATIONSHIPS } } },
        async (req) => {
          const { id } = parse(IdParams, req.params);
          const token = headerToken(req);
          const current = await getChannelSubscription(ctx, id, token);
          const input = parse(ChannelPreferencesInput, {
            locale: current.locale,
            allServices: current.allServices,
            serviceIds: current.serviceIds,
            ...(req.body as object),
          });
          const serviceIds = input.allServices ? [] : await assertPublicServices(ctx.db, input.serviceIds);
          return document(channelSubscriptionResource(await updateChannelSubscription(ctx, id, token, { ...input, serviceIds })));
        },
      );

      api.delete('/api/public/channel-subscriptions/:id', manageRoute, async (req, reply) => {
        const { id } = parse(IdParams, req.params);
        await unsubscribeChannel(ctx, id, headerToken(req));
        return noContent(reply);
      });
    });
  });
}
