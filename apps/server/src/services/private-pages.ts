/**
 * Private (secret) status pages at /p/<token>: a chosen set of services, also
 * ones hidden from the main page, for whoever has the link.
 *
 * - Tokens: 160 random bits as 32 characters of lower-case base32, stored only
 *   as their SHA-256 hash (private_pages.token_hash), like the subscription
 *   tokens. Shown once, in the admin answer that created or regenerated them.
 * - The visitor's view (PrivatePages) is built from the rows of a
 *   PrivatePageStore (private-page-store.ts): the tables directly, or the
 *   token-scoped functions of osp_public on a public PostgreSQL instance. The
 *   uptime bars and day pages are computed exactly like those of the main page
 *   (public-catalog.ts, service-days.ts). Only public text of incidents and
 *   maintenance windows is shown, and only their links to the page's services.
 * - Admin side (loadAdminPrivatePages): never returns a token or its hash.
 */
import { randomBytes } from 'node:crypto';
import {
  overallStatus,
  privatePageBase,
  shiftUptimeDay,
  uptimeDayStart,
  type AdminPrivatePage,
  type DailyUptime,
  type PublicIncident,
  type PublicMaintenance,
  type PublicPageSettings,
  type PublicPrivatePage,
  type PublicService,
  type ServiceDaySegment,
} from '@openstatuspage/shared';
import type { DB } from '../db/index.js';
import { buildCorrectionLayers } from './corrections.js';
import { applyCorrections, rangeStart } from './history-corrections.js';
import type { PrivateIncidentRow, PrivateMaintenanceRow, PrivatePageRef, PrivatePageStore, PrivateServiceRow } from './private-page-store.js';
import { countStatuses, segmentsByService, toPublicService, uptimeOf } from './public-catalog.js';
import { daySegments, maintenancesOnDay } from './service-days.js';
import { getSettings } from './settings.js';

const DAY_MS = 86_400_000;
/** Incidents of the last 90 days on a service page, like the main service page. */
const SERVICE_INCIDENT_DAYS = 90;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A new link token: 160 random bits, 32 characters of lower-case base32 (URL-safe, case-proof). */
export function newPrivatePageToken(): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of randomBytes(20)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

/** The full link of a page: PUBLIC_BASE_URL + /p/<token>. */
export function privatePageUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${privatePageBase(token)}`;
}

// --- Admin -------------------------------------------------------------------------

/** Loads private pages for the admin API (all, or `ids` in that order), newest first. */
export async function loadAdminPrivatePages(db: DB, ids?: string[]): Promise<AdminPrivatePage[]> {
  if (ids && ids.length === 0) return [];
  let query = db
    .selectFrom('private_pages')
    .select(['id', 'name', 'description', 'expires_at', 'enabled', 'token_created_at', 'created_at', 'updated_at'])
    .orderBy('created_at', 'desc')
    .orderBy('id');
  if (ids) query = query.where('id', 'in', ids);
  const rows = await query.execute();
  if (rows.length === 0) return [];
  const links = await db
    .selectFrom('private_page_services')
    .select(['page_id', 'service_id'])
    .where(
      'page_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('sort_order')
    .execute();
  const now = new Date().toISOString();
  const pages = rows.map(
    (r): AdminPrivatePage => ({
      id: r.id,
      name: r.name,
      description: r.description,
      serviceIds: links.filter((l) => l.page_id === r.id).map((l) => l.service_id),
      expiresAt: r.expires_at,
      enabled: r.enabled === 1,
      expired: r.expires_at !== null && r.expires_at <= now,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      tokenCreatedAt: r.token_created_at,
    }),
  );
  if (!ids) return pages;
  const byId = new Map(pages.map((p) => [p.id, p]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

// --- Visitors ------------------------------------------------------------------------

function toIncident(r: PrivateIncidentRow): PublicIncident {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    impact: r.impact,
    startedAt: r.started_at,
    resolvedAt: r.resolved_at,
    updatedAt: r.updated_at,
    affectedServices: r.services.map((s) => ({ id: s.id, name: s.name, status: s.status })),
    locationIds: [],
    updates: r.updates.map((u) => ({ id: u.id, status: u.status, message: u.message, createdAt: u.created_at })),
  };
}

function toMaintenance(r: PrivateMaintenanceRow): PublicMaintenance {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    scheduledStart: r.scheduled_start,
    scheduledEnd: r.scheduled_end,
    actualStart: r.actual_start,
    actualEnd: r.actual_end,
    affectedServices: r.services.map((s) => ({ id: s.id, name: s.name })),
    locationIds: [],
    updates: r.updates.map((u) => ({ id: u.id, status: u.status, message: u.message, createdAt: u.created_at })),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const affects = (row: { services: { id: string }[] }, serviceId: string) => row.services.some((s) => s.id === serviceId);

/** A service of a private page with its bars ([] while uptime is not shown). */
export type PrivateService = PublicService & { uptime: DailyUptime[] };

export interface PrivateServiceDetail {
  page: PrivatePageRef;
  service: PrivateService;
  /** Of the last 90 days or unresolved, newest first. */
  incidents: PublicIncident[];
  /** Running and upcoming, oldest first. */
  maintenances: PublicMaintenance[];
}

export interface PrivateServiceDay {
  page: PrivatePageRef;
  service: PrivateService;
  bucket: DailyUptime;
  dayStart: number;
  segments: ServiceDaySegment[];
  previousDate: string | null;
  nextDate: string | null;
  incidents: PublicIncident[];
  maintenances: PublicMaintenance[];
}

/** The visitor's view of a private page. Every method resolves null for a token without a page. */
export class PrivatePages {
  constructor(
    private readonly db: DB,
    private readonly store: PrivatePageStore,
  ) {}

  /** Bars and average uptime of the services, as on the main page. */
  private async uptime(token: string, services: PrivateServiceRow[], settings: PublicPageSettings, now: Date) {
    const ids = services.map((s) => s.id);
    if (!settings.showUptime || ids.length === 0) return new Map<string, { uptime: DailyUptime[]; percent: number | null }>();
    const from = rangeStart(settings.uptimeDays, now).toISOString();
    const to = now.toISOString();
    const [history, corrections, retroactive] = await Promise.all([
      this.store.history(token, from, null),
      this.store.corrections(token, from, to),
      this.store.retroactiveMaintenances(token, to),
    ]);
    return uptimeOf(ids, segmentsByService(history), buildCorrectionLayers(corrections, retroactive, from), settings.uptimeDays, now);
  }

  private async withServices(token: string, now: Date) {
    const [page, settings] = await Promise.all([this.store.page(token), getSettings(this.db)]);
    if (!page) return null;
    const rows = await this.store.services(token);
    const uptime = await this.uptime(token, rows, settings, now);
    const services = rows.map(
      (s): PrivateService => ({
        ...toPublicService(s, null, [], uptime.get(s.id), settings.showUptime),
        uptime: uptime.get(s.id)?.uptime ?? [],
      }),
    );
    return { page, settings, services };
  }

  /** The page: its services with bars, overall status, active incidents, running and upcoming maintenance. */
  async view(token: string, now = new Date()): Promise<PublicPrivatePage | null> {
    const loaded = await this.withServices(token, now);
    if (!loaded) return null;
    const nowIso = now.toISOString();
    const [incidents, maintenances] = await Promise.all([this.store.incidents(token, nowIso), this.store.maintenances(token, nowIso)]);
    const { page, services } = loaded;
    return {
      id: page.id,
      name: page.name,
      description: page.description,
      overall: overallStatus(services.map((s) => s.status)),
      counts: countStatuses(services.map((s) => s.status)),
      generatedAt: nowIso,
      services,
      activeIncidents: incidents.filter((i) => i.status !== 'resolved').map(toIncident),
      activeMaintenances: maintenances.filter((m) => m.status === 'in_progress').map(toMaintenance),
      upcomingMaintenances: maintenances
        .filter((m) => m.status === 'scheduled' && m.scheduled_end > nowIso)
        .map(toMaintenance),
    };
  }

  /** One service of the page (by id or slug) with its incidents and maintenance. */
  async service(token: string, idOrSlug: string, now = new Date()): Promise<PrivateServiceDetail | null> {
    const loaded = await this.withServices(token, now);
    const service = loaded?.services.find((s) => s.id === idOrSlug || s.slug === idOrSlug);
    if (!loaded || !service) return null;
    const nowIso = now.toISOString();
    const since = new Date(now.getTime() - SERVICE_INCIDENT_DAYS * DAY_MS).toISOString();
    const [incidents, maintenances] = await Promise.all([this.store.incidents(token, since), this.store.maintenances(token, nowIso)]);
    return {
      page: loaded.page,
      service,
      incidents: incidents.filter((i) => affects(i, service.id)).map(toIncident),
      maintenances: maintenances
        .filter((m) => affects(m, service.id))
        .filter((m) => m.status === 'in_progress' || (m.status === 'scheduled' && m.scheduled_end > nowIso))
        .map(toMaintenance),
    };
  }

  /**
   * One UTC day of a service of the page. null for a wrong token, an unknown
   * service, a day outside the uptime range and while uptime is not shown;
   * `date` must be a valid day (the caller answers 400 otherwise).
   */
  async day(token: string, idOrSlug: string, date: string, now = new Date()): Promise<PrivateServiceDay | null> {
    const dayStart = uptimeDayStart(date);
    if (dayStart === null) return null;
    const loaded = await this.withServices(token, now);
    if (!loaded || !loaded.settings.showUptime) return null;
    const service = loaded.services.find((s) => s.id === idOrSlug || s.slug === idOrSlug);
    if (!service) return null;
    const index = service.uptime.findIndex((d) => d.date === date);
    if (index < 0) return null;

    const from = new Date(dayStart).toISOString();
    const to = new Date(dayStart + DAY_MS).toISOString();
    const [history, corrections, retroactive, incidents, maintenances] = await Promise.all([
      this.store.history(token, from, to),
      this.store.corrections(token, from, to),
      this.store.retroactiveMaintenances(token, to),
      this.store.incidents(token, from),
      this.store.maintenances(token, from),
    ]);
    const measured = segmentsByService(history).get(service.id) ?? [];
    const c = buildCorrectionLayers(corrections, retroactive, from).get(service.id);
    const segments = daySegments(c ? applyCorrections(measured, c.layers, now) : measured, new Set(c?.publicNotes.keys() ?? []), dayStart, now);

    const dayIncidents = incidents
      .filter((i) => affects(i, service.id) && i.started_at < to && (i.resolved_at === null || i.resolved_at >= from))
      .sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : a.id < b.id ? -1 : 1));
    const serviceMaintenances = maintenances.filter((m) => affects(m, service.id));
    const byId = new Map(serviceMaintenances.map((m) => [m.id, m]));
    return {
      page: loaded.page,
      service,
      bucket: service.uptime[index]!,
      dayStart,
      segments,
      previousDate: index > 0 ? shiftUptimeDay(date, -1) : null,
      nextDate: index < service.uptime.length - 1 ? shiftUptimeDay(date, 1) : null,
      incidents: dayIncidents.map(toIncident),
      maintenances: maintenancesOnDay(serviceMaintenances, dayStart, now).map((id) => toMaintenance(byId.get(id)!)),
    };
  }
}
