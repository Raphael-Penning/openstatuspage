/**
 * Fake public API for the accessibility tests: one of everything the public
 * pages can show (groups, sites, all statuses, incidents, maintenance,
 * locations with and without coordinates, a subscription).
 */
import type {
  DailyUptime,
  HistoryItem,
  Paginated,
  PublicIncident,
  PublicLocation,
  PublicLocationsResponse,
  PublicMaintenance,
  PublicPageSettings,
  PublicSiteExtras,
  PublicSitePage,
  PublicPrivatePage,
  PublicService,
  PublicServiceDay,
  PublicServiceGroup,
  PublicChannelSubscription,
  PublicSubscription,
  PublicSummary,
  ServiceStatus,
} from '@openstatuspage/shared';
import {
  historyDocument,
  incidentDocument,
  locationsDocument,
  maintenanceDocument,
  privatePageDocument,
  serviceDayDocument,
  serviceDocument,
  servicesDocument,
  settingsDocument,
  sitePageDocument,
  summaryDocument,
  subscribeAcceptedDocument,
  subscriptionDocument,
  channelSubscriptionDocument,
} from './documents';

const DAY = 86_400_000;
const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

export const settings: PublicPageSettings = {
  siteName: 'Example Status',
  description: 'Status of the Example services.',
  logoUrl: null,
  faviconUrl: null,
  accentColor: '#7c6cf2',
  defaultLocale: 'en',
  defaultTheme: 'system',
  footerLinks: [{ label: 'Imprint', url: 'https://example.com/imprint' }],
  supportUrl: 'https://example.com/support',
  showLocations: true,
  showUptime: true,
  uptimeDays: 90,
  recentIncidentDays: 7,
  emailSubscriptionsEnabled: true,
  maintenanceReminderHours: 24,
  // Every footer and navigation link is shown, so every page checks them.
  imprintUrl: 'https://example.com/imprint',
  imprintLabel: '',
  privacyUrl: 'https://example.com/privacy',
  privacyLabel: 'Privacy',
  accessibilityUrl: 'https://example.com/accessibility',
  accessibilityLabel: '',
  copyrightText: '© {year} Example GmbH',
  brandUrl: 'https://example.com/',
  showPoweredBy: true,
  infoLinkUrl: '/about',
  infoLinkLabel: 'What does the status mean?',
  utmEnabled: true,
  utmSource: 'status',
  utmMedium: 'referral',
  utmCampaign: 'statuspage',
  // Analytics runs, so every page also checks the statistics choice of the footer.
  analyticsEnabled: true,
  analyticsWebsiteId: '4f3c2b1a-1234-4abc-8def-0123456789ab',
  analyticsDomains: '',
  analyticsRespectDnt: true,
  analyticsForwardIp: false,
};

function uptime(pattern: (i: number) => ServiceStatus | null): DailyUptime[] {
  return Array.from({ length: 90 }, (_, i) => {
    const status = pattern(i);
    const date = new Date(now - (89 - i) * DAY).toISOString().slice(0, 10);
    if (status === null) return { date, status, uptime: null, minutes: {} };
    if (status === 'operational') return { date, status, uptime: 100, minutes: {} };
    const outage = status === 'partial_outage' || status === 'major_outage';
    return { date, status, uptime: outage ? 97.5 : 100, minutes: { [status]: 36 } };
  });
}

const STATUSES: ServiceStatus[] = ['operational', 'maintenance', 'degraded', 'partial_outage', 'major_outage'];

function service(id: string, name: string, status: ServiceStatus, extra: Partial<PublicService> = {}): PublicService {
  return {
    id,
    slug: id,
    name,
    description: null,
    kind: 'service',
    url: null,
    groupId: 'grp-core',
    status,
    locationIds: ['loc-fra'],
    uptimePercent: 99.5,
    uptime: uptime((i) => (i < 10 ? null : i % 17 === 0 ? STATUSES[i % 5]! : 'operational')),
    ...extra,
  };
}

const api = service('api', 'API', 'degraded', { description: 'Public REST API.' });
const web = service('website', 'Website', 'operational', {
  kind: 'site',
  url: 'https://www.example.com',
  groupId: 'grp-web',
});
const mail = service('mail', 'Mail', 'major_outage', { groupId: null });

export const groups: PublicServiceGroup[] = [
  {
    id: 'grp-core',
    slug: 'core',
    name: 'Core platform',
    description: 'Everything our customers build on.',
    collapsedByDefault: false,
    status: 'degraded',
    services: [api],
  },
  {
    id: 'grp-web',
    slug: 'web',
    name: 'Websites',
    description: null,
    collapsedByDefault: true,
    status: 'operational',
    services: [web],
  },
];
export const ungrouped = [mail];

export const incident: PublicIncident = {
  id: 'inc-1',
  title: 'Elevated API error rates',
  status: 'identified',
  impact: 'major',
  startedAt: iso(-3 * 3_600_000),
  resolvedAt: null,
  updatedAt: iso(-3_600_000),
  affectedServices: [{ id: 'api', name: 'API', status: 'degraded' }],
  locationIds: ['loc-fra'],
  updates: [
    { id: 'u-2', status: 'identified', message: 'A faulty deployment was found.\nA rollback is running.', createdAt: iso(-3_600_000) },
    { id: 'u-1', status: 'investigating', message: 'We are looking into errors.', createdAt: iso(-3 * 3_600_000) },
  ],
};

export const resolvedIncident: PublicIncident = {
  ...incident,
  id: 'inc-0',
  title: 'Slow logins',
  status: 'resolved',
  impact: 'minor',
  startedAt: iso(-2 * DAY),
  resolvedAt: iso(-2 * DAY + 3_600_000),
  updatedAt: iso(-2 * DAY + 3_600_000),
  updates: [{ id: 'u-0', status: 'resolved', message: 'Fixed.', createdAt: iso(-2 * DAY + 3_600_000) }],
};

export const maintenance: PublicMaintenance = {
  id: 'm-1',
  title: 'Database upgrade',
  description: 'Short read-only window.',
  status: 'in_progress',
  scheduledStart: iso(-3_600_000),
  scheduledEnd: iso(3_600_000),
  actualStart: iso(-3_600_000),
  actualEnd: null,
  affectedServices: [{ id: 'api', name: 'API' }],
  locationIds: ['loc-fra'],
  updates: [{ id: 'mu-1', status: 'in_progress', message: '', createdAt: iso(-3_600_000) }],
  createdAt: iso(-DAY),
  updatedAt: iso(-3_600_000),
};

const upcoming: PublicMaintenance = {
  ...maintenance,
  id: 'm-2',
  title: 'Network switch replacement',
  status: 'scheduled',
  scheduledStart: iso(2 * DAY),
  scheduledEnd: iso(2 * DAY + 7_200_000),
  actualStart: null,
  updates: [],
};

export const summary: PublicSummary = {
  page: settings,
  overall: 'major_outage',
  groups,
  ungrouped,
  activeIncidents: [incident],
  recentIncidents: [resolvedIncident],
  activeMaintenances: [maintenance],
  upcomingMaintenances: [upcoming],
  emailSubscriptions: true,
  channelSubscriptions: { webhookKinds: ['discord', 'slack', 'teams', 'generic'], sms: true, smsCallingCodes: ['49', '43'] },
  generatedAt: iso(-60_000),
};

const counts: Record<ServiceStatus, number> = {
  operational: 1,
  maintenance: 0,
  degraded: 1,
  partial_outage: 0,
  major_outage: 1,
};

const location = (id: string, name: string, status: ServiceStatus, extra: Partial<PublicLocation>): PublicLocation => ({
  id,
  slug: id,
  name,
  code: null,
  city: null,
  country: null,
  region: 'europe',
  latitude: null,
  longitude: null,
  description: null,
  status,
  serviceIds: ['api'],
  ...extra,
});

export const locations: PublicLocationsResponse = {
  locations: [
    location('loc-fra', 'Frankfurt', 'operational', { code: 'FRA1', city: 'Frankfurt am Main', country: 'DE', latitude: 50.11, longitude: 8.68 }),
    location('loc-ams', 'Amsterdam', 'degraded', { code: 'AMS1', city: 'Amsterdam', country: 'NL', latitude: 52.37, longitude: 4.9 }),
    location('loc-nyc', 'New York', 'major_outage', { region: 'north_america', city: 'New York', country: 'US', latitude: 40.71, longitude: -74.0 }),
    location('loc-edge', 'Edge network', 'maintenance', { region: 'north_america', description: 'Distributed edge nodes.' }),
  ],
  counts,
};

export const history: Paginated<HistoryItem> = {
  items: [
    { type: 'incident', date: incident.startedAt, incident },
    { type: 'maintenance', date: maintenance.scheduledStart, maintenance },
    { type: 'incident', date: resolvedIncident.startedAt, incident: resolvedIncident },
  ],
  total: 45,
  page: 1,
  pageSize: 20,
};

export const subscription: PublicSubscription = {
  id: 'sub-1',
  email: 'jane@example.com',
  locale: 'en',
  allServices: false,
  serviceIds: ['api'],
  confirmed: true,
};

export const SUBSCRIPTION_TOKEN = 'token-0123456789abcdef';

/** A confirmed generic webhook subscription (manage page of /subscription/channel). */
export const channelSubscription: PublicChannelSubscription = {
  id: 'ch-1',
  channel: 'webhook',
  webhookKind: 'generic',
  target: 'hooks.example.com/…',
  locale: 'en',
  allServices: false,
  serviceIds: ['api'],
  confirmed: true,
  signingSecret: 'whsec_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG',
};

export const CHANNEL_TOKEN = 'chtoken0123456789abcde';

/**
 * A day of the API in detail (GET /api/public/services/api/days/:date): any day
 * of its bar answers, the oldest without data, every other one with an outage
 * at noon that a public correction shortened, and today with an incident and a
 * running maintenance window.
 */
export function apiDay(date: string): PublicServiceDay | null {
  const index = (api.uptime ?? []).findIndex((d) => d.date === date);
  if (index < 0) return null;
  const bucket = api.uptime![index]!;
  const start = Date.parse(`${date}T00:00:00.000Z`);
  const at = (h: number) => new Date(start + h * 3_600_000).toISOString();
  const today = index === api.uptime!.length - 1;
  const segments: PublicServiceDay['segments'] =
    bucket.status === null
      ? []
      : today
        ? [{ status: 'operational', startedAt: at(0), endedAt: null }]
        : [
            { status: 'operational', startedAt: at(0), endedAt: at(11) },
            { status: 'operational', startedAt: at(11), endedAt: at(12), corrected: true },
            { status: 'major_outage', startedAt: at(12), endedAt: at(12.6) },
            { status: 'degraded', startedAt: at(12.6), endedAt: at(13) },
            { status: 'operational', startedAt: at(13), endedAt: at(24) },
          ];
  return {
    id: `api:${date}`,
    ...bucket,
    ...(bucket.status !== null && !today ? { corrected: true as const, correctionNotes: ['False alarm of the monitoring.'] } : {}),
    startsAt: at(0),
    endsAt: at(24),
    complete: !today,
    segments,
    previousDate: index > 0 ? api.uptime![index - 1]!.date : null,
    nextDate: today ? null : api.uptime![index + 1]!.date,
  };
}

/** The newest day of the API's bar (today) and the one before. */
export const API_TODAY = api.uptime![api.uptime!.length - 1]!.date;
export const API_YESTERDAY = api.uptime![api.uptime!.length - 2]!.date;

/** Token of the private page of the fake API (/p/<token>). */
export const PRIVATE_TOKEN = 'abcdefghijklmnopqrstuvwxyz234567';

/** A service hidden from the main page, shown on the private page. */
const backend = service('backend', 'Partner backend', 'partial_outage', { groupId: null, locationIds: [] });

export const privatePage: PublicPrivatePage = {
  id: 'pp-1',
  name: 'ACME status',
  description: 'The services we run for ACME.',
  overall: 'partial_outage',
  counts: { operational: 0, degraded: 1, partial_outage: 1, major_outage: 0, maintenance: 0 },
  generatedAt: iso(0),
  services: [backend, { ...api, groupId: null, locationIds: [] }],
  activeIncidents: [incident],
  activeMaintenances: [maintenance],
  upcomingMaintenances: [],
};

/** Response of the fake API for a request, or null for "not found". */
const UPLOAD = `/uploads/${'a'.repeat(64)}.png`;

/** Published content pages: the accessibility statement and a custom page (footer and navigation). */
export const sitePages: PublicSitePage[] = [
  {
    id: 'page-accessibility',
    systemKey: 'accessibility',
    slug: 'accessibility',
    path: '/accessibility',
    title: { en: 'Accessibility statement', de: 'Erklärung zur Barrierefreiheit' },
    description: { en: 'How accessible this status page is.', de: '' },
    body: {
      en: [
        '# Our commitment',
        '',
        'We want this page to be usable by **everyone**. Contact [our team](mailto:a11y@example.com) or read the [WCAG](https://www.w3.org/TR/WCAG22/).',
        '',
        '## Known limitations',
        '',
        '- The world map is decorative.',
        '- Older reports may lack descriptions.',
        '',
        '| Criterion | Status |',
        '| --- | --- |',
        '| 1.4.3 Contrast | Met |',
        '',
        `![Diagram of the status page](${UPLOAD})`,
        '',
        '<script>alert(1)</script>',
      ].join('\n'),
      // No German text: the English one is shown, marked with lang="en".
      de: '',
    },
    images: { [UPLOAD]: { width: 640, height: 320 } },
    createdAt: iso(-30 * DAY),
    updatedAt: iso(-2 * DAY),
  },
  {
    id: 'page-faq',
    systemKey: null,
    slug: 'faq',
    path: '/pages/faq',
    title: { en: 'FAQ', de: 'Häufige Fragen' },
    description: { en: '', de: '' },
    body: { en: 'How often is the status updated?\n\nEvery minute.', de: 'Wie oft wird der Status aktualisiert?\n\nJede Minute.' },
    images: {},
    createdAt: iso(-10 * DAY),
    updatedAt: iso(-10 * DAY),
  },
];

/** The settings document: the settings plus the links of the published pages. */
export const siteSettings: PublicPageSettings & PublicSiteExtras = {
  ...settings,
  pages: [
    { systemKey: 'accessibility', slug: 'accessibility', path: '/accessibility', title: sitePages[0]!.title, showInFooter: false, showInNav: false, sortOrder: 3 },
    { systemKey: null, slug: 'faq', path: '/pages/faq', title: sitePages[1]!.title, showInFooter: true, showInNav: true, sortOrder: 10 },
  ],
  logoSize: null,
};

export function respond(method: string, path: string, headers: Headers = new Headers()): { status: number; body: unknown } {
  const ok = (body: unknown) => ({ status: 200, body });
  if (method === 'GET' && path.startsWith('/api/public/private-page') && headers.get('x-private-page-token') === PRIVATE_TOKEN) {
    if (path === '/api/public/private-page') return ok(privatePageDocument(privatePage));
    if (path === '/api/public/private-page/services/backend') return ok(serviceDocument(backend, [incident], []));
    if (path === '/api/public/private-page/incidents/inc-1') return ok(incidentDocument(incident));
    if (path === '/api/public/private-page/maintenances/m-1') return ok(maintenanceDocument(maintenance));
    const day = /^\/api\/public\/private-page\/services\/api\/days\/([^/]+)$/.exec(path);
    const detail = day ? apiDay(decodeURIComponent(day[1]!)) : null;
    if (detail) return ok(serviceDayDocument(detail, api, [resolvedIncident], []));
  }
  if (method === 'GET') {
    if (path === '/api/public/settings') return ok(settingsDocument(siteSettings));
    const sitePage = sitePages.find((p) => path === `/api/public/pages/${p.slug}`);
    if (sitePage) return ok(sitePageDocument(sitePage));
    if (path === '/api/public/summary') return ok(summaryDocument(summary));
    if (path === '/api/public/services') return ok(servicesDocument(groups, ungrouped, counts));
    if (path === '/api/public/services/api') return ok(serviceDocument(api, [incident, resolvedIncident], [maintenance]));
    const day = /^\/api\/public\/services\/api\/days\/([^/]+)$/.exec(path);
    if (day) {
      const detail = apiDay(decodeURIComponent(day[1]!));
      if (detail) {
        const today = detail.nextDate === null;
        return ok(serviceDayDocument(detail, api, today ? [incident] : [resolvedIncident], today ? [maintenance] : []));
      }
    }
    if (path === '/api/public/locations') return ok(locationsDocument(locations.locations, locations.counts));
    if (path === '/api/public/incidents/inc-1') return ok(incidentDocument(incident));
    if (path === '/api/public/maintenances/m-1') return ok(maintenanceDocument(maintenance));
    if (path === '/api/public/history') return ok(historyDocument(history));
    if (path === '/api/public/subscriptions/sub-1') return ok(subscriptionDocument(subscription));
    if (path === '/api/public/channel-subscriptions/ch-1' && headers.get('x-subscription-token') === CHANNEL_TOKEN) {
      return ok(channelSubscriptionDocument(channelSubscription));
    }
  }
  if (method === 'POST' && path === '/api/public/subscriptions/sub-1/confirm') {
    return ok(subscriptionDocument(subscription, SUBSCRIPTION_TOKEN));
  }
  if (method === 'POST' && path === '/api/public/subscriptions') return { status: 202, body: subscribeAcceptedDocument };
  return {
    status: 404,
    body: { jsonapi: { version: '1.1' }, errors: [{ status: '404', code: 'not_found', title: 'Not Found', detail: 'Not found' }] },
  };
}
