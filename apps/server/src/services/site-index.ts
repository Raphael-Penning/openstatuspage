/**
 * What search engines and AI agents may find on the public page: the URLs of
 * the sitemaps and the data of /llms.txt (routes/discovery.ts).
 *
 * Public data only, read like the rest of the public code: on PostgreSQL with
 * APP_ROLE=public through the osp_public views (public rows and columns only),
 * and with the same `is_public` filters on every other database and role.
 */
import type { PublicIncident, PublicMaintenance, PublicPageSettings } from '@openstatuspage/shared';
import type { DB } from '../db/index.js';
import { mailerConfigured, type Mailer } from '../mail/mailer.js';
import { loadPublicCatalog, type PublicCatalog } from './public-catalog.js';
import {
  activeIncidentIds,
  activeMaintenanceIds,
  publicIncidents,
  publicMaintenances,
  upcomingMaintenanceIds,
} from './public-documents.js';
import { getSettings } from './settings.js';

/**
 * URLs per sitemap file. The protocol allows 50,000; a smaller file keeps the
 * memory of building one response small (public instances stay below 100 MB).
 */
export const SITEMAP_PAGE_SIZE = 5000;

export interface SitemapUrl {
  /** Path below the public base URL ("/incidents/…"). */
  path: string;
  /** Last change (ISO 8601). */
  lastmod?: string;
}

/** Sub-sitemaps besides the navigation pages: incidents (with maintenance windows) and service pages. */
export type SitemapKind = 'incidents' | 'services';

/** ISO 8601 of a stored timestamp (text on SQLite, possibly a Date elsewhere). */
function iso(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const later = (a?: string, b?: string) => (a && b ? (a > b ? a : b) : (a ?? b));

export interface CurrentStatus {
  settings: PublicPageSettings;
  catalog: PublicCatalog;
  activeIncidents: PublicIncident[];
  activeMaintenances: PublicMaintenance[];
  upcomingMaintenances: PublicMaintenance[];
  generatedAt: string;
}

export class SiteIndex {
  constructor(
    private readonly db: DB,
    private readonly mailer: Mailer,
  ) {}

  settings(): Promise<PublicPageSettings> {
    return getSettings(this.db);
  }

  /** Email subscriptions are offered (settings and a mail transport). */
  async emailSubscriptions(settings?: PublicPageSettings): Promise<boolean> {
    return (settings ?? (await this.settings())).emailSubscriptionsEnabled && mailerConfigured(this.mailer);
  }

  /** Navigation pages of the public page (the ones the settings switch on). */
  async pages(): Promise<SitemapUrl[]> {
    const settings = await this.settings();
    return [
      { path: '/' },
      { path: '/services' },
      { path: '/history' },
      ...(settings.showLocations ? [{ path: '/locations' }] : []),
      ...((await this.emailSubscriptions(settings)) ? [{ path: '/subscribe' }] : []),
    ];
  }

  /** Number of URLs of a sub-sitemap. */
  async count(kind: SitemapKind): Promise<number> {
    if (kind === 'services') return this.countOf('services');
    const [incidents, maintenances] = await Promise.all([this.countOf('incidents'), this.countOf('maintenances')]);
    return incidents + maintenances;
  }

  private async countOf(table: 'incidents' | 'maintenances' | 'services'): Promise<number> {
    const row = await this.db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll<number | string>().as('n'))
      .where('is_public', '=', 1)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  /** One page (1-based) of a sub-sitemap, at most SITEMAP_PAGE_SIZE URLs. */
  async urls(kind: SitemapKind, page: number): Promise<SitemapUrl[]> {
    const offset = (page - 1) * SITEMAP_PAGE_SIZE;
    if (kind === 'services') {
      const rows = await this.db
        .selectFrom('services')
        .select(['id', 'slug', 'updated_at', 'status_changed_at'])
        .where('is_public', '=', 1)
        .orderBy('sort_order')
        .orderBy('id')
        .limit(SITEMAP_PAGE_SIZE)
        .offset(offset)
        .execute();
      return rows.map((r) => ({
        path: `/services/${encodeURIComponent(r.slug || r.id)}`,
        // The page shows the current status: a status change is a change of the page.
        lastmod: later(iso(r.updated_at), iso(r.status_changed_at)),
      }));
    }

    // Incidents first, then maintenance windows; newest first within each.
    const incidents = await this.db
      .selectFrom('incidents')
      .select(['id', 'updated_at'])
      .where('is_public', '=', 1)
      .orderBy('started_at', 'desc')
      .orderBy('id')
      .limit(SITEMAP_PAGE_SIZE)
      .offset(offset)
      .execute();
    const urls: SitemapUrl[] = incidents.map((r) => ({ path: `/incidents/${encodeURIComponent(r.id)}`, lastmod: iso(r.updated_at) }));
    const remaining = SITEMAP_PAGE_SIZE - urls.length;
    if (remaining > 0) {
      const maintenanceOffset = Math.max(0, offset - (await this.countOf('incidents')));
      const maintenances = await this.db
        .selectFrom('maintenances')
        .select(['id', 'updated_at'])
        .where('is_public', '=', 1)
        .orderBy('scheduled_start', 'desc')
        .orderBy('id')
        .limit(remaining)
        .offset(maintenanceOffset)
        .execute();
      urls.push(...maintenances.map((r) => ({ path: `/maintenance/${encodeURIComponent(r.id)}`, lastmod: iso(r.updated_at) })));
    }
    return urls;
  }

  /** Current status for /llms-full.txt (the data of the overview). */
  async current(): Promise<CurrentStatus> {
    const now = new Date();
    const settings = await this.settings();
    const [catalog, activeIncidents, activeMaintenances, upcomingMaintenances] = await Promise.all([
      loadPublicCatalog(this.db, settings, now),
      activeIncidentIds(this.db).then((ids) => publicIncidents(this.db, ids)),
      activeMaintenanceIds(this.db).then((ids) => publicMaintenances(this.db, ids)),
      upcomingMaintenanceIds(this.db, now.toISOString()).then((ids) => publicMaintenances(this.db, ids)),
    ]);
    return {
      settings,
      catalog,
      activeIncidents,
      activeMaintenances,
      upcomingMaintenances,
      generatedAt: now.toISOString(),
    };
  }
}
