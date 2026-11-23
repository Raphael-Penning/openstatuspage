/**
 * The public JSON:API in-process, for server-side rendering: the paths the web
 * client's queries GET (apps/web/src/public/hooks/queries.ts), answered by the
 * same document builders as the HTTP routes (services/public-documents.ts),
 * without serializing a request or a response.
 */
import { normalizePrivatePageToken, type DataDocument, type PublicDocumentSource, type SourceError } from '@openstatuspage/shared';
import { HttpError } from '../lib/errors.js';
import type { DocumentRequest } from '../lib/jsonapi.js';
import type { PrivatePageDocuments } from '../services/private-page-documents.js';
import type { PublicDocuments } from '../services/public-documents.js';

function sourceError(status: number, message: string): SourceError {
  return Object.assign(new Error(message), { status });
}

/** Path segment as the router would decode it (null: malformed or too long, like the routes' 400). */
function segment(raw: string, max: number): string | null {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return value.length >= 1 && value.length <= max ? value : null;
}

type Builder = (req: DocumentRequest, id: string) => Promise<DataDocument>;

/** Path of a subscription in the source: the manage token comes as the `token` query value (never over HTTP). */
const SUBSCRIPTION_PREFIX = '/api/public/subscriptions/';
const CHANNEL_SUBSCRIPTION_PREFIX = '/api/public/channel-subscriptions/';

export interface SourceExtras {
  /** The subscription for its manage token (APP_ROLE with the public API). */
  subscription?: (id: string, token: string) => Promise<DataDocument>;
  /** A webhook or SMS subscription for its manage token. */
  channelSubscription?: (id: string, token: string) => Promise<DataDocument>;
  /** Private pages: the token comes as the `token` query value (over HTTP it is a header). */
  privatePages?: PrivatePageDocuments;
}

/** Paths of the private page API in the source (routes/public.ts). */
const PRIVATE_PAGE_PATH = '/api/public/private-page';
const PRIVATE_SERVICE_PATH = /^\/api\/public\/private-page\/services\/([^/]+)$/;
const PRIVATE_DAY_PATH = /^\/api\/public\/private-page\/services\/([^/]+)\/days\/([^/]+)$/;
const PRIVATE_EVENT_PATH = /^\/api\/public\/private-page\/(incidents|maintenances)\/([^/]+)$/;

/** A private page document for `path`, or undefined when the path is none of them. */
async function privatePageDocument(
  docs: PrivatePageDocuments,
  path: string,
  query: Record<string, string>,
): Promise<DataDocument | undefined> {
  if (path !== PRIVATE_PAGE_PATH && !path.startsWith(`${PRIVATE_PAGE_PATH}/`)) return undefined;
  // The token never becomes part of the request URL (self links, logs).
  const { token: raw = '', ...rest } = query;
  const qs = new URLSearchParams(rest).toString();
  const req: DocumentRequest = { url: qs ? `${path}?${qs}` : path, query: rest };
  if (raw.length > 64) throw sourceError(404, 'Not found');
  const token = normalizePrivatePageToken(raw);
  if (path === PRIVATE_PAGE_PATH) return docs.page(req, token);
  const day = PRIVATE_DAY_PATH.exec(path);
  if (day) {
    const id = segment(day[1]!, 100);
    const date = segment(day[2]!, 32);
    if (id === null || date === null) throw sourceError(404, 'Not found');
    return docs.day(req, token, id, date);
  }
  const event = PRIVATE_EVENT_PATH.exec(path);
  if (event) {
    const id = segment(event[2]!, 64);
    if (id === null) throw sourceError(404, 'Not found');
    return event[1] === 'incidents' ? docs.incident(req, token, id) : docs.maintenance(req, token, id);
  }
  const service = PRIVATE_SERVICE_PATH.exec(path);
  const id = service ? segment(service[1]!, 100) : null;
  if (id === null) throw sourceError(404, 'Not found');
  return docs.service(req, token, id);
}

export function publicDocumentSource(docs: PublicDocuments, extras: SourceExtras = {}): PublicDocumentSource {
  const fixed: Record<string, (req: DocumentRequest) => Promise<DataDocument>> = {
    '/api/public/settings': (req) => docs.settings(req),
    '/api/public/summary': (req) => docs.summary(req),
    '/api/public/services': (req) => docs.services(req),
    '/api/public/locations': (req) => docs.locations(req),
    '/api/public/history': (req) => docs.history(req),
  };
  // Same limits as the route parameters (routes/public.ts).
  const byId: [prefix: string, max: number, build: Builder][] = [
    ['/api/public/services/', 100, (req, id) => docs.service(req, id)],
    ['/api/public/incidents/', 64, (req, id) => docs.incident(req, id)],
    ['/api/public/maintenances/', 64, (req, id) => docs.maintenance(req, id)],
  ];

  /** `/api/public/services/<idOrSlug>/days/<date>`, matched before the service itself. */
  const DAY_PATH = /^\/api\/public\/services\/([^/]+)\/days\/([^/]+)$/;

  return {
    async get(path, query = {}) {
      const qs = new URLSearchParams(query).toString();
      const req: DocumentRequest = { url: qs ? `${path}?${qs}` : path, query };
      try {
        if (extras.privatePages) {
          const doc = await privatePageDocument(extras.privatePages, path, query);
          if (doc) return doc;
        }
        const build = fixed[path];
        if (build) return await build(req);
        if (path.startsWith(CHANNEL_SUBSCRIPTION_PREFIX) && extras.channelSubscription) {
          const id = segment(path.slice(CHANNEL_SUBSCRIPTION_PREFIX.length), 64);
          const token = query.token ?? '';
          if (id === null || id.includes('/') || !token || token.length > 256) throw sourceError(404, 'Not found');
          return await extras.channelSubscription(id, token);
        }
        if (path.startsWith(SUBSCRIPTION_PREFIX) && extras.subscription) {
          const id = segment(path.slice(SUBSCRIPTION_PREFIX.length), 64);
          const token = query.token ?? '';
          if (id === null || id.includes('/') || !token || token.length > 256) throw sourceError(404, 'Not found');
          return await extras.subscription(id, token);
        }
        const day = DAY_PATH.exec(path);
        if (day) {
          const id = segment(day[1]!, 100);
          const date = segment(day[2]!, 32);
          if (id === null || date === null) throw sourceError(404, 'Not found');
          return await docs.serviceDay(req, id, date);
        }
        for (const [prefix, max, buildOne] of byId) {
          if (!path.startsWith(prefix)) continue;
          const id = segment(path.slice(prefix.length), max);
          if (id === null || id.includes('/')) throw sourceError(404, 'Not found');
          return await buildOne(req, id);
        }
      } catch (err) {
        if (err instanceof HttpError) throw sourceError(err.statusCode, err.message);
        throw err;
      }
      throw sourceError(404, `No public document at ${path}`);
    },
  };
}
