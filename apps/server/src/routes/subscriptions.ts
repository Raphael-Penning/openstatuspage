/**
 * /api/public/subscriptions: email subscriptions with double opt-in (no login).
 *
 *   POST   /api/public/subscriptions                 subscribe (always 202, work runs after the answer, rate limited)
 *   POST   /api/public/subscriptions/:id/confirm     confirm with the emailed token
 *   GET    /api/public/subscriptions/:id             \
 *   PUT    /api/public/subscriptions/:id              } manage, token in X-Subscription-Token
 *   DELETE /api/public/subscriptions/:id             /
 *   POST   /api/public/subscriptions/:id/unsubscribe?token=   RFC 8058 one-click
 *
 * Unknown ids and wrong tokens get the same 404. Managing and unsubscribing keep
 * working when subscriptions are disabled later; only subscribing needs them enabled.
 */
import {
  SUBSCRIPTION_TOKEN_HEADER,
  SubscribeInput,
  SubscriptionConfirmInput,
  SubscriptionPreferencesInput,
  type PublicSubscription,
} from '@openstatuspage/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound } from '../lib/errors.js';
import { IdParams, parse } from '../lib/http.js';
import {
  assertPublicServices,
  confirmSubscription,
  deleteSubscriber,
  findByToken,
  subscribe,
  subscriberLinks,
  subscriberTokens,
  subscriptionsAvailable,
  toPublicSubscription,
  updatePreferences,
} from '../services/subscriptions.js';

const TokenQuery = z.object({ token: z.string().max(256).optional() });

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

    scope.post(
      '/api/public/subscriptions',
      { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
      async (req, reply) => {
        if (!(await subscriptionsAvailable(ctx))) throw notFound('Subscriptions');
        const input = parse(SubscribeInput, req.body);
        // Honeypot filled in (bots): answer like a successful subscribe, but create and send nothing.
        if (input.website) return reply.status(202).send({ ok: true });
        // Checked before answering (400 on unknown or hidden services); does not look at subscribers.
        const serviceIds = input.allServices ? [] : await assertPublicServices(ctx.db, input.serviceIds);
        // What happens next, and how long it takes, depends on whether the address is
        // new, pending or confirmed. It runs once the answer has been sent, so neither
        // the answer nor its timing reveals whether an address is subscribed.
        const answered = new Promise<void>((resolve) => reply.raw.once('close', () => resolve()));
        ctx.worker.runDetached('subscribe', async () => {
          await answered;
          await subscribe(ctx, { ...input, serviceIds });
        });
        return reply.status(202).send({ ok: true });
      },
    );

    scope.post('/api/public/subscriptions/:id/confirm', manageRoute, async (req) => {
      const { id } = parse(IdParams, req.params);
      const { token } = parse(SubscriptionConfirmInput, req.body);
      return confirmSubscription(ctx, id, token);
    });

    scope.get('/api/public/subscriptions/:id', manageRoute, async (req): Promise<PublicSubscription> => {
      const { id } = parse(IdParams, req.params);
      const sub = await findByToken(ctx, id, 'manage', headerToken(req));
      return toPublicSubscription(ctx.db, sub);
    });

    scope.put('/api/public/subscriptions/:id', manageRoute, async (req): Promise<PublicSubscription> => {
      const { id } = parse(IdParams, req.params);
      const sub = await findByToken(ctx, id, 'manage', headerToken(req));
      const input = parse(SubscriptionPreferencesInput, req.body);
      return updatePreferences(ctx, sub, input);
    });

    scope.delete('/api/public/subscriptions/:id', manageRoute, async (req, reply) => {
      const { id } = parse(IdParams, req.params);
      const sub = await findByToken(ctx, id, 'manage', headerToken(req));
      await deleteSubscriber(ctx.db, sub.id);
      return reply.status(204).send();
    });

    scope.post('/api/public/subscriptions/:id/unsubscribe', queryTokenRoute, async (req) => {
      const { id } = parse(IdParams, req.params);
      const { token } = parse(TokenQuery, req.query);
      const sub = await findByToken(ctx, id, 'manage', token);
      await deleteSubscriber(ctx.db, sub.id);
      return { ok: true };
    });

    // A browser opening the List-Unsubscribe URL lands on the manage page (GET never deletes).
    scope.get('/api/public/subscriptions/:id/unsubscribe', queryTokenRoute, async (req, reply) => {
      const { id } = parse(IdParams, req.params);
      const { token } = parse(TokenQuery, req.query);
      const sub = await findByToken(ctx, id, 'manage', token);
      // The manage page reads the token from the URL fragment.
      return reply.redirect(subscriberLinks(ctx.config, sub.id, subscriberTokens(ctx.config, sub)).unsubscribeUrl, 303);
    });
  });
}
