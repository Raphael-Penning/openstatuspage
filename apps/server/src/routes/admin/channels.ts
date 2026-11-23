/**
 * Webhook and SMS notifications (admin only, JSON:API).
 *
 *   GET    /api/admin/webhooks
 *   POST   /api/admin/webhooks                      → generic: with `signingSecret` (only here)
 *   GET    /api/admin/webhooks/:id
 *   PATCH  /api/admin/webhooks/:id                  partial; `url`/`headers` left out keep their values
 *   DELETE /api/admin/webhooks/:id
 *   POST   /api/admin/webhooks/:id/test             sends a test message now → meta { ok, statusCode, message }
 *   POST   /api/admin/webhooks/:id/rotate-secret    generic: a new `signingSecret` (only here)
 *   POST   /api/admin/webhooks/:id/retry-failed     → meta { requeued }
 *   GET    /api/admin/webhooks/:id/deliveries       delivery log (paged; no URL, header or body)
 *   GET    /api/admin/sms-provider                  template, credentials only as "set", budget use
 *   PATCH  /api/admin/sms-provider
 *   GET    /api/admin/sms-presets                   the preset templates
 *   POST   /api/admin/sms-provider/test             { to } → meta { ok, statusCode, message }
 *   GET|POST /api/admin/sms-recipients, GET|PATCH|DELETE /api/admin/sms-recipients/:id
 *   GET    /api/admin/channel-settings, PATCH /api/admin/channel-settings
 *   GET    /api/admin/channel-subscribers           filter[channel]=webhook|sms, filter[status]
 *   DELETE /api/admin/channel-subscribers/:id
 *
 * URLs, header values, signing secrets and SMS credentials are write-only and
 * never written to the audit log.
 */
import { randomBytes } from 'node:crypto';
import {
  ChannelSettingsInput,
  checkWebhookUrl,
  normalizePhone,
  SmsProviderInput,
  SmsRecipientInput,
  SmsTestInput,
  WebhookInput,
  type AdminChannelSubscriber,
  type AdminSmsProvider,
  type AdminSmsRecipient,
  type AdminWebhook,
  type WebhookDelivery,
} from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { requireChannels } from '../../context.js';
import type { Database, NotificationWebhook } from '../../db/types.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { IdParams, parse, unique } from '../../lib/http.js';
import { newId } from '../../lib/ids.js';
import { collection, created, document, Included, metaDocument, noContent, resource, toMany } from '../../lib/jsonapi.js';
import { parseListQuery } from '../../lib/jsonapi-query.js';
import { nowIso } from '../../lib/time.js';
import { useJsonApi } from '../../plugins/jsonapi.js';
import {
  getChannelSettings,
  getSmsProvider,
  saveChannelSettings,
  saveSmsProvider,
  smsUsedThisMonth,
} from '../../services/channels/settings.js';
import { SMS_PRESET_TEMPLATES } from '../../services/channels/sms.js';
import { deleteChannelSubscriber } from '../../services/channels/subscriptions.js';
import { admin, assertExist, auditRequest } from './util.js';

export const CHANNEL_TYPES = {
  webhook: 'webhooks',
  delivery: 'webhook-deliveries',
  smsProvider: 'sms-provider',
  smsPreset: 'sms-presets',
  smsRecipient: 'sms-recipients',
  channelSettings: 'channel-settings',
  channelSubscriber: 'channel-subscribers',
  service: 'services',
} as const;

const asObject = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

const urlIssue = (message: string) => badRequest(message, [{ path: ['url'], code: 'invalid_value', message }]);

function checkAdminUrl(kind: WebhookInput['kind'], url: string, allowHttp: boolean): { url: string; host: string } {
  const checked = checkWebhookUrl(kind, url, { subscriber: false, allowHttp });
  if (!checked.ok) {
    throw urlIssue(
      checked.problem === 'insecure'
        ? 'The URL must start with https:// (or allow http for this webhook)'
        : checked.problem === 'address'
          ? 'Use a host name, not an IP address'
          : 'Enter a valid URL',
    );
  }
  return { url: checked.url, host: new URL(checked.url).host };
}

const newSigningSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

type Db = Kysely<Database> | Transaction<Database>;

async function setServices(db: Db, table: 'notification_webhook_services' | 'sms_recipient_services', ownerId: string, ids: string[]) {
  if (table === 'notification_webhook_services') {
    await db.deleteFrom(table).where('webhook_id', '=', ownerId).execute();
    if (ids.length > 0) await db.insertInto(table).values(ids.map((service_id) => ({ webhook_id: ownerId, service_id }))).execute();
  } else {
    await db.deleteFrom(table).where('recipient_id', '=', ownerId).execute();
    if (ids.length > 0) await db.insertInto(table).values(ids.map((service_id) => ({ recipient_id: ownerId, service_id }))).execute();
  }
}

/** Services of webhooks, recipients or subscribers (id → [{ id, name }]). */
async function servicesOf(
  db: Db,
  table: 'notification_webhook_services' | 'sms_recipient_services' | 'channel_subscriber_services',
  ids: string[],
): Promise<Map<string, { id: string; name: string }[]>> {
  const map = new Map<string, { id: string; name: string }[]>();
  if (ids.length === 0) return map;
  const owner = table === 'notification_webhook_services' ? 'webhook_id' : table === 'sms_recipient_services' ? 'recipient_id' : 'subscriber_id';
  const rows = await (db as Kysely<any>)
    .selectFrom(table)
    .innerJoin('services', 'services.id', `${table}.service_id`)
    .select([`${table}.${owner} as owner`, 'services.id as id', 'services.name as name'])
    .where(`${table}.${owner}`, 'in', ids)
    .orderBy('services.sort_order')
    .orderBy('services.name')
    .execute();
  for (const r of rows as { owner: string; id: string; name: string }[]) {
    const list = map.get(r.owner) ?? [];
    list.push({ id: r.id, name: r.name });
    map.set(r.owner, list);
  }
  return map;
}

function webhookOf(row: NotificationWebhook, services: { id: string; name: string }[]): AdminWebhook {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    host: row.host,
    enabled: row.enabled === 1,
    allowHttp: row.allow_http === 1,
    allServices: row.all_services === 1,
    services: row.all_services === 1 ? [] : services,
    headerNames: JSON.parse(row.header_names) as string[],
    consecutiveFailures: row.consecutive_failures,
    disabledReason: row.disabled_reason,
    disabledAt: row.disabled_at,
    lastDeliveryAt: row.last_delivery_at,
    lastStatusCode: row.last_status_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A resource with its services as relationship (and in `included`). */
function withServices<T extends { id: string; services: { id: string; name: string }[] }>(
  type: string,
  item: T,
  included: Included,
  self: string,
) {
  const { services, ...attributes } = item;
  included.add(...services.map((s) => resource(CHANNEL_TYPES.service, s.id, { name: s.name })));
  return resource(type, item.id, attributes, {
    relationships: { services: toMany(CHANNEL_TYPES.service, services.map((s) => s.id)) },
    links: { self },
  });
}

export async function registerChannelRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    useJsonApi(scope);
    // Answers can carry a signing secret: never stored by a cache.
    scope.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });
    registerWebhookRoutes(scope);
    registerSmsRoutes(scope);
    registerSettingsAndSubscriberRoutes(scope);
  });
}

function registerWebhookRoutes(app: FastifyInstance): void {
  const { db, secrets } = app.ctx;
  const channels = requireChannels(app.ctx);
  const typed = { ...admin, config: { jsonapi: { type: CHANNEL_TYPES.webhook, relationships: { services: CHANNEL_TYPES.service } } } };

  const load = async (ids?: string[]): Promise<AdminWebhook[]> => {
    let q = db.selectFrom('notification_webhooks').selectAll().orderBy('name').orderBy('id');
    if (ids) q = q.where('id', 'in', ids.length > 0 ? ids : ['']);
    const rows = await q.execute();
    const services = await servicesOf(db, 'notification_webhook_services', rows.map((r) => r.id));
    return rows.map((r) => webhookOf(r, services.get(r.id) ?? []));
  };
  const get = async (id: string) => {
    const [wh] = await load([id]);
    if (!wh) throw notFound('Webhook');
    return wh;
  };
  const one = (wh: AdminWebhook) => {
    const included = new Included();
    const data = withServices(CHANNEL_TYPES.webhook, wh, included, `/api/admin/webhooks/${wh.id}`);
    return document(data, { included });
  };

  app.get('/api/admin/webhooks', admin, async (req) => {
    const included = new Included();
    const items = (await load()).map((wh) => withServices(CHANNEL_TYPES.webhook, wh, included, `/api/admin/webhooks/${wh.id}`));
    return collection(req, items, { included });
  });

  app.post('/api/admin/webhooks', typed, async (req, reply) => {
    const input = parse(WebhookInput, req.body);
    const { url, host } = checkAdminUrl(input.kind, input.url, input.allowHttp);
    const serviceIds = input.allServices ? [] : await assertExist(db, 'services', unique(input.serviceIds), 'service');
    const headers = input.kind === 'generic' ? input.headers : [];
    const secret = input.kind === 'generic' ? newSigningSecret() : null;
    const id = newId();
    const now = nowIso();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('notification_webhooks')
        .values({
          id,
          name: input.name,
          kind: input.kind,
          url_enc: secrets.encrypt(url),
          host,
          secret_enc: secret ? secrets.encrypt(secret) : null,
          headers_enc: headers.length > 0 ? secrets.encryptJson(headers) : null,
          header_names: JSON.stringify(headers.map((h) => h.name)),
          allow_http: input.allowHttp ? 1 : 0,
          all_services: input.allServices ? 1 : 0,
          enabled: input.enabled ? 1 : 0,
          consecutive_failures: 0,
          disabled_reason: null,
          disabled_at: null,
          last_delivery_at: null,
          last_status_code: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await setServices(trx, 'notification_webhook_services', id, serviceIds);
    });
    await auditRequest(db, req, 'webhook.create', 'webhook', id, { name: input.name, kind: input.kind, host });
    const wh = await get(id);
    return created(reply, one(secret ? { ...wh, signingSecret: secret } : wh), `/api/admin/webhooks/${id}`);
  });

  app.get('/api/admin/webhooks/:id', admin, async (req) => one(await get(parse(IdParams, req.params).id)));

  app.patch('/api/admin/webhooks/:id', typed, async (req) => {
    const { id } = parse(IdParams, req.params);
    const row = await db.selectFrom('notification_webhooks').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound('Webhook');
    const current = await get(id);
    const body = asObject(req.body);
    let currentUrl = '';
    try {
      currentUrl = secrets.decrypt(row.url_enc);
    } catch {
      // SECRET_KEY changed: the URL must be entered again.
    }
    const input = parse(WebhookInput, {
      name: current.name,
      kind: current.kind,
      url: currentUrl || undefined,
      enabled: current.enabled,
      allowHttp: current.allowHttp,
      allServices: current.allServices,
      serviceIds: current.services.map((s) => s.id),
      ...body,
    });
    const { url, host } = checkAdminUrl(input.kind, input.url, input.allowHttp);
    const serviceIds = input.allServices ? [] : await assertExist(db, 'services', unique(input.serviceIds), 'service');
    const headersGiven = 'headers' in body;
    const headers = input.kind !== 'generic' ? [] : headersGiven ? input.headers : null;
    // A generic webhook needs a secret (also after changing the kind).
    const secretEnc = input.kind === 'generic' ? (row.secret_enc ?? secrets.encrypt(newSigningSecret())) : null;
    const reenabled = input.enabled && row.enabled !== 1;
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('notification_webhooks')
        .set({
          name: input.name,
          kind: input.kind,
          url_enc: secrets.encrypt(url),
          host,
          secret_enc: secretEnc,
          ...(headers !== null
            ? {
                headers_enc: headers.length > 0 ? secrets.encryptJson(headers) : null,
                header_names: JSON.stringify(headers.map((h) => h.name)),
              }
            : {}),
          allow_http: input.allowHttp ? 1 : 0,
          all_services: input.allServices ? 1 : 0,
          enabled: input.enabled ? 1 : 0,
          ...(reenabled ? { consecutive_failures: 0, disabled_reason: null, disabled_at: null } : {}),
          updated_at: nowIso(),
        })
        .where('id', '=', id)
        .execute();
      await setServices(trx, 'notification_webhook_services', id, serviceIds);
    });
    await auditRequest(db, req, 'webhook.update', 'webhook', id, { name: input.name, kind: input.kind, host, enabled: input.enabled });
    return one(await get(id));
  });

  app.delete('/api/admin/webhooks/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const wh = await get(id);
    await db.deleteFrom('notification_webhooks').where('id', '=', id).execute();
    await db.deleteFrom('channel_outbox').where('recipient_type', '=', 'admin_webhook').where('recipient_id', '=', id).execute();
    await auditRequest(db, req, 'webhook.delete', 'webhook', id, { name: wh.name });
    return noContent(reply);
  });

  app.post('/api/admin/webhooks/:id/test', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    const result = await channels.testWebhook(id);
    if (!result) throw notFound('Webhook');
    await auditRequest(db, req, 'webhook.test', 'webhook', id, { ok: result.ok, statusCode: result.statusCode });
    return metaDocument({ ok: result.ok, statusCode: result.statusCode, message: result.message });
  });

  app.post('/api/admin/webhooks/:id/rotate-secret', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    const wh = await get(id);
    if (wh.kind !== 'generic') throw badRequest('Only generic webhooks are signed');
    const secret = newSigningSecret();
    await db.updateTable('notification_webhooks').set({ secret_enc: secrets.encrypt(secret), updated_at: nowIso() }).where('id', '=', id).execute();
    await auditRequest(db, req, 'webhook.rotate_secret', 'webhook', id, { name: wh.name });
    return one({ ...(await get(id)), signingSecret: secret });
  });

  app.post('/api/admin/webhooks/:id/retry-failed', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    await get(id);
    const requeued = await channels.retryFailedWebhook(id);
    await auditRequest(db, req, 'webhook.retry_failed', 'webhook', id, { requeued });
    return metaDocument({ requeued });
  });

  app.get('/api/admin/webhooks/:id/deliveries', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    await get(id);
    const { page } = parseListQuery(req.query, { page: { defaultSize: 25, maxSize: 100 } });
    const base = db.selectFrom('channel_outbox').where('recipient_type', '=', 'admin_webhook').where('recipient_id', '=', id);
    const [total, rows] = await Promise.all([
      base
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .executeTakeFirstOrThrow()
        .then((r) => Number(r.n)),
      base
        .select(['id', 'event', 'status', 'attempts', 'status_code', 'last_error', 'created_at', 'last_attempt_at', 'sent_at'])
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(page.size)
        .offset(page.offset)
        .execute(),
    ]);
    const items = rows.map((r) => {
      const d: WebhookDelivery = {
        id: r.id,
        event: r.event,
        status: r.status,
        attempts: r.attempts,
        statusCode: r.status_code,
        error: r.last_error,
        createdAt: r.created_at,
        lastAttemptAt: r.last_attempt_at,
        sentAt: r.sent_at,
      };
      return resource(CHANNEL_TYPES.delivery, d.id, d);
    });
    return collection(req, items, { page, total });
  });
}

function registerSmsRoutes(app: FastifyInstance): void {
  const { db, secrets } = app.ctx;
  const channels = requireChannels(app.ctx);

  const providerResource = async () => {
    const [provider, settings, used] = await Promise.all([getSmsProvider(db), getChannelSettings(db), smsUsedThisMonth(db)]);
    let creds: { username?: string; password?: string } = {};
    try {
      creds = provider.credentials ? secrets.decryptJson(provider.credentials) : {};
    } catch {
      creds = {};
    }
    const { credentials: _c, ...template } = provider;
    const body: AdminSmsProvider = {
      ...template,
      usernameSet: Boolean(creds.username),
      passwordSet: Boolean(creds.password),
      sentThisMonth: used,
      monthlyBudget: settings.smsMonthlyBudget,
      budgetExhausted: used >= settings.smsMonthlyBudget,
    };
    return document(resource(CHANNEL_TYPES.smsProvider, 'current', body, { links: { self: '/api/admin/sms-provider' } }));
  };

  app.get('/api/admin/sms-provider', admin, async () => providerResource());

  app.patch('/api/admin/sms-provider', { ...admin, config: { jsonapi: { type: CHANNEL_TYPES.smsProvider } } }, async (req) => {
    const current = await getSmsProvider(db);
    const { credentials: _c, ...template } = current;
    const input = parse(SmsProviderInput, { ...template, ...asObject(req.body) });
    if (input.url) {
      // Placeholders are filled in before sending: check the URL with sample values.
      const sample = input.url.replace(/\{\{\s*[a-z_]+\s*\}\}/g, 'x');
      const checked = checkWebhookUrl('generic', sample, { subscriber: false });
      if (!checked.ok) throw urlIssue('The provider URL must be an https:// URL with a host name');
    }
    await saveSmsProvider(db, secrets, input);
    await auditRequest(db, req, 'sms_provider.update', 'sms_provider', null, {
      preset: input.preset,
      enabled: input.enabled,
      credentialsChanged: input.username !== undefined || input.password !== undefined,
    });
    return providerResource();
  });

  app.get('/api/admin/sms-presets', admin, async (req) =>
    collection(
      req,
      Object.entries(SMS_PRESET_TEMPLATES).map(([name, template]) => resource(CHANNEL_TYPES.smsPreset, name, template)),
    ),
  );

  app.post('/api/admin/sms-provider/test', admin, async (req) => {
    const { to } = parse(SmsTestInput, req.body);
    const result = await channels.testSms(to);
    await auditRequest(db, req, 'sms_provider.test', 'sms_provider', null, { ok: result.ok, statusCode: result.statusCode });
    return metaDocument({ ok: result.ok, statusCode: result.statusCode, message: result.message });
  });

  const typed = {
    ...admin,
    config: { jsonapi: { type: CHANNEL_TYPES.smsRecipient, relationships: { services: CHANNEL_TYPES.service } } },
  };
  const loadRecipients = async (ids?: string[]): Promise<AdminSmsRecipient[]> => {
    let q = db.selectFrom('sms_recipients').selectAll().orderBy('name').orderBy('id');
    if (ids) q = q.where('id', 'in', ids.length > 0 ? ids : ['']);
    const rows = await q.execute();
    const services = await servicesOf(db, 'sms_recipient_services', rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      enabled: r.enabled === 1,
      allServices: r.all_services === 1,
      services: r.all_services === 1 ? [] : (services.get(r.id) ?? []),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  };
  const getRecipient = async (id: string) => {
    const [r] = await loadRecipients([id]);
    if (!r) throw notFound('SMS recipient');
    return r;
  };
  const oneRecipient = (r: AdminSmsRecipient) => {
    const included = new Included();
    return document(withServices(CHANNEL_TYPES.smsRecipient, r, included, `/api/admin/sms-recipients/${r.id}`), { included });
  };
  const phoneOf = (raw: string) => {
    const phone = normalizePhone(raw);
    if (!phone) {
      const message = 'Enter the number in international format, e.g. +49 151 2345678';
      throw badRequest(message, [{ path: ['phone'], code: 'invalid_value', message }]);
    }
    return phone;
  };

  app.get('/api/admin/sms-recipients', admin, async (req) => {
    const included = new Included();
    const items = (await loadRecipients()).map((r) => withServices(CHANNEL_TYPES.smsRecipient, r, included, `/api/admin/sms-recipients/${r.id}`));
    return collection(req, items, { included });
  });

  app.post('/api/admin/sms-recipients', typed, async (req, reply) => {
    const input = parse(SmsRecipientInput, req.body);
    const phone = phoneOf(input.phone);
    const serviceIds = input.allServices ? [] : await assertExist(db, 'services', unique(input.serviceIds), 'service');
    const id = newId();
    const now = nowIso();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('sms_recipients')
        .values({ id, name: input.name, phone, enabled: input.enabled ? 1 : 0, all_services: input.allServices ? 1 : 0, created_at: now, updated_at: now })
        .execute();
      await setServices(trx, 'sms_recipient_services', id, serviceIds);
    });
    await auditRequest(db, req, 'sms_recipient.create', 'sms_recipient', id, { name: input.name });
    return created(reply, oneRecipient(await getRecipient(id)), `/api/admin/sms-recipients/${id}`);
  });

  app.get('/api/admin/sms-recipients/:id', admin, async (req) => oneRecipient(await getRecipient(parse(IdParams, req.params).id)));

  app.patch('/api/admin/sms-recipients/:id', typed, async (req) => {
    const { id } = parse(IdParams, req.params);
    const current = await getRecipient(id);
    const input = parse(SmsRecipientInput, {
      name: current.name,
      phone: current.phone,
      enabled: current.enabled,
      allServices: current.allServices,
      serviceIds: current.services.map((s) => s.id),
      ...asObject(req.body),
    });
    const phone = phoneOf(input.phone);
    const serviceIds = input.allServices ? [] : await assertExist(db, 'services', unique(input.serviceIds), 'service');
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('sms_recipients')
        .set({ name: input.name, phone, enabled: input.enabled ? 1 : 0, all_services: input.allServices ? 1 : 0, updated_at: nowIso() })
        .where('id', '=', id)
        .execute();
      await setServices(trx, 'sms_recipient_services', id, serviceIds);
    });
    await auditRequest(db, req, 'sms_recipient.update', 'sms_recipient', id, { name: input.name });
    return oneRecipient(await getRecipient(id));
  });

  app.delete('/api/admin/sms-recipients/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const r = await getRecipient(id);
    await db.deleteFrom('sms_recipients').where('id', '=', id).execute();
    await db.deleteFrom('channel_outbox').where('recipient_type', '=', 'sms_recipient').where('recipient_id', '=', id).where('status', '=', 'pending').execute();
    await auditRequest(db, req, 'sms_recipient.delete', 'sms_recipient', id, { name: r.name });
    return noContent(reply);
  });
}

/** Filters of GET /api/admin/channel-subscribers. */
const ChannelSubscriberFilter = {
  channel: z.enum(['all', 'webhook', 'sms']).default('all'),
  status: z.enum(['all', 'confirmed', 'pending']).default('all'),
};

function registerSettingsAndSubscriberRoutes(app: FastifyInstance): void {
  const { db } = app.ctx;
  const settingsDoc = async () =>
    document(resource(CHANNEL_TYPES.channelSettings, 'current', await getChannelSettings(db), { links: { self: '/api/admin/channel-settings' } }));

  app.get('/api/admin/channel-settings', admin, async () => settingsDoc());

  app.patch('/api/admin/channel-settings', { ...admin, config: { jsonapi: { type: CHANNEL_TYPES.channelSettings } } }, async (req) => {
    const input = parse(ChannelSettingsInput, { ...(await getChannelSettings(db)), ...asObject(req.body) });
    await saveChannelSettings(db, input);
    await auditRequest(db, req, 'channel_settings.update', 'channel_settings', null, { ...input });
    return settingsDoc();
  });

  app.get('/api/admin/channel-subscribers', admin, async (req) => {
    const { page, filter } = parseListQuery(req.query, { page: { defaultSize: 50, maxSize: 100 }, filter: ChannelSubscriberFilter });
    let base = db.selectFrom('channel_subscribers');
    if (filter.channel !== 'all') base = base.where('channel', '=', filter.channel);
    if (filter.status === 'confirmed') base = base.where('confirmed_at', 'is not', null);
    if (filter.status === 'pending') base = base.where('confirmed_at', 'is', null);
    const [total, rows] = await Promise.all([
      base
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .executeTakeFirstOrThrow()
        .then((r) => Number(r.n)),
      base
        .select(['id', 'channel', 'webhook_kind', 'target_hint', 'locale', 'all_services', 'confirmed_at', 'created_at'])
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(page.size)
        .offset(page.offset)
        .execute(),
    ]);
    const services = await servicesOf(db, 'channel_subscriber_services', rows.filter((r) => r.all_services !== 1).map((r) => r.id));
    const included = new Included();
    const items = rows.map((r) => {
      const item: AdminChannelSubscriber = {
        id: r.id,
        channel: r.channel,
        webhookKind: r.webhook_kind,
        target: r.target_hint,
        locale: r.locale,
        allServices: r.all_services === 1,
        services: services.get(r.id) ?? [],
        confirmed: r.confirmed_at !== null,
        createdAt: r.created_at,
        confirmedAt: r.confirmed_at,
      };
      return withServices(CHANNEL_TYPES.channelSubscriber, item, included, `/api/admin/channel-subscribers/${r.id}`);
    });
    return collection(req, items, { page, total, included });
  });

  app.delete('/api/admin/channel-subscribers/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const row = await db.selectFrom('channel_subscribers').select(['channel', 'target_hint']).where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound('Subscriber');
    await deleteChannelSubscriber(db, id);
    await auditRequest(db, req, 'channel_subscriber.delete', 'channel_subscriber', id, { channel: row.channel, target: row.target_hint });
    return noContent(reply);
  });
}

