/**
 * HTML form handlers of the public pages (outside /api): visitor preferences and
 * the email subscription. Registered on every instance that serves the public
 * web client; the subscription forms need the public API (role.ts).
 */
import type { DataDocument } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { document } from '../lib/jsonapi.js';
import { roleFeatures } from '../role.js';
import { subscriptionResource } from '../serializers/auth-users.js';
import { getManaged } from '../services/subscription-flow.js';
import { channelSubscriptionResource } from '../routes/channel-subscriptions.js';
import { getChannelSubscription } from '../services/channels/subscriptions.js';
import type { SsrPages } from '../ssr/pages.js';
import { registerFormBody } from './http.js';
import { registerPreferenceForms } from './preferences.js';
import { registerChannelSubscriptionForms } from './channel-subscriptions.js';
import { registerSubscriptionForms, type FormPageRenderer } from './subscriptions.js';

export async function registerFormRoutes(app: FastifyInstance, ssr: SsrPages | null): Promise<void> {
  const features = roleFeatures(app.ctx.config.APP_ROLE);
  await app.register(async (scope) => {
    registerFormBody(scope);
    registerPreferenceForms(scope);
    if (features.publicApi) {
      const render: FormPageRenderer = (req, reply, page) => (ssr ? ssr.sendForm(req, reply, page) : Promise.resolve(false));
      registerSubscriptionForms(scope, render);
      // Own scope: its own answer to rate-limited requests.
      await scope.register(async (channels) => registerChannelSubscriptionForms(channels, render));
    }
  });
}

/** The subscription document for the manage page rendered on the server (404 for a wrong token). */
export async function subscriptionDocument(app: FastifyInstance, id: string, token: string): Promise<DataDocument> {
  return document(subscriptionResource(await getManaged(app.ctx, id, token)));
}

/** The webhook or SMS subscription document for its manage page rendered on the server (404 for a wrong token). */
export async function channelSubscriptionDocument(app: FastifyInstance, id: string, token: string): Promise<DataDocument> {
  return document(channelSubscriptionResource(await getChannelSubscription(app.ctx, id, token)));
}
