/**
 * Files for search engines and AI agents (every role that serves the public web client):
 *
 *   /robots.txt                 public and all: the public pages, without the API, the
 *                               management UI and the personal subscription links, plus the
 *                               sitemap. admin: `Disallow: /` (a preview, not the status page).
 *   /sitemap.xml                sitemap index (public and all) of:
 *   /sitemap-pages.xml            the navigation pages,
 *   /sitemap-incidents-N.xml      public incidents and maintenance windows (lastmod),
 *   /sitemap-services-N.xml       public service pages (lastmod),
 *                               at most SITEMAP_PAGE_SIZE URLs per file.
 *   /llms.txt                   summary of the page for language models (https://llmstxt.org)
 *   /llms-full.txt              the current status as Markdown.
 *
 * URLs are absolute with the effective PUBLIC_BASE_URL; the data is public data only
 * (services/site-index.ts). Not JSON:API: these are fixed formats for crawlers.
 */
import { overallStatus, type IncidentImpact, type IncidentStatus, type MaintenanceStatus, type PublicIncident, type PublicMaintenance, type PublicService, type ServiceStatus } from '@openstatuspage/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { notFound } from '../lib/errors.js';
import { escapeXml } from '../lib/xml.js';
import type { AppRole } from '../role.js';
import { SITEMAP_PAGE_SIZE, SiteIndex, type CurrentStatus, type SitemapKind, type SitemapUrl } from '../services/site-index.js';

/**
 * Paths crawlers must not request: the API (also the subscription and
 * one-click unsubscribe endpoints), the management UI and the personal
 * subscription links (confirm, manage, unsubscribe). Form handlers outside
 * /api/ belong here as well.
 */
export const DISALLOWED_PATHS = ['/api/', '/admin', '/subscription/'];

const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

const CACHE = {
  robots: 'public, max-age=3600',
  sitemap: 'public, max-age=900',
  llms: 'public, max-age=300',
  /** The current status changes any minute. */
  llmsFull: 'public, max-age=60',
};

// --- robots.txt ---------------------------------------------------------------

export function renderRobots(role: AppRole, baseUrl: string): string {
  if (role === 'admin') {
    return ['# Management instance: the public status page is served elsewhere.', 'User-agent: *', 'Disallow: /', ''].join('\n');
  }
  return [
    '# Public status page. A summary for language models: ' + `${baseUrl}/llms.txt`,
    'User-agent: *',
    'Allow: /',
    ...DISALLOWED_PATHS.map((path) => `Disallow: ${path}`),
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`,
    '',
  ].join('\n');
}

// --- Sitemaps -------------------------------------------------------------------

const sitemapPath = (kind: SitemapKind, page: number) => `/sitemap-${kind}-${page}.xml`;

export function renderSitemapIndex(baseUrl: string, paths: string[]): string {
  const entries = paths.map((path) => `  <sitemap><loc>${escapeXml(baseUrl + path)}</loc></sitemap>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="${SITEMAP_NS}">\n${entries.join('\n')}\n</sitemapindex>\n`;
}

export function renderUrlset(baseUrl: string, urls: SitemapUrl[]): string {
  const entries = urls.map((u) => {
    const lastmod = u.lastmod ? `<lastmod>${escapeXml(u.lastmod)}</lastmod>` : '';
    return `  <url><loc>${escapeXml(baseUrl + u.path)}</loc>${lastmod}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${SITEMAP_NS}">\n${entries.join('\n')}\n</urlset>\n`;
}

/** Number of files of a sub-sitemap with `count` URLs (none when empty). */
export const sitemapPages = (count: number) => Math.ceil(count / SITEMAP_PAGE_SIZE);

// --- llms.txt -------------------------------------------------------------------

const STATUS: Record<ServiceStatus, string> = {
  operational: 'Operational',
  maintenance: 'Under maintenance',
  degraded: 'Degraded performance',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
};
const INCIDENT_STATUS: Record<IncidentStatus, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};
const IMPACT: Record<IncidentImpact, string> = { none: 'None', minor: 'Minor', major: 'Major', critical: 'Critical' };
const MAINTENANCE_STATUS: Record<MaintenanceStatus, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** One line of plain text (admin input): no line breaks, no Markdown link syntax. */
function inline(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\[\]])/g, '\\$1');
}

/** Admin text as a Markdown block quote: it cannot start a heading or a list of its own. */
function quote(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
}

const link = (label: string, url: string) => `[${inline(label)}](${url})`;

export interface LlmsInput {
  baseUrl: string;
  siteName: string;
  description: string;
  serviceCount: number;
  showLocations: boolean;
  emailSubscriptions: boolean;
}

export function renderLlms(i: LlmsInput): string {
  const u = (path: string) => `${i.baseUrl}${path}`;
  const summary = i.description.trim() || `Current status, incidents and maintenance of ${i.siteName}.`;
  const lines = [
    `# ${inline(i.siteName)}`,
    '',
    `> ${inline(summary)}`,
    '',
    `This is the public status page of ${inline(i.siteName)} with ${i.serviceCount} public ` +
      `${i.serviceCount === 1 ? 'service' : 'services'}. It shows the current status of every service, ` +
      'active incidents, scheduled maintenance and the history of past incidents. Times are UTC (ISO 8601). ' +
      `The current status as Markdown: ${u('/llms-full.txt')}.`,
    '',
    '## Pages',
    '',
    `- ${link('Current status', u('/'))}: Overall status, active incidents, maintenance and all services`,
    `- ${link('Services', u('/services'))}: Every public service with its status and uptime`,
    `- ${link('History', u('/history'))}: Past incidents and maintenance windows, newest first`,
    ...(i.showLocations ? [`- ${link('Locations', u('/locations'))}: Status by location`] : []),
    ...(i.emailSubscriptions ? [`- ${link('Email notifications', u('/subscribe'))}: Subscribe to incident and maintenance emails`] : []),
    '',
    '## API',
    '',
    'Read-only JSON:API 1.1 (https://jsonapi.org/format/1.1/), media type `application/vnd.api+json`, no authentication.',
    '',
    `- ${link('Status', u('/api/public/status'))}: Overall status, services, active incidents and maintenance`,
    `- ${link('Summary', u('/api/public/summary'))}: Everything the overview page shows`,
    `- ${link('Services', u('/api/public/services'))}: Public services with status and uptime`,
    `- ${link('History', u('/api/public/history'))}: Incidents and maintenance, paginated with \`page[number]\`, filtered with \`filter[type]\`, \`filter[service]\`, \`filter[month]\``,
    '',
    '## Feeds',
    '',
    `- ${link('RSS feed', u('/feed.rss'))}: The latest incidents and maintenance windows`,
    `- ${link('Atom feed', u('/feed.atom'))}: The same as Atom`,
    '',
    '## Optional',
    '',
    `- ${link('Current status in Markdown', u('/llms-full.txt'))}: Services, active incidents and upcoming maintenance`,
    `- ${link('Sitemap', u('/sitemap.xml'))}: Every public page, incident and service`,
    '',
  ];
  return lines.join('\n');
}

function serviceLine(baseUrl: string, s: PublicService, showUptime: boolean): string {
  const url = `${baseUrl}/services/${encodeURIComponent(s.slug || s.id)}`;
  const uptime = showUptime && s.uptimePercent !== null ? ` (uptime ${s.uptimePercent.toFixed(2)} %)` : '';
  return `- ${link(s.name, url)}: ${STATUS[s.status]}${uptime}`;
}

function incidentBlock(baseUrl: string, inc: PublicIncident): string[] {
  const affected = inc.affectedServices.map((s) => `${inline(s.name)} (${STATUS[s.status]})`).join(', ');
  const latest = inc.updates[0];
  return [
    `### ${link(inc.title, `${baseUrl}/incidents/${encodeURIComponent(inc.id)}`)}`,
    '',
    `- Status: ${INCIDENT_STATUS[inc.status]}`,
    `- Impact: ${IMPACT[inc.impact]}`,
    `- Started: ${inc.startedAt}`,
    `- Last update: ${inc.updatedAt}`,
    ...(affected ? [`- Affected services: ${affected}`] : []),
    ...(latest?.message ? ['', `Latest update (${latest.createdAt}, ${INCIDENT_STATUS[latest.status]}):`, '', quote(latest.message)] : []),
    '',
  ];
}

function maintenanceBlock(baseUrl: string, m: PublicMaintenance): string[] {
  const affected = m.affectedServices.map((s) => inline(s.name)).join(', ');
  return [
    `### ${link(m.title, `${baseUrl}/maintenance/${encodeURIComponent(m.id)}`)}`,
    '',
    `- Status: ${MAINTENANCE_STATUS[m.status]}`,
    `- Scheduled: ${m.scheduledStart} to ${m.scheduledEnd}`,
    ...(affected ? [`- Affected services: ${affected}`] : []),
    ...(m.description.trim() ? ['', quote(m.description)] : []),
    '',
  ];
}

export function renderLlmsFull(baseUrl: string, c: CurrentStatus): string {
  const { settings, catalog } = c;
  const overall = catalog.services.length ? STATUS[overallStatus(catalog.services.map((s) => s.status))] : 'No public services';
  const section = (title: string, blocks: string[][], none: string) => [`## ${title}`, '', ...(blocks.length ? blocks.flat() : [none, ''])];
  const lines = [
    `# ${inline(settings.siteName)}: current status`,
    '',
    `> Overall status: ${overall}. Generated at ${c.generatedAt} (UTC). Status page: ${baseUrl}/`,
    '',
    ...section('Active incidents', c.activeIncidents.map((i) => incidentBlock(baseUrl, i)), 'No active incidents.'),
    ...section('Maintenance in progress', c.activeMaintenances.map((m) => maintenanceBlock(baseUrl, m)), 'No maintenance in progress.'),
    ...section('Upcoming maintenance', c.upcomingMaintenances.map((m) => maintenanceBlock(baseUrl, m)), 'No maintenance scheduled.'),
    '## Services',
    '',
  ];
  if (!catalog.services.length) lines.push('No services have been published yet.', '');
  for (const group of catalog.groups) {
    lines.push(`### ${inline(group.name)}`, '', ...group.services.map((s) => serviceLine(baseUrl, s, settings.showUptime)), '');
  }
  if (catalog.ungrouped.length) {
    if (catalog.groups.length) lines.push('### Other services', '');
    lines.push(...catalog.ungrouped.map((s) => serviceLine(baseUrl, s, settings.showUptime)), '');
  }
  lines.push('## More', '', `- ${link('Incident history', `${baseUrl}/history`)}`, `- ${link('Status API', `${baseUrl}/api/public/status`)}`, '');
  return lines.join('\n');
}

// --- Routes ---------------------------------------------------------------------

const send = (reply: FastifyReply, type: string, cache: string, body: string) =>
  reply.type(type).header('Cache-Control', cache).send(body);

const XML = 'application/xml; charset=utf-8';
const TEXT = 'text/plain; charset=utf-8';

export async function registerDiscoveryRoutes(app: FastifyInstance): Promise<void> {
  const { config, db, mailer } = app.ctx;
  const baseUrl = config.PUBLIC_BASE_URL;

  app.get('/robots.txt', (_req, reply) => send(reply, TEXT, CACHE.robots, renderRobots(config.APP_ROLE, baseUrl)));

  // A management instance (APP_ROLE=admin) is not the status page: robots.txt only.
  if (config.APP_ROLE === 'admin') return;

  const index = new SiteIndex(db, mailer);

  app.get('/sitemap.xml', async (_req, reply) => {
    const [incidents, services] = await Promise.all([index.count('incidents'), index.count('services')]);
    const paths = ['/sitemap-pages.xml'];
    for (let n = 1; n <= sitemapPages(incidents); n++) paths.push(sitemapPath('incidents', n));
    for (let n = 1; n <= sitemapPages(services); n++) paths.push(sitemapPath('services', n));
    return send(reply, XML, CACHE.sitemap, renderSitemapIndex(baseUrl, paths));
  });

  app.get('/sitemap-pages.xml', async (_req, reply) => send(reply, XML, CACHE.sitemap, renderUrlset(baseUrl, await index.pages())));

  for (const kind of ['incidents', 'services'] as const) {
    app.get<{ Params: { page: string } }>(`/sitemap-${kind}-:page.xml`, async (req, reply) => {
      const page = /^[1-9]\d{0,5}$/.test(req.params.page) ? Number(req.params.page) : 0;
      if (page < 1 || page > sitemapPages(await index.count(kind))) throw notFound('Sitemap');
      return send(reply, XML, CACHE.sitemap, renderUrlset(baseUrl, await index.urls(kind, page)));
    });
  }

  app.get('/llms.txt', async (_req, reply) => {
    const [settings, serviceCount] = await Promise.all([index.settings(), index.count('services')]);
    const body = renderLlms({
      baseUrl,
      siteName: settings.siteName,
      description: settings.description,
      serviceCount,
      showLocations: settings.showLocations,
      emailSubscriptions: await index.emailSubscriptions(settings),
    });
    return send(reply, TEXT, CACHE.llms, body);
  });

  app.get('/llms-full.txt', async (_req, reply) => send(reply, TEXT, CACHE.llmsFull, renderLlmsFull(baseUrl, await index.current())));
}
