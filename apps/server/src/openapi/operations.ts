/**
 * The HTTP API as data: one entry per route the OpenAPI document describes
 * (document.ts turns it into OpenAPI 3.1). Request attributes reference the zod
 * schemas of packages/shared by name (schemas.ts); everything else (access,
 * JSON:API types, include paths, filters, rate limits) is declared here.
 *
 * Kept in step with the routes by test/openapi.test.ts: every registered route
 * is either listed here or in NON_API_ROUTES, and the JSON:API type,
 * relationships, `include` support, rate limits and roles declared here match
 * the route.
 */

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * Who may call an operation:
 * - `public`: anyone, no credentials.
 * - `subscriptionToken`: the manage token in `X-Subscription-Token`.
 * - `subscriptionTokenQuery`: the manage token in `?token=` (links in emails).
 * - `privatePageToken`: the token of a private page in `X-Private-Page-Token`.
 * - `anonymous`: an /api/auth endpoint that needs no session (login, OIDC).
 * - `session`: a signed-in person (session cookie; API tokens are refused).
 * - `editor` / `admin`: session cookie or API token with at least that role.
 * - `ingest`: the ingest token of a monitoring source.
 */
export type Access =
  | 'public'
  | 'subscriptionToken'
  | 'subscriptionTokenQuery'
  | 'privatePageToken'
  | 'anonymous'
  | 'session'
  | 'editor'
  | 'admin'
  | 'ingest';

export interface Param {
  name: string;
  description?: string;
  required?: boolean;
  /** JSON Schema of the value. */
  schema: Record<string, unknown>;
  example?: unknown;
}

export type RequestBody =
  /** A JSON:API request document. */
  | {
      kind: 'resource';
      /** `data.type`; `enforced: false` when the route takes any type. */
      type: string;
      enforced?: boolean;
      /** Name of the attribute schema (schemas.ts). */
      schema: string;
      /** PATCH: every attribute is optional. */
      partial?: boolean;
      relationships?: Record<string, string>;
      /** The request document may name the resource of the URL in `data.id`. */
      allowId?: boolean;
      example?: Record<string, unknown>;
    }
  /** A payload of another system (ingest, mail clients): not JSON:API. */
  | { kind: 'native'; schema?: string; contentTypes: string[]; description: string; required?: boolean; example?: unknown }
  /** Raw bytes. */
  | { kind: 'binary'; contentType: string; description: string };

export type ResponseSpec =
  /** A resource document (`data` is one resource). */
  | {
      kind: 'resource';
      type: string;
      status?: 200 | 201 | 202;
      description: string;
      attributes?: string;
      example?: unknown;
      /** A `201` that can also answer `200` (with this description), e.g. for bytes already stored. */
      existing?: string;
    }
  /** A collection document (`data` is an array). */
  | { kind: 'collection'; types: string[]; description: string; attributes?: string; example?: unknown }
  /** A meta-only document. */
  | { kind: 'meta'; status?: 200 | 202; description: string; meta?: Record<string, unknown>; example?: unknown }
  | { kind: 'noContent'; description: string }
  | { kind: 'redirect'; status: 302 | 303; description: string }
  /** Anything else (health, feeds, images, the OpenAPI document). */
  | { kind: 'other'; contentTypes: string[]; description: string; schema?: Record<string, unknown>; example?: unknown; notModified?: boolean };

export interface Operation {
  method: Method;
  /** Route path in Fastify syntax (`/api/admin/services/:id`). */
  path: string;
  tag: TagName;
  summary: string;
  description?: string;
  access: Access;
  /**
   * `public` operations whose answer depends on optional credentials: on an
   * `admin` or `all` instance a session cookie or API token changes it. Only
   * stated in the full document (public instances never resolve credentials).
   */
  optionalAuth?: boolean;
  /** A JSON:API route (content negotiation, `include`/`sort` checks); default true. */
  jsonapi?: boolean;
  request?: RequestBody;
  response: ResponseSpec;
  /** Supported `include` paths and the default (route config `jsonapi.include`). */
  include?: { paths: string[]; default: string[] };
  filters?: Param[];
  page?: { defaultSize: number; maxSize: number };
  query?: Param[];
  pathParams?: Record<string, Param['schema'] & { description?: string }>;
  /** Further error statuses besides those derived from the declaration. */
  errors?: number[];
  /** Per-route limit (route config `rateLimit`), or a description of a limit enforced elsewhere. */
  rateLimit?: { max: number; window: '1 minute'; per: string; routeConfig?: boolean };
  /** Body limit in bytes when it differs from the default 1 MiB. */
  bodyLimit?: number;
}

export const TAGS = [
  { name: 'Public', description: 'Read API of the public status page. No authentication; only public entities. Responses may be cached for 30 seconds.' },
  { name: 'Private pages', description: 'Pages shared by a secret link. The token travels in the `X-Private-Page-Token` header, never in the URL. Every token problem is the same `404`; all requests of a client share one rate limit.' },
  { name: 'Email subscriptions', description: 'Double opt-in email subscriptions. Managing a subscription needs its manage token.' },
  { name: 'Webhook and SMS subscriptions', description: 'Subscriptions of visitors by webhook or SMS (confirmed with a code).' },
  { name: 'Feeds and files', description: 'Formats other tools depend on: feeds and uploaded images. Not JSON:API; errors are JSON:API error documents.' },
  { name: 'Meta', description: 'Health check and this API description.' },
  { name: 'Auth', description: 'Login, logout, session and single sign-on (OIDC).' },
  { name: 'Admin: overview and settings', description: 'Dashboard, settings, audit log and instance. Management API (session cookie or API token).' },
  { name: 'Admin: catalog', description: 'Locations, service groups and services.' },
  { name: 'Admin: incidents', description: 'Incidents and their updates.' },
  { name: 'Admin: maintenance', description: 'Maintenance windows and their updates.' },
  { name: 'Admin: history corrections', description: 'Status overrides for past time ranges and the service history.' },
  { name: 'Admin: monitoring', description: 'Monitoring sources, checks and history imports.' },
  { name: 'Admin: check bundles', description: 'Virtual checks that combine the votes of several checks.' },
  { name: 'Admin: users and API tokens', description: 'Accounts of the management UI and API tokens.' },
  { name: 'Admin: subscribers and notifications', description: 'Email subscribers and the mail queue.' },
  { name: 'Admin: webhooks and SMS', description: 'Team webhooks, the SMS provider, on-call numbers and webhook/SMS subscribers.' },
  { name: 'Admin: private pages', description: 'Pages shared by a secret link.' },
  { name: 'Admin: SSO providers', description: 'OIDC identity providers of the management UI.' },
  { name: 'Admin: pages and images', description: 'Content pages and uploaded images.' },
  { name: 'Ingest', description: 'Push endpoints for monitoring systems. Native payloads, JSON:API responses.' },
] as const;

export type TagName = (typeof TAGS)[number]['name'];

/**
 * Registered routes the OpenAPI document leaves out on purpose: they are no API
 * for programs but pages, links or files for browsers and crawlers.
 */
export const NON_API_ROUTES: readonly { route: string; reason: string }[] = [
  { route: 'GET /s/:id/:token', reason: 'Short manage link in webhook and SMS messages (a 303 to a page)' },
  { route: 'GET /robots.txt', reason: 'Crawler file' },
  { route: 'GET /sitemap.xml', reason: 'Crawler file' },
  { route: 'GET /sitemap-pages.xml', reason: 'Crawler file' },
  { route: 'GET /sitemap-incidents-:page.xml', reason: 'Crawler file' },
  { route: 'GET /sitemap-services-:page.xml', reason: 'Crawler file' },
  { route: 'GET /llms.txt', reason: 'Crawler file' },
  { route: 'GET /llms-full.txt', reason: 'Crawler file' },
  { route: 'GET /pulse/p.js', reason: 'Analytics proxy (only with UMAMI_URL)' },
  { route: 'POST /pulse/api/send', reason: 'Analytics proxy (only with UMAMI_URL)' },
  // HTML form handlers of the public pages (no JavaScript), see docs/api.md#html-forms.
  { route: 'POST /subscribe', reason: 'HTML form of the public pages' },
  { route: 'POST /subscribe/webhook', reason: 'HTML form of the public pages' },
  { route: 'POST /subscribe/sms', reason: 'HTML form of the public pages' },
  { route: 'POST /subscription/confirm', reason: 'HTML form of the public pages' },
  { route: 'POST /subscription/manage', reason: 'HTML form of the public pages' },
  { route: 'POST /subscription/unsubscribe', reason: 'HTML form of the public pages' },
  { route: 'POST /subscription/verify', reason: 'HTML form of the public pages' },
  { route: 'POST /subscription/channel', reason: 'HTML form of the public pages' },
  { route: 'POST /subscription/channel/unsubscribe', reason: 'HTML form of the public pages' },
  { route: 'POST /preferences/theme', reason: 'HTML form of the public pages' },
  { route: 'POST /preferences/analytics', reason: 'HTML form of the public pages' },
  { route: 'GET /preferences/language', reason: 'Language switch link of the public pages' },
  { route: 'POST /preferences/language', reason: 'HTML form of the public pages' },
];

// Small builders for the declarations below.
const str = (extra: Record<string, unknown> = {}) => ({ type: 'string', ...extra });
const ID = str({ minLength: 1, maxLength: 64 });
const id = (description: string) => ({ ...ID, description });
const enumOf = (values: readonly string[], extra: Record<string, unknown> = {}) => ({ type: 'string', enum: [...values], ...extra });
const filter = (name: string, schema: Record<string, unknown>, description?: string): Param => ({ name, schema, description });
const TIMESTAMP = str({ format: 'date-time' });
const PER_IP = 'client IP address';
const perMinute = (max: number, per = PER_IP, routeConfig = true) => ({ max, window: '1 minute' as const, per, routeConfig });

const UPDATES_INCLUDE = { paths: ['updates'], default: ['updates'] };

const resource = (type: string, description: string, attributes?: string, status?: 200 | 201 | 202): ResponseSpec => ({
  kind: 'resource',
  type,
  description,
  attributes,
  status,
});
const created = (type: string, attributes?: string, description = 'The new resource, with a `Location` header.') =>
  resource(type, description, attributes, 201);
const list = (type: string, description: string, attributes?: string): ResponseSpec => ({ kind: 'collection', types: [type], description, attributes });
const meta = (description: string, properties?: Record<string, unknown>, status?: 200 | 202): ResponseSpec => ({
  kind: 'meta',
  description,
  status,
  meta: properties && { type: 'object', properties },
});
const noContent = (description = 'Done (no body).'): ResponseSpec => ({ kind: 'noContent', description });
const body = (
  type: string,
  schema: string,
  options: { partial?: boolean; relationships?: Record<string, string>; enforced?: boolean; allowId?: boolean; example?: Record<string, unknown> } = {},
): RequestBody => ({ kind: 'resource', type, schema, ...options });
const ordering = body('orderings', 'ReorderInput');

const PAGE_20 = { defaultSize: 20, maxSize: 100 };
const PAGE_50 = { defaultSize: 50, maxSize: 100 };

const IDENTIFIER = { idOrSlug: { ...ID, maxLength: 100, description: 'Id or slug of the service.' } };
const DAY = { date: str({ minLength: 1, maxLength: 32, description: 'UTC day, `YYYY-MM-DD`.', example: '2026-11-20' }) };

/** Public page operations, also served for private pages with the token header. */
export const OPERATIONS: readonly Operation[] = [
  // ---------------------------------------------------------------- Meta
  {
    method: 'GET',
    path: '/api/health',
    tag: 'Meta',
    summary: 'Health check',
    description: 'Liveness and readiness probe: answers once the database answers. Exists in every role; not JSON:API.',
    access: 'public',
    jsonapi: false,
    response: {
      kind: 'other',
      contentTypes: ['application/json'],
      description: 'The database answers.',
      schema: { type: 'object', properties: { status: { const: 'ok' } }, required: ['status'] },
      example: { status: 'ok' },
    },
  },
  {
    method: 'GET',
    path: '/api/openapi.json',
    tag: 'Meta',
    summary: 'This API description (OpenAPI 3.1)',
    description:
      'Anonymous requests and instances with `APP_ROLE=public` get the public part (public read API, private pages, subscriptions, feeds and images). A signed-in user or an API token on an `admin` or `all` instance gets the whole API. Revalidate with `If-None-Match`.',
    access: 'public',
    optionalAuth: true,
    jsonapi: false,
    response: {
      kind: 'other',
      contentTypes: ['application/json'],
      description: 'The OpenAPI document, with an `ETag`.',
      schema: { type: 'object', required: ['openapi', 'info', 'paths'] },
      notModified: true,
    },
  },

  // ---------------------------------------------------------------- Public
  {
    method: 'GET',
    path: '/api/public/settings',
    tag: 'Public',
    summary: 'Page settings',
    access: 'public',
    response: resource('settings', 'The singleton `settings/site`.', 'PublicPageSettings'),
  },
  {
    method: 'GET',
    path: '/api/public/summary',
    tag: 'Public',
    summary: 'Everything the status page shows',
    description:
      '`summaries/current`: `overall`, `emailSubscriptions`, `channelSubscriptions`, `generatedAt`; relationships `page`, `groups`, `ungrouped`, `activeIncidents`, `recentIncidents`, `activeMaintenances`, `upcomingMaintenances`. Everything referenced is included.',
    access: 'public',
    response: resource('summaries', 'The singleton `summaries/current` with everything referenced in `included`.', 'PublicSummary'),
  },
  {
    method: 'GET',
    path: '/api/public/status',
    tag: 'Public',
    summary: 'Compact status for widgets and monitoring',
    description: '`statuses/current`: `overall`, `updatedAt`; relationships `services` (display order), `activeIncidents`, `activeMaintenances`.',
    access: 'public',
    response: resource('statuses', 'The singleton `statuses/current`.'),
  },
  {
    method: 'GET',
    path: '/api/public/services',
    tag: 'Public',
    summary: 'Public services',
    description: 'In display order (grouped services in group order, then ungrouped), `meta.counts` per status. The `service-groups` are included.',
    access: 'public',
    response: list('services', 'The public services.', 'PublicService'),
  },
  {
    method: 'GET',
    path: '/api/public/services/:idOrSlug',
    tag: 'Public',
    summary: 'One public service with its uptime',
    description: 'Relationships `incidents` (last 90 days and unresolved) and `maintenances` (active and upcoming).',
    access: 'public',
    pathParams: IDENTIFIER,
    include: { paths: ['incidents', 'incidents.updates', 'maintenances', 'maintenances.updates'], default: ['incidents', 'incidents.updates', 'maintenances', 'maintenances.updates'] },
    response: resource('services', 'The service incl. `uptime: DailyUptime[]`.', 'PublicService'),
  },
  {
    method: 'GET',
    path: '/api/public/services/:idOrSlug/days/:date',
    tag: 'Public',
    summary: 'One day of the uptime bar of a service',
    description:
      '`service-days` (id `<service id>:<YYYY-MM-DD>`): the values of the day plus `segments`, `complete`, `previousDate`, `nextDate`. `400` (`invalid_date`) for a malformed date, `404` for days outside the uptime range, hidden services and while `showUptime` is off.',
    access: 'public',
    pathParams: { ...IDENTIFIER, ...DAY },
    include: { paths: ['service', 'incidents', 'incidents.updates', 'maintenances', 'maintenances.updates'], default: ['service', 'incidents', 'incidents.updates', 'maintenances', 'maintenances.updates'] },
    response: resource('service-days', 'The day.'),
  },
  {
    method: 'GET',
    path: '/api/public/locations',
    tag: 'Public',
    summary: 'Public locations',
    description: '`404` when `showLocations` is disabled.',
    access: 'public',
    response: list('locations', 'The locations (relationship `services`), `meta.counts`.', 'PublicLocation'),
  },
  {
    method: 'GET',
    path: '/api/public/incidents/:id',
    tag: 'Public',
    summary: 'One public incident',
    access: 'public',
    pathParams: { id: id('Id of the incident.') },
    include: UPDATES_INCLUDE,
    response: resource('incidents', 'The incident (relationships `locations`, `updates`).', 'PublicIncident'),
  },
  {
    method: 'GET',
    path: '/api/public/maintenances/:id',
    tag: 'Public',
    summary: 'One public maintenance window',
    access: 'public',
    pathParams: { id: id('Id of the maintenance window.') },
    include: UPDATES_INCLUDE,
    response: resource('maintenances', 'The maintenance window (relationships `services`, `locations`, `updates`).', 'PublicMaintenance'),
  },
  {
    method: 'GET',
    path: '/api/public/history',
    tag: 'Public',
    summary: 'History of incidents and maintenance',
    description:
      'Heterogeneous, paginated collection of `incidents` and `maintenances`, newest first. Filters that reference non-public entities give an empty page.',
    access: 'public',
    include: UPDATES_INCLUDE,
    page: PAGE_20,
    filters: [
      filter('type', enumOf(['all', 'incident', 'maintenance'], { default: 'all' })),
      filter('service', ID, 'Public service id.'),
      filter('location', ID, 'Public location id: items linked to it or affecting a service running there.'),
      filter('month', str({ pattern: '^\\d{4}-\\d{2}$', example: '2026-11' }), 'Month, `YYYY-MM`.'),
    ],
    response: { kind: 'collection', types: ['incidents', 'maintenances'], description: 'A page of incidents and maintenance windows.' },
  },
  {
    method: 'GET',
    path: '/api/public/pages/:slug',
    tag: 'Public',
    summary: 'A published content page',
    description: '`title`, `description` and `body` (Markdown) per language, `images` and the path of the page. `404` for unpublished pages.',
    access: 'public',
    pathParams: { slug: str({ minLength: 1, maxLength: 64, description: 'Slug of the page.' }) },
    response: resource('pages', 'The page.'),
  },

  // ---------------------------------------------------------------- Private pages
  {
    method: 'GET',
    path: '/api/public/private-page',
    tag: 'Private pages',
    summary: 'The private page of the token',
    access: 'privatePageToken',
    response: resource('private-pages', 'The page with its services.'),
  },
  {
    method: 'GET',
    path: '/api/public/private-page/services/:idOrSlug',
    tag: 'Private pages',
    summary: 'A service of the private page',
    access: 'privatePageToken',
    pathParams: IDENTIFIER,
    include: { paths: ['incidents', 'incidents.updates', 'maintenances', 'maintenances.updates'], default: ['incidents', 'incidents.updates', 'maintenances', 'maintenances.updates'] },
    response: resource('services', 'The service with `incidents` and `maintenances`.'),
  },
  {
    method: 'GET',
    path: '/api/public/private-page/services/:idOrSlug/days/:date',
    tag: 'Private pages',
    summary: 'A day of a service of the private page',
    access: 'privatePageToken',
    pathParams: { ...IDENTIFIER, ...DAY },
    include: { paths: ['service', 'incidents', 'incidents.updates', 'maintenances', 'maintenances.updates'], default: ['service', 'incidents', 'incidents.updates', 'maintenances', 'maintenances.updates'] },
    response: resource('service-days', 'The day.'),
  },
  {
    method: 'GET',
    path: '/api/public/private-page/incidents/:id',
    tag: 'Private pages',
    summary: 'An incident the private page shows',
    access: 'privatePageToken',
    pathParams: { id: id('Id of the incident.') },
    include: UPDATES_INCLUDE,
    response: resource('incidents', 'The incident.'),
  },
  {
    method: 'GET',
    path: '/api/public/private-page/maintenances/:id',
    tag: 'Private pages',
    summary: 'A maintenance window the private page shows',
    access: 'privatePageToken',
    pathParams: { id: id('Id of the maintenance window.') },
    include: UPDATES_INCLUDE,
    response: resource('maintenances', 'The maintenance window.'),
  },

  // ---------------------------------------------------------------- Feeds and files
  {
    method: 'GET',
    path: '/feed.rss',
    tag: 'Feeds and files',
    summary: 'RSS 2.0 feed',
    description: 'Incidents and maintenance (last 50 items).',
    access: 'public',
    jsonapi: false,
    response: { kind: 'other', contentTypes: ['application/rss+xml'], description: 'The feed.' },
  },
  {
    method: 'GET',
    path: '/feed.atom',
    tag: 'Feeds and files',
    summary: 'Atom feed',
    description: 'Incidents and maintenance (last 50 items).',
    access: 'public',
    jsonapi: false,
    response: { kind: 'other', contentTypes: ['application/atom+xml'], description: 'The feed.' },
  },
  {
    method: 'GET',
    path: '/uploads/:file',
    tag: 'Feeds and files',
    summary: 'An uploaded image',
    description:
      'Named by the SHA-256 of its bytes: cached for a year as immutable, with an `ETag` (`304` for `If-None-Match`), `Content-Disposition: inline` and a CSP that allows nothing.',
    access: 'public',
    jsonapi: false,
    pathParams: { file: str({ pattern: '^[0-9a-f]{64}\\.(png|jpg|webp|ico)$', description: '`<sha256>.<ext>`.' }) },
    rateLimit: perMinute(600),
    response: { kind: 'other', contentTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/x-icon'], description: 'The image.', schema: { type: 'string', contentMediaType: 'application/octet-stream' }, notModified: true },
  },

  // ---------------------------------------------------------------- Email subscriptions
  {
    method: 'POST',
    path: '/api/public/subscriptions',
    tag: 'Email subscriptions',
    summary: 'Subscribe by email',
    description:
      '`202` with `meta.accepted` for every valid input (new, pending or confirmed address, so addresses cannot be enumerated). The confirmation email carries the link. `404` when subscriptions are not available, `400` on invalid input or unknown or non-public services. Rate limited together with the HTML form and the webhook and SMS subscriptions.',
    access: 'public',
    request: body('subscriptions', 'SubscribeInput', {
      relationships: { services: 'services' },
      example: { data: { type: 'subscriptions', attributes: { email: 'jane@example.com', locale: 'en' } } },
    }),
    rateLimit: perMinute(5, PER_IP, false),
    errors: [404],
    response: meta('Accepted (whatever the address).', { accepted: { type: 'boolean' } }, 202),
  },
  {
    method: 'POST',
    path: '/api/public/subscriptions/:id/confirm',
    tag: 'Email subscriptions',
    summary: 'Confirm a subscription',
    description:
      'Idempotent. Only the answer of the request that confirms carries `manageToken`; confirming again answers without it (an old confirmation link is no manage link).',
    access: 'public',
    pathParams: { id: id('Id of the subscription (from the confirmation link).') },
    request: body('subscriptions', 'SubscriptionConfirmInput', { enforced: false, allowId: true }),
    rateLimit: perMinute(30),
    response: resource('subscriptions', 'The subscription.', 'PublicSubscription'),
  },
  {
    method: 'GET',
    path: '/api/public/subscriptions/:id',
    tag: 'Email subscriptions',
    summary: 'A subscription',
    access: 'subscriptionToken',
    pathParams: { id: id('Id of the subscription.') },
    rateLimit: perMinute(30),
    response: resource('subscriptions', 'The subscription.', 'PublicSubscription'),
  },
  {
    method: 'PATCH',
    path: '/api/public/subscriptions/:id',
    tag: 'Email subscriptions',
    summary: 'Change a subscription',
    access: 'subscriptionToken',
    pathParams: { id: id('Id of the subscription.') },
    request: body('subscriptions', 'SubscriptionPreferencesInput', { partial: true, relationships: { services: 'services' } }),
    rateLimit: perMinute(30),
    response: resource('subscriptions', 'The subscription.', 'PublicSubscription'),
  },
  {
    method: 'DELETE',
    path: '/api/public/subscriptions/:id',
    tag: 'Email subscriptions',
    summary: 'Unsubscribe',
    description: 'Deletes the subscriber completely.',
    access: 'subscriptionToken',
    pathParams: { id: id('Id of the subscription.') },
    rateLimit: perMinute(30),
    response: noContent('Unsubscribed.'),
  },
  {
    method: 'GET',
    path: '/api/public/subscriptions/:id/unsubscribe',
    tag: 'Email subscriptions',
    summary: 'Unsubscribe link of emails',
    description: 'Never deletes: `303` to the manage page with the unsubscribe confirmation. Not JSON:API.',
    access: 'subscriptionTokenQuery',
    jsonapi: false,
    pathParams: { id: id('Id of the subscription.') },
    rateLimit: perMinute(30),
    response: { kind: 'redirect', status: 303, description: 'To the manage page.' },
  },
  {
    method: 'POST',
    path: '/api/public/subscriptions/:id/unsubscribe',
    tag: 'Email subscriptions',
    summary: 'One-click unsubscribe (RFC 8058)',
    description: 'Sent by mail clients for the `List-Unsubscribe` header: deletes the subscriber.',
    access: 'subscriptionTokenQuery',
    pathParams: { id: id('Id of the subscription.') },
    request: {
      kind: 'native',
      contentTypes: ['application/x-www-form-urlencoded'],
      description: 'Empty or `List-Unsubscribe=One-Click`.',
      required: false,
    },
    rateLimit: perMinute(30),
    response: noContent('Unsubscribed.'),
  },

  // ---------------------------------------------------------------- Webhook and SMS subscriptions
  {
    method: 'POST',
    path: '/api/public/channel-subscriptions',
    tag: 'Webhook and SMS subscriptions',
    summary: 'Subscribe by webhook or SMS',
    description:
      'Always `202` with `meta: { accepted: true, reference }` (also for a known destination). `404` when the channel or kind is not offered, `400` for an invalid target (`webhook_host`, `webhook_insecure`, `phone_format`, `phone_country`, `invalid_value`).',
    access: 'public',
    request: body('channel-subscriptions', 'ChannelSubscribeInput', {
      relationships: { services: 'services' },
      example: {
        data: {
          type: 'channel-subscriptions',
          attributes: { channel: 'webhook', webhookKind: 'discord', url: 'https://discord.example.com/api/webhooks/123/abc', locale: 'en', allServices: true },
        },
      },
    }),
    rateLimit: perMinute(5, PER_IP, false),
    errors: [404],
    response: meta('Accepted.', { accepted: { type: 'boolean' }, reference: { type: 'string' } }, 202),
  },
  {
    method: 'POST',
    path: '/api/public/channel-subscriptions/confirm',
    tag: 'Webhook and SMS subscriptions',
    summary: 'Confirm with the code',
    description: '`404` for a wrong, used or expired code; 5 wrong codes end a code.',
    access: 'public',
    request: body('channel-subscriptions', 'ChannelConfirmInput'),
    rateLimit: perMinute(10),
    response: resource('channel-subscriptions', 'The subscription with `manageToken` (and `signingSecret` for a generic webhook).'),
  },
  {
    method: 'GET',
    path: '/api/public/channel-subscriptions/:id',
    tag: 'Webhook and SMS subscriptions',
    summary: 'A webhook or SMS subscription',
    access: 'subscriptionToken',
    pathParams: { id: id('Id of the subscription.') },
    rateLimit: perMinute(30),
    response: resource('channel-subscriptions', 'The subscription (`target` masked).'),
  },
  {
    method: 'PATCH',
    path: '/api/public/channel-subscriptions/:id',
    tag: 'Webhook and SMS subscriptions',
    summary: 'Change a webhook or SMS subscription',
    access: 'subscriptionToken',
    pathParams: { id: id('Id of the subscription.') },
    request: body('channel-subscriptions', 'ChannelPreferencesInput', { partial: true, relationships: { services: 'services' } }),
    rateLimit: perMinute(30),
    response: resource('channel-subscriptions', 'The subscription.'),
  },
  {
    method: 'DELETE',
    path: '/api/public/channel-subscriptions/:id',
    tag: 'Webhook and SMS subscriptions',
    summary: 'Unsubscribe a webhook or phone number',
    description: 'Queued messages are dropped.',
    access: 'subscriptionToken',
    pathParams: { id: id('Id of the subscription.') },
    rateLimit: perMinute(30),
    response: noContent('Unsubscribed.'),
  },

  // ---------------------------------------------------------------- Auth
  {
    method: 'GET',
    path: '/api/auth/config',
    tag: 'Auth',
    summary: 'Login options',
    access: 'anonymous',
    response: resource('auth-configs', 'The singleton `auth-configs/current`.', 'AuthConfig'),
  },
  {
    method: 'POST',
    path: '/api/auth/login',
    tag: 'Auth',
    summary: 'Log in with email and password',
    description:
      'An action, not a create: `200` with `sessions/current`, sets the cookie `osp_session` (httpOnly, sameSite=lax, secure with an https `BASE_URL`). Wrong credentials: `401` `invalid_credentials`; `403` when local login is disabled; `429` also after too many failed logins of an account.',
    access: 'anonymous',
    request: body('sessions', 'LoginInput', { example: { data: { type: 'sessions', attributes: { email: 'admin@example.com', password: '…' } } } }),
    rateLimit: perMinute(10),
    errors: [401, 403],
    response: resource('sessions', 'The session.', 'SessionInfo'),
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    tag: 'Auth',
    summary: 'Log out',
    description: 'Clears the cookie and deletes the session.',
    access: 'session',
    response: noContent('Logged out.'),
  },
  {
    method: 'GET',
    path: '/api/auth/session',
    tag: 'Auth',
    summary: 'The current session',
    access: 'session',
    response: resource('sessions', 'The session.', 'SessionInfo'),
  },
  {
    method: 'POST',
    path: '/api/auth/password',
    tag: 'Auth',
    summary: 'Change the own password',
    description: 'Every session of the user ends, the answer sets a new session cookie. A wrong current password is `400` `invalid_password`.',
    access: 'session',
    request: body('passwords', 'ChangePasswordInput', { enforced: false }),
    response: noContent('Changed, with a new session cookie.'),
  },
  {
    method: 'GET',
    path: '/api/auth/oidc/login',
    tag: 'Auth',
    summary: 'Single sign-on with the provider of the environment',
    description: '`302` to the identity provider (PKCE, state, nonce in a signed short-lived cookie). `404` without that provider. Not JSON:API.',
    access: 'anonymous',
    jsonapi: false,
    rateLimit: perMinute(30),
    response: { kind: 'redirect', status: 302, description: 'To the identity provider.' },
  },
  {
    method: 'GET',
    path: '/api/auth/oidc/callback',
    tag: 'Auth',
    summary: 'Callback of the provider of the environment',
    description: '`302` to `/admin` after login, or to `/admin/login?error=<code>`. Not JSON:API.',
    access: 'anonymous',
    jsonapi: false,
    rateLimit: perMinute(30),
    response: { kind: 'redirect', status: 302, description: 'To the management UI.' },
  },
  {
    method: 'GET',
    path: '/api/auth/oidc/:provider/login',
    tag: 'Auth',
    summary: 'Single sign-on with a provider of the management UI',
    description: '`404` for an id that is not a UUID, `302` with `error=oidc_unavailable` for an unknown or disabled one. Not JSON:API.',
    access: 'anonymous',
    jsonapi: false,
    pathParams: { provider: str({ format: 'uuid', description: 'Id of the SSO provider.' }) },
    rateLimit: perMinute(30),
    response: { kind: 'redirect', status: 302, description: 'To the identity provider.' },
  },
  {
    method: 'GET',
    path: '/api/auth/oidc/:provider/callback',
    tag: 'Auth',
    summary: 'Callback of a provider of the management UI',
    description: 'Only accepts a login state started at this provider (`error=invalid_state` otherwise). Not JSON:API.',
    access: 'anonymous',
    jsonapi: false,
    pathParams: { provider: str({ format: 'uuid', description: 'Id of the SSO provider.' }) },
    rateLimit: perMinute(30),
    response: { kind: 'redirect', status: 302, description: 'To the management UI.' },
  },

  // ---------------------------------------------------------------- Admin: overview and settings
  {
    method: 'GET',
    path: '/api/admin/overview',
    tag: 'Admin: overview and settings',
    summary: 'Dashboard',
    description: '`counts`, relationships `services` (non-operational first) and `recentAudit`, both included. Editors only see the audit entries of incidents and maintenance.',
    access: 'editor',
    response: resource('overviews', 'The singleton `overviews/current`.'),
  },
  {
    method: 'GET',
    path: '/api/admin/settings',
    tag: 'Admin: overview and settings',
    summary: 'Settings',
    access: 'editor',
    response: resource('settings', 'The singleton `settings/site`.', 'AdminPageSettings'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/settings',
    tag: 'Admin: overview and settings',
    summary: 'Change settings',
    access: 'admin',
    request: body('settings', 'SettingsInput', { partial: true }),
    response: resource('settings', 'The settings.', 'AdminPageSettings'),
  },
  {
    method: 'GET',
    path: '/api/admin/audit-log',
    tag: 'Admin: overview and settings',
    summary: 'Audit log',
    description: 'Newest first; relationship `user` (`null` for API tokens and deleted users).',
    access: 'admin',
    page: PAGE_20,
    filters: [filter('entityType', str({ minLength: 1, maxLength: 64 }), 'Only entries of this entity type.')],
    response: list('audit-entries', 'A page of audit entries.', 'AuditLogEntry'),
  },
  {
    method: 'GET',
    path: '/api/admin/instance',
    tag: 'Admin: overview and settings',
    summary: 'Instance information',
    access: 'editor',
    response: resource('instances', 'The singleton `instances/current` with `version`.'),
  },

  // ---------------------------------------------------------------- Admin: catalog
  ...catalog('locations', '/api/admin/locations', 'LocationInput', 'AdminLocation', 'location'),
  ...catalog('service-groups', '/api/admin/service-groups', 'ServiceGroupInput', 'AdminServiceGroup', 'service group'),
  {
    method: 'GET',
    path: '/api/admin/services',
    tag: 'Admin: catalog',
    summary: 'Services',
    description: 'In display order; relationships `group`, `locations`.',
    access: 'editor',
    response: list('services', 'The services.', 'AdminService'),
  },
  {
    method: 'POST',
    path: '/api/admin/services',
    tag: 'Admin: catalog',
    summary: 'Create a service',
    access: 'admin',
    request: body('services', 'ServiceInput', {
      relationships: { group: 'service-groups', locations: 'locations' },
      example: {
        data: {
          type: 'services',
          attributes: { name: 'Public API', kind: 'service' },
          relationships: {
            group: { data: { type: 'service-groups', id: '1b6f…' } },
            locations: { data: [{ type: 'locations', id: '9c2e…' }] },
          },
        },
      },
    }),
    errors: [409],
    response: created('services', 'AdminService'),
  },
  {
    method: 'POST',
    path: '/api/admin/services/reorder',
    tag: 'Admin: catalog',
    summary: 'Reorder services (within one group)',
    access: 'admin',
    request: ordering,
    response: noContent('Reordered.'),
  },
  {
    method: 'POST',
    path: '/api/admin/services/preview',
    tag: 'Admin: catalog',
    summary: 'Status of an unsaved service configuration',
    access: 'admin',
    request: body('services', 'ServiceInput', { enforced: false }),
    response: meta('`{ monitorStatus }`.', { monitorStatus: { type: 'string' } }),
  },
  {
    method: 'GET',
    path: '/api/admin/services/:id',
    tag: 'Admin: catalog',
    summary: 'A service',
    access: 'editor',
    pathParams: { id: id('Id of the service.') },
    response: resource('services', 'The service.', 'AdminService'),
  },
  {
    method: 'GET',
    path: '/api/admin/services/:id/preview',
    tag: 'Admin: catalog',
    summary: 'Status of a stored service configuration',
    access: 'editor',
    pathParams: { id: id('Id of the service.') },
    response: meta('`{ monitorStatus, status }`.', { monitorStatus: { type: 'string' }, status: { type: 'string' } }),
  },
  {
    method: 'PATCH',
    path: '/api/admin/services/:id',
    tag: 'Admin: catalog',
    summary: 'Change a service',
    access: 'admin',
    pathParams: { id: id('Id of the service.') },
    request: body('services', 'ServiceInput', { partial: true, relationships: { group: 'service-groups', locations: 'locations' } }),
    errors: [409],
    response: resource('services', 'The service.', 'AdminService'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/services/:id',
    tag: 'Admin: catalog',
    summary: 'Delete a service',
    access: 'admin',
    pathParams: { id: id('Id of the service.') },
    response: noContent('Deleted.'),
  },

  // ---------------------------------------------------------------- Admin: incidents
  {
    method: 'GET',
    path: '/api/admin/incidents',
    tag: 'Admin: incidents',
    summary: 'Incidents',
    description: 'Newest first; relationships `locations`, `updates`.',
    access: 'editor',
    include: UPDATES_INCLUDE,
    page: PAGE_20,
    filters: [filter('status', enumOf(['active', 'resolved', 'all'], { default: 'all' }))],
    response: list('incidents', 'A page of incidents.', 'AdminIncident'),
  },
  {
    method: 'POST',
    path: '/api/admin/incidents',
    tag: 'Admin: incidents',
    summary: 'Create an incident',
    access: 'editor',
    include: UPDATES_INCLUDE,
    request: body('incidents', 'IncidentCreateInput', {
      relationships: { locations: 'locations' },
      example: { data: { type: 'incidents', attributes: { title: 'Slow API', message: 'We are investigating.' } } },
    }),
    response: created('incidents', 'AdminIncident'),
  },
  {
    method: 'GET',
    path: '/api/admin/incidents/:id',
    tag: 'Admin: incidents',
    summary: 'An incident',
    access: 'editor',
    pathParams: { id: id('Id of the incident.') },
    include: UPDATES_INCLUDE,
    response: resource('incidents', 'The incident.', 'AdminIncident'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/incidents/:id',
    tag: 'Admin: incidents',
    summary: 'Change an incident',
    access: 'editor',
    pathParams: { id: id('Id of the incident.') },
    include: UPDATES_INCLUDE,
    request: body('incidents', 'IncidentPatchInput', { partial: true, relationships: { locations: 'locations' } }),
    response: resource('incidents', 'The incident.', 'AdminIncident'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/incidents/:id',
    tag: 'Admin: incidents',
    summary: 'Delete an incident',
    access: 'editor',
    pathParams: { id: id('Id of the incident.') },
    response: noContent('Deleted.'),
  },
  {
    method: 'POST',
    path: '/api/admin/incidents/:incidentId/updates',
    tag: 'Admin: incidents',
    summary: 'Post an update',
    description: 'Relationship `incident`; the incident with its new status is included.',
    access: 'editor',
    pathParams: { incidentId: id('Id of the incident.') },
    request: body('incident-updates', 'IncidentUpdateInput'),
    response: created('incident-updates'),
  },
  {
    method: 'GET',
    path: '/api/admin/incidents/:incidentId/updates/:id',
    tag: 'Admin: incidents',
    summary: 'An update',
    access: 'editor',
    pathParams: { incidentId: id('Id of the incident.'), id: id('Id of the update.') },
    response: resource('incident-updates', 'The update with the incident included.'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/incidents/:incidentId/updates/:id',
    tag: 'Admin: incidents',
    summary: 'Change an update',
    access: 'editor',
    pathParams: { incidentId: id('Id of the incident.'), id: id('Id of the update.') },
    request: body('incident-updates', 'IncidentUpdateEditInput', { partial: true }),
    response: resource('incident-updates', 'The update with the incident included.'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/incidents/:incidentId/updates/:id',
    tag: 'Admin: incidents',
    summary: 'Delete an update',
    description: 'Deleting the last update is `409`.',
    access: 'editor',
    pathParams: { incidentId: id('Id of the incident.'), id: id('Id of the update.') },
    errors: [409],
    response: noContent('Deleted.'),
  },

  // ---------------------------------------------------------------- Admin: maintenance
  {
    method: 'GET',
    path: '/api/admin/maintenances',
    tag: 'Admin: maintenance',
    summary: 'Maintenance windows',
    access: 'editor',
    include: UPDATES_INCLUDE,
    page: PAGE_20,
    filters: [filter('status', enumOf(['upcoming', 'active', 'past', 'all'], { default: 'all' }))],
    response: list('maintenances', 'A page of maintenance windows.', 'AdminMaintenance'),
  },
  {
    method: 'POST',
    path: '/api/admin/maintenances',
    tag: 'Admin: maintenance',
    summary: 'Schedule maintenance',
    access: 'editor',
    include: UPDATES_INCLUDE,
    request: body('maintenances', 'MaintenanceCreateInput', { relationships: { services: 'services', locations: 'locations' } }),
    response: created('maintenances', 'AdminMaintenance'),
  },
  {
    method: 'GET',
    path: '/api/admin/maintenances/:id',
    tag: 'Admin: maintenance',
    summary: 'A maintenance window',
    access: 'editor',
    pathParams: { id: id('Id of the maintenance window.') },
    include: UPDATES_INCLUDE,
    response: resource('maintenances', 'The maintenance window.', 'AdminMaintenance'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/maintenances/:id',
    tag: 'Admin: maintenance',
    summary: 'Change a maintenance window',
    access: 'editor',
    pathParams: { id: id('Id of the maintenance window.') },
    include: UPDATES_INCLUDE,
    request: body('maintenances', 'MaintenancePatchInput', { partial: true, relationships: { services: 'services', locations: 'locations' } }),
    response: resource('maintenances', 'The maintenance window.', 'AdminMaintenance'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/maintenances/:id',
    tag: 'Admin: maintenance',
    summary: 'Delete a maintenance window',
    access: 'editor',
    pathParams: { id: id('Id of the maintenance window.') },
    response: noContent('Deleted.'),
  },
  {
    method: 'POST',
    path: '/api/admin/maintenances/:maintenanceId/updates',
    tag: 'Admin: maintenance',
    summary: 'Post a maintenance update',
    access: 'editor',
    pathParams: { maintenanceId: id('Id of the maintenance window.') },
    request: body('maintenance-updates', 'MaintenanceUpdateInput'),
    response: created('maintenance-updates'),
  },
  {
    method: 'GET',
    path: '/api/admin/maintenances/:maintenanceId/updates/:id',
    tag: 'Admin: maintenance',
    summary: 'A maintenance update',
    access: 'editor',
    pathParams: { maintenanceId: id('Id of the maintenance window.'), id: id('Id of the update.') },
    response: resource('maintenance-updates', 'The update with the maintenance window included.'),
  },

  // ---------------------------------------------------------------- Admin: history corrections
  {
    method: 'GET',
    path: '/api/admin/corrections',
    tag: 'Admin: history corrections',
    summary: 'History corrections',
    description: 'Newest start first; relationship `services` (included with their `name`).',
    access: 'editor',
    include: { paths: ['services'], default: ['services'] },
    page: PAGE_20,
    filters: [
      filter('service', ID, 'Only corrections of this service.'),
      filter('from', TIMESTAMP, 'Only corrections overlapping [from, to).'),
      filter('to', TIMESTAMP, 'Only corrections overlapping [from, to).'),
    ],
    response: list('corrections', 'A page of corrections.', 'AdminCorrection'),
  },
  {
    method: 'POST',
    path: '/api/admin/corrections',
    tag: 'Admin: history corrections',
    summary: 'Create a correction',
    access: 'editor',
    include: { paths: ['services'], default: ['services'] },
    request: body('corrections', 'CorrectionInput', { relationships: { services: 'services' } }),
    response: created('corrections', 'AdminCorrection'),
  },
  {
    method: 'GET',
    path: '/api/admin/corrections/:id',
    tag: 'Admin: history corrections',
    summary: 'A correction',
    access: 'editor',
    pathParams: { id: id('Id of the correction.') },
    include: { paths: ['services'], default: ['services'] },
    response: resource('corrections', 'The correction.', 'AdminCorrection'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/corrections/:id',
    tag: 'Admin: history corrections',
    summary: 'Change a correction',
    access: 'editor',
    pathParams: { id: id('Id of the correction.') },
    include: { paths: ['services'], default: ['services'] },
    request: body('corrections', 'CorrectionPatchInput', { partial: true, relationships: { services: 'services' } }),
    response: resource('corrections', 'The correction.', 'AdminCorrection'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/corrections/:id',
    tag: 'Admin: history corrections',
    summary: 'Delete a correction',
    access: 'editor',
    pathParams: { id: id('Id of the correction.') },
    response: noContent('Deleted.'),
  },
  {
    method: 'GET',
    path: '/api/admin/services/:id/history',
    tag: 'Admin: history corrections',
    summary: 'Measured and corrected history of a service',
    description: '`filter[from]` and `filter[to]` are required, at most 366 days apart. The corrections and their services are included.',
    access: 'editor',
    pathParams: { id: id('Id of the service.') },
    filters: [
      { name: 'from', schema: TIMESTAMP, required: true, description: 'Start of the range.' },
      { name: 'to', schema: TIMESTAMP, required: true, description: 'End of the range (exclusive).' },
    ],
    response: resource('service-histories', 'The history (id = service id).', 'AdminServiceHistory'),
  },

  // ---------------------------------------------------------------- Admin: monitoring
  {
    method: 'GET',
    path: '/api/admin/monitor-sources',
    tag: 'Admin: monitoring',
    summary: 'Monitoring sources',
    access: 'admin',
    response: list('monitor-sources', 'The sources.', 'AdminMonitorSource'),
  },
  {
    method: 'POST',
    path: '/api/admin/monitor-sources',
    tag: 'Admin: monitoring',
    summary: 'Create a monitoring source',
    description: 'Only this answer carries the attribute `ingestToken`.',
    access: 'admin',
    request: body('monitor-sources', 'MonitorSourceInput'),
    response: created('monitor-sources', 'AdminMonitorSource'),
  },
  {
    method: 'GET',
    path: '/api/admin/monitor-sources/:id',
    tag: 'Admin: monitoring',
    summary: 'A monitoring source',
    access: 'admin',
    pathParams: { id: id('Id of the source.') },
    response: resource('monitor-sources', 'The source.', 'AdminMonitorSource'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/monitor-sources/:id',
    tag: 'Admin: monitoring',
    summary: 'Change a monitoring source',
    description: 'Secrets sent as `••••••••` keep the stored value (only while type, URL and username stay the same).',
    access: 'admin',
    pathParams: { id: id('Id of the source.') },
    request: body('monitor-sources', 'MonitorSourceInput', { partial: true }),
    response: resource('monitor-sources', 'The source.', 'AdminMonitorSource'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/monitor-sources/:id',
    tag: 'Admin: monitoring',
    summary: 'Delete a monitoring source',
    access: 'admin',
    pathParams: { id: id('Id of the source.') },
    response: noContent('Deleted.'),
  },
  {
    method: 'POST',
    path: '/api/admin/monitor-sources/:id/test',
    tag: 'Admin: monitoring',
    summary: 'Test the connection of a source',
    access: 'admin',
    pathParams: { id: id('Id of the source.') },
    response: meta('`MonitorSourceTestResult`.', { ok: { type: 'boolean' }, message: { type: 'string' }, checkCount: { type: 'integer' } }),
  },
  {
    method: 'POST',
    path: '/api/admin/monitor-sources/:id/poll',
    tag: 'Admin: monitoring',
    summary: 'Poll a source now',
    description: 'Stores the results. `400` for push-only sources.',
    access: 'admin',
    pathParams: { id: id('Id of the source.') },
    response: meta('`{ ok, message, checkCount? }`.', { ok: { type: 'boolean' }, message: { type: 'string' }, checkCount: { type: 'integer' } }),
  },
  {
    method: 'POST',
    path: '/api/admin/monitor-sources/:id/rotate-token',
    tag: 'Admin: monitoring',
    summary: 'Issue a new ingest token',
    access: 'admin',
    pathParams: { id: id('Id of the source.') },
    response: meta('`{ ingestToken }` (shown only here).', { ingestToken: { type: 'string' } }),
  },
  {
    method: 'GET',
    path: '/api/admin/checks',
    tag: 'Admin: monitoring',
    summary: 'Checks',
    description: 'Not paginated; `sourceType` is `bundle` for bundle checks.',
    access: 'editor',
    filters: [
      filter('source', ID, 'Only checks of this source.'),
      filter('q', str({ maxLength: 200 }), 'Name, host or external id contains.'),
      filter('state', enumOf(['ok', 'warning', 'critical', 'unknown'])),
      filter('unlinked', enumOf(['true', 'false']), 'Only checks no service uses.'),
    ],
    response: list('monitor-checks', 'The checks.', 'AdminMonitorCheck'),
  },
  {
    method: 'GET',
    path: '/api/admin/checks/:id',
    tag: 'Admin: monitoring',
    summary: 'A check',
    access: 'editor',
    pathParams: { id: id('Id of the check.') },
    response: resource('monitor-checks', 'The check.', 'AdminMonitorCheck'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/checks/:id',
    tag: 'Admin: monitoring',
    summary: 'Delete a check',
    description: '`409` for the check of a bundle (delete the bundle).',
    access: 'admin',
    pathParams: { id: id('Id of the check.') },
    errors: [409],
    response: noContent('Deleted.'),
  },
  {
    method: 'GET',
    path: '/api/admin/monitor-sources/:id/history-imports',
    tag: 'Admin: monitoring',
    summary: 'History imports of a source',
    description: 'The latest 20, newest first; `preview` is `null`.',
    access: 'admin',
    pathParams: { id: id('Id of the source.') },
    include: { paths: ['createdBy'], default: ['createdBy'] },
    response: list('history-imports', 'The imports.', 'AdminHistoryImport'),
  },
  {
    method: 'POST',
    path: '/api/admin/monitor-sources/:id/history-imports',
    tag: 'Admin: monitoring',
    summary: 'Start a history import',
    description: '`202` with `Location` and status `fetching`; the import continues in the background. Bodies up to about 10 MiB (CSV).',
    access: 'admin',
    pathParams: { id: id('Id of the source.') },
    include: { paths: ['createdBy'], default: ['createdBy'] },
    request: body('history-imports', 'HistoryImportCreateInput'),
    bodyLimit: 11 * 1024 * 1024,
    errors: [409],
    response: resource('history-imports', 'The import.', 'AdminHistoryImport', 202),
  },
  {
    method: 'GET',
    path: '/api/admin/monitor-sources/:id/history-imports/:importId',
    tag: 'Admin: monitoring',
    summary: 'A history import',
    description: 'With `progress`, `preview` (status `ready`) or `result`.',
    access: 'admin',
    pathParams: { id: id('Id of the source.'), importId: id('Id of the import.') },
    include: { paths: ['createdBy'], default: ['createdBy'] },
    response: resource('history-imports', 'The import.', 'AdminHistoryImport'),
  },
  {
    method: 'POST',
    path: '/api/admin/monitor-sources/:id/history-imports/:importId/apply',
    tag: 'Admin: monitoring',
    summary: 'Apply a history import',
    description: '`409` unless the import is `ready`.',
    access: 'admin',
    pathParams: { id: id('Id of the source.'), importId: id('Id of the import.') },
    include: { paths: ['createdBy'], default: ['createdBy'] },
    errors: [409],
    response: resource('history-imports', 'The import (status `applying`).', 'AdminHistoryImport', 202),
  },
  {
    method: 'POST',
    path: '/api/admin/monitor-sources/:id/history-imports/:importId/cancel',
    tag: 'Admin: monitoring',
    summary: 'Cancel a history import',
    description: 'Aborts `fetching`, discards `ready`; `409` otherwise.',
    access: 'admin',
    pathParams: { id: id('Id of the source.'), importId: id('Id of the import.') },
    include: { paths: ['createdBy'], default: ['createdBy'] },
    errors: [409],
    response: resource('history-imports', 'The import.', 'AdminHistoryImport'),
  },

  // ---------------------------------------------------------------- Admin: check bundles
  {
    method: 'GET',
    path: '/api/admin/check-bundles',
    tag: 'Admin: check bundles',
    summary: 'Check bundles',
    description: 'With the live vote and the per-member breakdown.',
    access: 'admin',
    response: list('check-bundles', 'The bundles.', 'AdminCheckBundle'),
  },
  {
    method: 'GET',
    path: '/api/admin/check-bundles/candidates',
    tag: 'Admin: check bundles',
    summary: 'Checks that can become members',
    description: 'Sources whose checks (relationship `checks`) are included.',
    access: 'admin',
    filters: [filter('sourceType', enumOf(['icinga2', 'uptimekuma', 'openitcockpit', 'webhook']), 'Only sources of this type.')],
    response: list('monitor-sources', 'The sources.', 'BundleCandidateSource'),
  },
  {
    method: 'POST',
    path: '/api/admin/check-bundles',
    tag: 'Admin: check bundles',
    summary: 'Create a check bundle',
    access: 'admin',
    request: body('check-bundles', 'CheckBundleInput'),
    response: created('check-bundles', 'AdminCheckBundle'),
  },
  {
    method: 'GET',
    path: '/api/admin/check-bundles/:id',
    tag: 'Admin: check bundles',
    summary: 'A check bundle',
    access: 'admin',
    pathParams: { id: id('Id of the bundle.') },
    response: resource('check-bundles', 'The bundle.', 'AdminCheckBundle'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/check-bundles/:id',
    tag: 'Admin: check bundles',
    summary: 'Change a check bundle',
    description: '`members` replaces the list.',
    access: 'admin',
    pathParams: { id: id('Id of the bundle.') },
    request: body('check-bundles', 'CheckBundleInput', { partial: true }),
    response: resource('check-bundles', 'The bundle.', 'AdminCheckBundle'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/check-bundles/:id',
    tag: 'Admin: check bundles',
    summary: 'Delete a check bundle',
    description: 'Removes the bundle check and its service links.',
    access: 'admin',
    pathParams: { id: id('Id of the bundle.') },
    response: noContent('Deleted.'),
  },

  // ---------------------------------------------------------------- Admin: users and API tokens
  {
    method: 'GET',
    path: '/api/admin/users',
    tag: 'Admin: users and API tokens',
    summary: 'Users',
    access: 'admin',
    response: list('users', 'The users, by name.', 'AdminUser'),
  },
  {
    method: 'POST',
    path: '/api/admin/users',
    tag: 'Admin: users and API tokens',
    summary: 'Create a user',
    access: 'admin',
    request: body('users', 'UserCreateInput'),
    errors: [409],
    response: created('users', 'AdminUser'),
  },
  {
    method: 'GET',
    path: '/api/admin/users/:id',
    tag: 'Admin: users and API tokens',
    summary: 'A user',
    access: 'admin',
    pathParams: { id: id('Id of the user.') },
    response: resource('users', 'The user.', 'AdminUser'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/users/:id',
    tag: 'Admin: users and API tokens',
    summary: 'Change a user',
    description: 'Demoting yourself or the last admin is `409`.',
    access: 'admin',
    pathParams: { id: id('Id of the user.') },
    request: body('users', 'UserUpdateInput', { partial: true }),
    errors: [409],
    response: resource('users', 'The user.', 'AdminUser'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/users/:id',
    tag: 'Admin: users and API tokens',
    summary: 'Delete a user',
    description: 'Deleting yourself or the last admin is `409`.',
    access: 'admin',
    pathParams: { id: id('Id of the user.') },
    errors: [409],
    response: noContent('Deleted.'),
  },
  {
    method: 'GET',
    path: '/api/admin/api-tokens',
    tag: 'Admin: users and API tokens',
    summary: 'API tokens',
    access: 'admin',
    response: list('api-tokens', 'The tokens, newest first.', 'AdminApiToken'),
  },
  {
    method: 'POST',
    path: '/api/admin/api-tokens',
    tag: 'Admin: users and API tokens',
    summary: 'Create an API token',
    description: 'Only this answer carries the attribute `token`.',
    access: 'admin',
    request: body('api-tokens', 'ApiTokenCreateInput'),
    response: created('api-tokens', 'AdminApiToken'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/api-tokens/:id',
    tag: 'Admin: users and API tokens',
    summary: 'Revoke an API token',
    access: 'admin',
    pathParams: { id: id('Id of the token.') },
    response: noContent('Revoked.'),
  },

  // ---------------------------------------------------------------- Admin: subscribers and notifications
  {
    method: 'GET',
    path: '/api/admin/subscribers',
    tag: 'Admin: subscribers and notifications',
    summary: 'Email subscribers',
    description: 'Newest first; relationship `services` (included with their `name`).',
    access: 'admin',
    page: PAGE_50,
    filters: [
      filter('q', str({ maxLength: 254 }), 'Address contains.'),
      filter('status', enumOf(['all', 'confirmed', 'pending'], { default: 'all' })),
    ],
    response: list('subscribers', 'A page of subscribers.'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/subscribers/:id',
    tag: 'Admin: subscribers and notifications',
    summary: 'Delete a subscriber',
    access: 'admin',
    pathParams: { id: id('Id of the subscriber.') },
    response: noContent('Deleted.'),
  },
  {
    method: 'GET',
    path: '/api/admin/notifications/status',
    tag: 'Admin: subscribers and notifications',
    summary: 'Mail transport and queue',
    access: 'admin',
    response: resource('notification-statuses', 'The singleton `notification-statuses/current`.'),
  },
  {
    method: 'POST',
    path: '/api/admin/notifications/test',
    tag: 'Admin: subscribers and notifications',
    summary: 'Send a test email',
    description: 'Sends immediately (not queued); `409` without a mail transport.',
    access: 'admin',
    request: body('test-emails', 'TestEmailInput', { enforced: false }),
    errors: [409],
    response: meta('`{ ok, message }`.', { ok: { type: 'boolean' }, message: { type: 'string' } }),
  },
  {
    method: 'POST',
    path: '/api/admin/notifications/retry-failed',
    tag: 'Admin: subscribers and notifications',
    summary: 'Queue failed emails again',
    access: 'admin',
    response: meta('`{ requeued }`.', { requeued: { type: 'integer' } }),
  },

  // ---------------------------------------------------------------- Admin: webhooks and SMS
  {
    method: 'GET',
    path: '/api/admin/webhooks',
    tag: 'Admin: webhooks and SMS',
    summary: 'Team webhooks',
    access: 'admin',
    response: list('webhooks', 'The webhooks (URL and header values are never returned).'),
  },
  {
    method: 'POST',
    path: '/api/admin/webhooks',
    tag: 'Admin: webhooks and SMS',
    summary: 'Create a team webhook',
    description: 'A generic webhook answers with `signingSecret` (only here).',
    access: 'admin',
    request: body('webhooks', 'WebhookInput', { relationships: { services: 'services' } }),
    response: created('webhooks'),
  },
  {
    method: 'GET',
    path: '/api/admin/webhooks/:id',
    tag: 'Admin: webhooks and SMS',
    summary: 'A team webhook',
    access: 'admin',
    pathParams: { id: id('Id of the webhook.') },
    response: resource('webhooks', 'The webhook.'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/webhooks/:id',
    tag: 'Admin: webhooks and SMS',
    summary: 'Change a team webhook',
    description: '`url` and `headers` left out keep their values; enabling resets the failures.',
    access: 'admin',
    pathParams: { id: id('Id of the webhook.') },
    request: body('webhooks', 'WebhookInput', { partial: true, relationships: { services: 'services' } }),
    response: resource('webhooks', 'The webhook.'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/webhooks/:id',
    tag: 'Admin: webhooks and SMS',
    summary: 'Delete a team webhook',
    description: 'With its delivery log.',
    access: 'admin',
    pathParams: { id: id('Id of the webhook.') },
    response: noContent('Deleted.'),
  },
  {
    method: 'POST',
    path: '/api/admin/webhooks/:id/test',
    tag: 'Admin: webhooks and SMS',
    summary: 'Send a test message',
    description: 'Sends now; logged as a delivery.',
    access: 'admin',
    pathParams: { id: id('Id of the webhook.') },
    response: meta('`{ ok, statusCode, message }`.', { ok: { type: 'boolean' }, statusCode: { type: ['integer', 'null'] }, message: { type: 'string' } }),
  },
  {
    method: 'POST',
    path: '/api/admin/webhooks/:id/rotate-secret',
    tag: 'Admin: webhooks and SMS',
    summary: 'Issue a new signing secret',
    description: 'Generic webhooks only; the new `signingSecret` is only in this answer.',
    access: 'admin',
    pathParams: { id: id('Id of the webhook.') },
    response: resource('webhooks', 'The webhook with `signingSecret`.'),
  },
  {
    method: 'POST',
    path: '/api/admin/webhooks/:id/retry-failed',
    tag: 'Admin: webhooks and SMS',
    summary: 'Queue failed deliveries again',
    access: 'admin',
    pathParams: { id: id('Id of the webhook.') },
    response: meta('`{ requeued }`.', { requeued: { type: 'integer' } }),
  },
  {
    method: 'GET',
    path: '/api/admin/webhooks/:id/deliveries',
    tag: 'Admin: webhooks and SMS',
    summary: 'Delivery log of a team webhook',
    access: 'admin',
    pathParams: { id: id('Id of the webhook.') },
    page: { defaultSize: 25, maxSize: 100 },
    response: list('webhook-deliveries', 'A page of deliveries, newest first.'),
  },
  {
    method: 'GET',
    path: '/api/admin/sms-provider',
    tag: 'Admin: webhooks and SMS',
    summary: 'SMS provider',
    description: 'The template; `usernameSet` and `passwordSet` instead of the credentials.',
    access: 'admin',
    response: resource('sms-provider', 'The singleton `sms-provider/current`.'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/sms-provider',
    tag: 'Admin: webhooks and SMS',
    summary: 'Change the SMS provider',
    description: '`username` and `password` left out are kept; `null` removes them.',
    access: 'admin',
    request: body('sms-provider', 'SmsProviderInput', { partial: true }),
    response: resource('sms-provider', 'The provider.'),
  },
  {
    method: 'GET',
    path: '/api/admin/sms-presets',
    tag: 'Admin: webhooks and SMS',
    summary: 'SMS provider presets',
    access: 'admin',
    response: list('sms-presets', 'The preset templates.'),
  },
  {
    method: 'POST',
    path: '/api/admin/sms-provider/test',
    tag: 'Admin: webhooks and SMS',
    summary: 'Send a test SMS',
    description: 'Sends now (counts toward the budget).',
    access: 'admin',
    request: body('sms-tests', 'SmsTestInput', { enforced: false }),
    response: meta('`{ ok, statusCode, message }`.', { ok: { type: 'boolean' }, statusCode: { type: ['integer', 'null'] }, message: { type: 'string' } }),
  },
  {
    method: 'GET',
    path: '/api/admin/sms-recipients',
    tag: 'Admin: webhooks and SMS',
    summary: 'On-call numbers',
    access: 'admin',
    response: list('sms-recipients', 'The numbers.'),
  },
  {
    method: 'POST',
    path: '/api/admin/sms-recipients',
    tag: 'Admin: webhooks and SMS',
    summary: 'Add an on-call number',
    access: 'admin',
    request: body('sms-recipients', 'SmsRecipientInput', { relationships: { services: 'services' } }),
    response: created('sms-recipients'),
  },
  {
    method: 'GET',
    path: '/api/admin/sms-recipients/:id',
    tag: 'Admin: webhooks and SMS',
    summary: 'An on-call number',
    access: 'admin',
    pathParams: { id: id('Id of the recipient.') },
    response: resource('sms-recipients', 'The recipient.'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/sms-recipients/:id',
    tag: 'Admin: webhooks and SMS',
    summary: 'Change an on-call number',
    access: 'admin',
    pathParams: { id: id('Id of the recipient.') },
    request: body('sms-recipients', 'SmsRecipientInput', { partial: true, relationships: { services: 'services' } }),
    response: resource('sms-recipients', 'The recipient.'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/sms-recipients/:id',
    tag: 'Admin: webhooks and SMS',
    summary: 'Delete an on-call number',
    access: 'admin',
    pathParams: { id: id('Id of the recipient.') },
    response: noContent('Deleted.'),
  },
  {
    method: 'GET',
    path: '/api/admin/channel-settings',
    tag: 'Admin: webhooks and SMS',
    summary: 'Webhook and SMS settings',
    access: 'admin',
    response: resource('channel-settings', 'The singleton `channel-settings/current`.'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/channel-settings',
    tag: 'Admin: webhooks and SMS',
    summary: 'Change the webhook and SMS settings',
    access: 'admin',
    request: body('channel-settings', 'ChannelSettingsInput', { partial: true }),
    response: resource('channel-settings', 'The settings.'),
  },
  {
    method: 'GET',
    path: '/api/admin/channel-subscribers',
    tag: 'Admin: webhooks and SMS',
    summary: 'Webhook and SMS subscribers',
    access: 'admin',
    page: PAGE_50,
    filters: [
      filter('channel', enumOf(['all', 'webhook', 'sms'], { default: 'all' })),
      filter('status', enumOf(['all', 'confirmed', 'pending'], { default: 'all' })),
    ],
    response: list('channel-subscribers', 'A page of subscribers (`target` masked).'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/channel-subscribers/:id',
    tag: 'Admin: webhooks and SMS',
    summary: 'Delete a webhook or SMS subscriber',
    description: 'With its queued messages.',
    access: 'admin',
    pathParams: { id: id('Id of the subscriber.') },
    response: noContent('Deleted.'),
  },

  // ---------------------------------------------------------------- Admin: private pages
  {
    method: 'GET',
    path: '/api/admin/private-pages',
    tag: 'Admin: private pages',
    summary: 'Private pages',
    access: 'admin',
    response: list('private-pages', 'The pages, newest first.'),
  },
  {
    method: 'POST',
    path: '/api/admin/private-pages',
    tag: 'Admin: private pages',
    summary: 'Create a private page',
    description: 'Only this answer carries `token` and `url`.',
    access: 'admin',
    request: body('private-pages', 'PrivatePageInput', { relationships: { services: 'services' } }),
    response: created('private-pages'),
  },
  {
    method: 'GET',
    path: '/api/admin/private-pages/:id',
    tag: 'Admin: private pages',
    summary: 'A private page',
    access: 'admin',
    pathParams: { id: id('Id of the page.') },
    response: resource('private-pages', 'The page.'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/private-pages/:id',
    tag: 'Admin: private pages',
    summary: 'Change a private page',
    description: 'The link stays the same.',
    access: 'admin',
    pathParams: { id: id('Id of the page.') },
    request: body('private-pages', 'PrivatePageInput', { partial: true, relationships: { services: 'services' } }),
    response: resource('private-pages', 'The page.'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/private-pages/:id',
    tag: 'Admin: private pages',
    summary: 'Delete a private page',
    description: 'The link stops working.',
    access: 'admin',
    pathParams: { id: id('Id of the page.') },
    response: noContent('Deleted.'),
  },
  {
    method: 'POST',
    path: '/api/admin/private-pages/:id/regenerate-token',
    tag: 'Admin: private pages',
    summary: 'Issue a new link',
    description: 'The old link stops working; the new `token` and `url` are only in this answer.',
    access: 'admin',
    pathParams: { id: id('Id of the page.') },
    response: resource('private-pages', 'The page with `token` and `url`.'),
  },

  // ---------------------------------------------------------------- Admin: SSO providers
  {
    method: 'GET',
    path: '/api/admin/oidc-providers',
    tag: 'Admin: SSO providers',
    summary: 'SSO providers',
    description: 'The provider of the environment (id `env`, read-only) first, then by `sortOrder` and name.',
    access: 'admin',
    response: list('oidc-providers', 'The providers (client secrets are never returned).', 'AdminOidcProvider'),
  },
  {
    method: 'POST',
    path: '/api/admin/oidc-providers',
    tag: 'Admin: SSO providers',
    summary: 'Add an SSO provider',
    description: 'At most 50 providers (`409`).',
    access: 'admin',
    request: body('oidc-providers', 'OidcProviderInput'),
    errors: [409],
    response: created('oidc-providers', 'AdminOidcProvider'),
  },
  {
    method: 'GET',
    path: '/api/admin/oidc-providers/:id',
    tag: 'Admin: SSO providers',
    summary: 'An SSO provider',
    access: 'admin',
    pathParams: { id: id('Id of the provider (`env` for the one of the environment).') },
    response: resource('oidc-providers', 'The provider.', 'AdminOidcProvider'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/oidc-providers/:id',
    tag: 'Admin: SSO providers',
    summary: 'Change an SSO provider',
    description: 'A new `issuerUrl` needs `clientSecret` in the same request when a secret is stored (`400` `secret_required`) and removes the links of users; `409` for `env`.',
    access: 'admin',
    pathParams: { id: id('Id of the provider.') },
    request: body('oidc-providers', 'OidcProviderInput', { partial: true }),
    errors: [409],
    response: resource('oidc-providers', 'The provider.', 'AdminOidcProvider'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/oidc-providers/:id',
    tag: 'Admin: SSO providers',
    summary: 'Remove an SSO provider',
    description: 'Also removes the links of users to it; `409` for `env`.',
    access: 'admin',
    pathParams: { id: id('Id of the provider.') },
    errors: [409],
    response: noContent('Removed.'),
  },
  {
    method: 'POST',
    path: '/api/admin/oidc-providers/test',
    tag: 'Admin: SSO providers',
    summary: 'Test the discovery of an unsaved issuer',
    access: 'admin',
    request: body('oidc-discovery-tests', 'OidcDiscoveryTestInput'),
    rateLimit: perMinute(10),
    response: meta('`OidcDiscoveryResult`.'),
  },
  {
    method: 'POST',
    path: '/api/admin/oidc-providers/:id/test',
    tag: 'Admin: SSO providers',
    summary: 'Test the discovery of a provider',
    access: 'admin',
    pathParams: { id: id('Id of the provider.') },
    rateLimit: perMinute(10),
    response: meta('`OidcDiscoveryResult`.'),
  },

  // ---------------------------------------------------------------- Admin: pages and images
  {
    method: 'GET',
    path: '/api/admin/pages',
    tag: 'Admin: pages and images',
    summary: 'Content pages',
    description: 'Every page, the four system pages first.',
    access: 'admin',
    response: list('pages', 'The pages.'),
  },
  {
    method: 'POST',
    path: '/api/admin/pages',
    tag: 'Admin: pages and images',
    summary: 'Create a custom page',
    description: '`409` when the slug is taken (also by a system page).',
    access: 'admin',
    request: body('pages', 'SitePageInput'),
    errors: [409],
    response: created('pages'),
  },
  {
    method: 'GET',
    path: '/api/admin/pages/:id',
    tag: 'Admin: pages and images',
    summary: 'A content page',
    access: 'admin',
    pathParams: { id: id('Id of the page.') },
    response: resource('pages', 'The page.'),
  },
  {
    method: 'PATCH',
    path: '/api/admin/pages/:id',
    tag: 'Admin: pages and images',
    summary: 'Change a content page',
    description: '`title`, `description` and `body` merge per language; a system page keeps its slug, path and placement.',
    access: 'admin',
    pathParams: { id: id('Id of the page.') },
    request: body('pages', 'SitePageInput', { partial: true }),
    errors: [409],
    response: resource('pages', 'The page.'),
  },
  {
    method: 'DELETE',
    path: '/api/admin/pages/:id',
    tag: 'Admin: pages and images',
    summary: 'Delete a custom page',
    description: '`409` for a system page (unpublish it instead).',
    access: 'admin',
    pathParams: { id: id('Id of the page.') },
    errors: [409],
    response: noContent('Deleted.'),
  },
  {
    method: 'GET',
    path: '/api/admin/uploads',
    tag: 'Admin: pages and images',
    summary: 'Uploaded images',
    access: 'admin',
    response: list('uploads', 'The images, newest first.'),
  },
  {
    method: 'POST',
    path: '/api/admin/uploads',
    tag: 'Admin: pages and images',
    summary: 'Upload an image',
    description:
      'The image bytes as `application/octet-stream` (no JSON:API document). `201` with the upload, `200` with the existing one for the same bytes, `413` above 1 MiB, `415` for anything but PNG, JPEG, WebP or ICO (by magic bytes; SVG is refused) or another `Content-Type`.',
    access: 'admin',
    query: [{ name: 'fileName', schema: str({ maxLength: 255 }), description: 'Original file name (for the list).', example: 'logo.png' }],
    request: { kind: 'binary', contentType: 'application/octet-stream', description: 'The image (PNG, JPEG, WebP or ICO), at most 1 MiB.' },
    rateLimit: perMinute(30),
    errors: [413, 415],
    response: {
      kind: 'resource',
      type: 'uploads',
      status: 201,
      description: 'The new upload, with a `Location` header.',
      existing: 'The existing upload with the same bytes (nothing new is stored).',
    },
  },
  {
    method: 'DELETE',
    path: '/api/admin/uploads/:id',
    tag: 'Admin: pages and images',
    summary: 'Delete an uploaded image',
    description: '`409` while the logo, the favicon or a content page uses it.',
    access: 'admin',
    pathParams: { id: id('Id of the upload.') },
    errors: [409],
    response: noContent('Deleted.'),
  },

  // ---------------------------------------------------------------- Ingest
  {
    method: 'POST',
    path: '/api/ingest/:sourceId',
    tag: 'Ingest',
    summary: 'Push check results (generic payload)',
    description:
      'Works for every source type. Numeric states: 0=ok, 1=warning, 2=critical, 3=unknown. `full: true` (remove checks missing from the payload) only for sources of type `webhook`; a full push that would remove more than half of the used checks is `409`. Source, token and rate limit are checked before the body is read.',
    access: 'ingest',
    pathParams: { sourceId: id('Id of the monitoring source.') },
    request: {
      kind: 'native',
      schema: 'GenericIngestPayload',
      contentTypes: ['application/json', 'text/plain'],
      description: 'The generic payload (JSON sent as `text/plain` is accepted, too).',
      example: { checks: [{ id: 'db1!pg', name: 'PostgreSQL', host: 'db1', state: 'critical', output: 'connection refused' }] },
    },
    bodyLimit: 5 * 1024 * 1024,
    rateLimit: { max: 120, window: '1 minute', per: 'monitoring source', routeConfig: false },
    errors: [409],
    response: meta('Counts of the push.', {
      created: { type: 'integer' },
      updated: { type: 'integer' },
      removed: { type: 'integer' },
      stateChanges: { type: 'integer' },
    }),
  },
  {
    method: 'POST',
    path: '/api/ingest/:sourceId/:type',
    tag: 'Ingest',
    summary: 'Push check results (native payload)',
    description:
      'The native payload of a monitoring system: the Uptime Kuma webhook notification, the bundled Icinga 2 notification script or the bundled openITCockpit notification command (see docs/adapters).',
    access: 'ingest',
    pathParams: { sourceId: id('Id of the monitoring source.'), type: enumOf(['uptimekuma', 'icinga2', 'openitcockpit'], { description: 'Payload format; must match the type of the source.' }) },
    request: { kind: 'native', contentTypes: ['application/json', 'text/plain'], description: 'The native payload of the monitoring system.' },
    bodyLimit: 5 * 1024 * 1024,
    rateLimit: { max: 120, window: '1 minute', per: 'monitoring source', routeConfig: false },
    response: meta('Counts of the push.', {
      created: { type: 'integer' },
      updated: { type: 'integer' },
      removed: { type: 'integer' },
      stateChanges: { type: 'integer' },
    }),
  },
];

/** List, create, reorder, read, change and delete of a catalog collection (locations, service groups). */
function catalog(type: string, base: string, schema: string, attributes: string, noun: string): Operation[] {
  const tag: TagName = 'Admin: catalog';
  const plural = `${noun[0]!.toUpperCase()}${noun.slice(1)}s`;
  const one = { id: id(`Id of the ${noun}.`) };
  return [
    { method: 'GET', path: base, tag, summary: plural, description: 'In display order.', access: 'editor', response: list(type, `The ${noun}s.`, attributes) },
    { method: 'POST', path: base, tag, summary: `Create a ${noun}`, access: 'admin', request: body(type, schema), errors: [409], response: created(type, attributes) },
    { method: 'POST', path: `${base}/reorder`, tag, summary: `Reorder ${noun}s`, access: 'admin', request: ordering, response: noContent('Reordered.') },
    { method: 'GET', path: `${base}/:id`, tag, summary: `A ${noun}`, access: 'editor', pathParams: one, response: resource(type, `The ${noun}.`, attributes) },
    {
      method: 'PATCH',
      path: `${base}/:id`,
      tag,
      summary: `Change a ${noun}`,
      access: 'admin',
      pathParams: one,
      request: body(type, schema, { partial: true }),
      errors: [409],
      response: resource(type, `The ${noun}.`, attributes),
    },
    { method: 'DELETE', path: `${base}/:id`, tag, summary: `Delete a ${noun}`, access: 'admin', pathParams: one, response: noContent('Deleted.') },
  ];
}
