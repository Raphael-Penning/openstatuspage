/**
 * The JSON:API documents of a private page (GET /api/public/private-page...),
 * built like the public ones (public-documents.ts): the HTTP routes send them,
 * server-side rendering calls the same builders in-process (ssr/source.ts).
 *
 * Every failure that depends on the token (unknown, disabled, expired) is the
 * same 404 with the same body, so the answer never tells which it was.
 */
import { uptimeDayStart, type DataDocument } from '@openstatuspage/shared';
import { HttpError } from '../lib/errors.js';
import { document, Included, toMany, type DocumentRequest } from '../lib/jsonapi.js';
import { parseInclude } from '../lib/jsonapi-query.js';
import {
  incidentResource,
  maintenanceResource,
  PRIVATE_PAGE_API,
  privatePageResource,
  privateServiceResource,
  PUBLIC_TYPES,
  serviceDayResource,
} from '../serializers/public.js';
import { bucketAttributes } from './service-days.js';
import type { PrivatePages } from './private-pages.js';

const DAY_MS = 86_400_000;
const SERVICE_INCLUDES = ['incidents', 'incidents.updates', 'maintenances', 'maintenances.updates'];
const DAY_INCLUDES = ['service', 'incidents', 'incidents.updates', 'maintenances', 'maintenances.updates'];
const UPDATE_INCLUDES = ['updates'];

/** The one answer for everything a visitor without a valid link may ask. */
export const privatePageNotFound = () => new HttpError(404, 'not_found', 'Not found');

export class PrivatePageDocuments {
  constructor(private readonly pages: PrivatePages) {}

  /** GET /api/public/private-page: the page with its services, incidents and maintenance (always included). */
  async page(_req: DocumentRequest, token: string): Promise<DataDocument> {
    const view = await this.pages.view(token);
    if (!view) throw privatePageNotFound();
    const included = new Included();
    return document(privatePageResource(view, included), { included, links: { self: PRIVATE_PAGE_API } });
  }

  /** GET /api/public/private-page/services/:idOrSlug */
  async service(req: DocumentRequest, token: string, idOrSlug: string): Promise<DataDocument> {
    const include = parseInclude(req.query as Record<string, unknown>, SERVICE_INCLUDES, ['incidents.updates', 'maintenances.updates']);
    const detail = await this.pages.service(token, idOrSlug);
    if (!detail) throw privatePageNotFound();
    const included = new Included();
    const wants = (path: string) => include.has(path) || include.has(`${path}.updates`);
    if (wants('incidents')) {
      const updates = include.has('incidents.updates') ? included : undefined;
      for (const i of detail.incidents) included.add(incidentResource(i, updates));
    }
    if (wants('maintenances')) {
      const updates = include.has('maintenances.updates') ? included : undefined;
      for (const m of detail.maintenances) included.add(maintenanceResource(m, updates));
    }
    const data = privateServiceResource(detail.service, {
      incidents: toMany(PUBLIC_TYPES.incident, detail.incidents.map((i) => i.id)),
      maintenances: toMany(PUBLIC_TYPES.maintenance, detail.maintenances.map((m) => m.id)),
    });
    return document(data, { included, links: { self: data.links!.self as string } });
  }

  /** GET /api/public/private-page/incidents/:id: an incident the page shows, with only the page's services. */
  async incident(req: DocumentRequest, token: string, id: string): Promise<DataDocument> {
    const include = parseInclude(req.query as Record<string, unknown>, UPDATE_INCLUDES, UPDATE_INCLUDES);
    const incident = await this.pages.incident(token, id);
    if (!incident) throw privatePageNotFound();
    const included = new Included();
    const data = {
      ...incidentResource(incident, include.has('updates') ? included : undefined),
      links: { self: `${PRIVATE_PAGE_API}/incidents/${encodeURIComponent(id)}` },
    };
    return document(data, { included, links: { self: data.links.self } });
  }

  /** GET /api/public/private-page/maintenances/:id: a maintenance window the page shows, like {@link incident}. */
  async maintenance(req: DocumentRequest, token: string, id: string): Promise<DataDocument> {
    const include = parseInclude(req.query as Record<string, unknown>, UPDATE_INCLUDES, UPDATE_INCLUDES);
    const maintenance = await this.pages.maintenance(token, id);
    if (!maintenance) throw privatePageNotFound();
    const included = new Included();
    const data = {
      ...maintenanceResource(maintenance, include.has('updates') ? included : undefined),
      links: { self: `${PRIVATE_PAGE_API}/maintenances/${encodeURIComponent(id)}` },
    };
    return document(data, { included, links: { self: data.links.self } });
  }

  /** GET /api/public/private-page/services/:idOrSlug/days/:date (400 for a malformed date, like the public day). */
  async day(req: DocumentRequest, token: string, idOrSlug: string, date: string): Promise<DataDocument> {
    const include = parseInclude(req.query as Record<string, unknown>, DAY_INCLUDES, DAY_INCLUDES);
    if (uptimeDayStart(date) === null) throw new HttpError(400, 'invalid_date', 'Expected a day as YYYY-MM-DD');
    const now = new Date();
    const day = await this.pages.day(token, idOrSlug, date, now);
    if (!day) throw privatePageNotFound();
    const { service } = day;
    const included = new Included();
    const wants = (path: string) => include.has(path) || include.has(`${path}.updates`);
    if (include.has('service')) {
      const { uptime: _bars, ...withoutBars } = service;
      included.add(privateServiceResource(withoutBars));
    }
    if (wants('incidents')) {
      const updates = include.has('incidents.updates') ? included : undefined;
      for (const i of day.incidents) included.add(incidentResource(i, updates));
    }
    if (wants('maintenances')) {
      const updates = include.has('maintenances.updates') ? included : undefined;
      for (const m of day.maintenances) included.add(maintenanceResource(m, updates));
    }
    const self = `${PRIVATE_PAGE_API}/services/${encodeURIComponent(service.slug || service.id)}/days/${date}`;
    const data = {
      ...serviceDayResource(
        {
          id: `${service.id}:${date}`,
          ...bucketAttributes(day.bucket),
          startsAt: new Date(day.dayStart).toISOString(),
          endsAt: new Date(day.dayStart + DAY_MS).toISOString(),
          complete: day.dayStart + DAY_MS <= now.getTime(),
          segments: day.segments,
          previousDate: day.previousDate,
          nextDate: day.nextDate,
        },
        service,
        day.incidents.map((i) => i.id),
        day.maintenances.map((m) => m.id),
      ),
      links: { self },
    };
    return document(data, { included, links: { self } });
  }
}
