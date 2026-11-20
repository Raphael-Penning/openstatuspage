/**
 * /feed.rss (RSS 2.0) and /feed.atom (Atom 1.0): the latest 50 public
 * incidents and maintenance windows, newest change first.
 *
 * Item links point to the public web client: /incidents/:id and /maintenance/:id.
 */
import type { PublicIncident, PublicMaintenance } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/index.js';
import { formatUtcDateTime } from '../lib/time.js';
import { escapeXml } from '../lib/xml.js';
import { loadIncidents, toPublicIncident } from '../services/incidents.js';
import { loadMaintenances, toPublicMaintenance } from '../services/maintenances.js';
import { getSettings } from '../services/settings.js';

const FEED_LIMIT = 50;

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  published: string;
  updated: string;
  /** Plain text, newlines separate paragraphs. */
  content: string;
}

export type FeedLocale = 'en' | 'de';

/** Human readable feed texts; feed readers show them to customers as-is. */
const TEXTS = {
  en: {
    status: 'Status',
    impact: 'Impact',
    affected: 'Affected',
    scheduled: 'Scheduled',
    values: {
      investigating: 'Investigating',
      identified: 'Identified',
      monitoring: 'Monitoring',
      resolved: 'Resolved',
      none: 'None',
      minor: 'Minor',
      major: 'Major',
      critical: 'Critical',
      scheduled: 'Scheduled',
      in_progress: 'In progress',
      completed: 'Completed',
      cancelled: 'Cancelled',
    } as Record<string, string>,
  },
  de: {
    status: 'Status',
    impact: 'Auswirkung',
    affected: 'Betroffen',
    scheduled: 'Geplant',
    values: {
      investigating: 'Untersuchung',
      identified: 'Ursache identifiziert',
      monitoring: 'Beobachtung',
      resolved: 'Behoben',
      none: 'Keine',
      minor: 'Gering',
      major: 'Erheblich',
      critical: 'Kritisch',
      scheduled: 'Geplant',
      in_progress: 'In Arbeit',
      completed: 'Abgeschlossen',
      cancelled: 'Abgesagt',
    } as Record<string, string>,
  },
} as const;

function formatter(locale: FeedLocale) {
  const t = TEXTS[locale];
  return {
    t,
    value: (v: string) => t.values[v] ?? v,
    date: (iso: string) => `${formatUtcDateTime(iso, locale)} UTC`,
  };
}

function incidentItem(baseUrl: string, i: PublicIncident, locale: FeedLocale): FeedItem {
  const f = formatter(locale);
  const services = i.affectedServices.map((s) => s.name).join(', ');
  const lines = [
    `${f.t.status}: ${f.value(i.status)}`,
    `${f.t.impact}: ${f.value(i.impact)}`,
    ...(services ? [`${f.t.affected}: ${services}`] : []),
    ...i.updates.map((u) => `${f.date(u.createdAt)} – ${f.value(u.status)}: ${u.message}`.trim()),
  ];
  return {
    id: `${baseUrl}/incidents/${i.id}`,
    title: i.title,
    link: `${baseUrl}/incidents/${i.id}`,
    published: i.startedAt,
    updated: i.updatedAt,
    content: lines.join('\n'),
  };
}

function maintenanceItem(
  baseUrl: string,
  m: PublicMaintenance,
  createdAt: string,
  updatedAt: string,
  locale: FeedLocale,
): FeedItem {
  const f = formatter(locale);
  const services = m.affectedServices.map((s) => s.name).join(', ');
  const lines = [
    `${f.t.status}: ${f.value(m.status)}`,
    `${f.t.scheduled}: ${f.date(m.scheduledStart)} – ${f.date(m.scheduledEnd)}`,
    ...(services ? [`${f.t.affected}: ${services}`] : []),
    ...(m.description ? [m.description] : []),
    ...m.updates.filter((u) => u.message).map((u) => `${f.date(u.createdAt)} – ${f.value(u.status)}: ${u.message}`),
  ];
  return {
    id: `${baseUrl}/maintenance/${m.id}`,
    title: m.title,
    link: `${baseUrl}/maintenance/${m.id}`,
    published: createdAt,
    updated: updatedAt,
    content: lines.join('\n'),
  };
}

export async function loadFeedItems(db: DB, baseUrl: string, locale: FeedLocale = 'en'): Promise<FeedItem[]> {
  const [incidentRows, maintenanceRows] = await Promise.all([
    db
      .selectFrom('incidents')
      .select(['id', 'updated_at'])
      .where('is_public', '=', 1)
      .orderBy('updated_at', 'desc')
      .limit(FEED_LIMIT)
      .execute(),
    db
      .selectFrom('maintenances')
      .select(['id', 'updated_at'])
      .where('is_public', '=', 1)
      .orderBy('updated_at', 'desc')
      .limit(FEED_LIMIT)
      .execute(),
  ]);
  const newest = [
    ...incidentRows.map((r) => ({ type: 'incident' as const, ...r })),
    ...maintenanceRows.map((r) => ({ type: 'maintenance' as const, ...r })),
  ]
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .slice(0, FEED_LIMIT);

  const [incidents, maintenances] = await Promise.all([
    loadIncidents(
      db,
      newest.filter((n) => n.type === 'incident').map((n) => n.id),
    ),
    loadMaintenances(
      db,
      newest.filter((n) => n.type === 'maintenance').map((n) => n.id),
    ),
  ]);
  const incidentById = new Map(incidents.map((r) => [r.row.id, r]));
  const maintenanceById = new Map(maintenances.map((r) => [r.row.id, r]));

  return newest.flatMap((n) => {
    if (n.type === 'incident') {
      const rec = incidentById.get(n.id);
      return rec ? [incidentItem(baseUrl, toPublicIncident(rec), locale)] : [];
    }
    const rec = maintenanceById.get(n.id);
    return rec ? [maintenanceItem(baseUrl, toPublicMaintenance(rec), rec.row.created_at, rec.row.updated_at, locale)] : [];
  });
}

const rfc822 = (iso: string) => new Date(iso).toUTCString();

export function renderRss(meta: { title: string; description: string; baseUrl: string }, items: FeedItem[]): string {
  const x = escapeXml;
  const lastBuild = items[0]?.updated ?? new Date().toISOString();
  const body = items
    .map(
      (i) => `    <item>
      <title>${x(i.title)}</title>
      <link>${x(i.link)}</link>
      <guid isPermaLink="true">${x(i.link)}</guid>
      <pubDate>${rfc822(i.published)}</pubDate>
      <description>${x(i.content)}</description>
    </item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${x(meta.title)}</title>
    <link>${x(`${meta.baseUrl}/`)}</link>
    <description>${x(meta.description || meta.title)}</description>
    <atom:link href="${x(`${meta.baseUrl}/feed.rss`)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${rfc822(lastBuild)}</lastBuildDate>
${body}
  </channel>
</rss>
`;
}

export function renderAtom(meta: { title: string; description: string; baseUrl: string }, items: FeedItem[]): string {
  const x = escapeXml;
  const updated = items[0]?.updated ?? new Date().toISOString();
  const body = items
    .map(
      (i) => `  <entry>
    <id>${x(i.id)}</id>
    <title>${x(i.title)}</title>
    <link rel="alternate" type="text/html" href="${x(i.link)}"/>
    <published>${x(i.published)}</published>
    <updated>${x(i.updated)}</updated>
    <content type="text">${x(i.content)}</content>
  </entry>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${x(`${meta.baseUrl}/`)}</id>
  <title>${x(meta.title)}</title>
  ${meta.description ? `<subtitle>${x(meta.description)}</subtitle>` : ''}
  <link rel="self" type="application/atom+xml" href="${x(`${meta.baseUrl}/feed.atom`)}"/>
  <link rel="alternate" type="text/html" href="${x(`${meta.baseUrl}/`)}"/>
  <updated>${x(updated)}</updated>
  <author><name>${x(meta.title)}</name></author>
${body}
</feed>
`;
}

/** Registered inside the public scope (shares its Cache-Control hook). */
export async function registerFeedRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.ctx;

  // Feed texts use the page's default language.
  async function load() {
    const settings = await getSettings(db);
    const meta = { title: settings.siteName, description: settings.description, baseUrl: config.PUBLIC_BASE_URL };
    return { meta, items: await loadFeedItems(db, config.PUBLIC_BASE_URL, settings.defaultLocale) };
  }

  app.get('/feed.rss', async (_req, reply) => {
    const { meta, items } = await load();
    const xml = renderRss(meta, items);
    return reply.type('application/rss+xml; charset=utf-8').send(xml);
  });

  app.get('/feed.atom', async (_req, reply) => {
    const { meta, items } = await load();
    const xml = renderAtom(meta, items);
    return reply.type('application/atom+xml; charset=utf-8').send(xml);
  });
}
