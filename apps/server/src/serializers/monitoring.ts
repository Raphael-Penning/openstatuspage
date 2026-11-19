/**
 * JSON:API resource objects of the monitoring admin API: monitoring sources,
 * checks, check bundles and history imports (/api/admin/*). Inputs are the
 * explicitly serialized admin objects, so secrets stay masked.
 */
import type {
  AdminCheckBundle,
  AdminHistoryImport,
  AdminMonitorCheck,
  AdminMonitorSource,
  BundleCandidateSource,
  ResourceObject,
} from '@openstatuspage/shared';
import { Included, resource, toMany, toOne } from '../lib/jsonapi.js';

const BASE = '/api/admin';

export const MONITORING_TYPES = {
  source: 'monitor-sources',
  check: 'monitor-checks',
  bundle: 'check-bundles',
  historyImport: 'history-imports',
  user: 'users',
} as const;

export const sourceLink = (id: string) => `${BASE}/monitor-sources/${id}`;
export const checkLink = (id: string) => `${BASE}/checks/${id}`;
export const bundleLink = (id: string) => `${BASE}/check-bundles/${id}`;
export const historyImportLink = (sourceId: string, id: string) => `${sourceLink(sourceId)}/history-imports/${id}`;

/**
 * Monitoring source. `extra` adds attributes that only one response carries
 * (the ingest token right after creating the source).
 */
export function sourceResource(source: AdminMonitorSource, extra: Record<string, unknown> = {}): ResourceObject {
  return resource(MONITORING_TYPES.source, source.id, { ...source, ...extra }, { links: { self: sourceLink(source.id) } });
}

export function checkResource(check: AdminMonitorCheck): ResourceObject {
  const { sourceId, ...attributes } = check;
  return resource(MONITORING_TYPES.check, check.id, attributes, {
    relationships: { source: toOne(MONITORING_TYPES.source, sourceId) },
    links: { self: checkLink(check.id) },
  });
}

/** Check bundle. `members` and `vote` are value objects and stay attributes. */
export function bundleResource(bundle: AdminCheckBundle): ResourceObject {
  const { checkId, ...attributes } = bundle;
  return resource(MONITORING_TYPES.bundle, bundle.id, attributes, {
    relationships: { check: toOne(MONITORING_TYPES.check, checkId) },
    links: { self: bundleLink(bundle.id) },
  });
}

/**
 * A source with the checks that can become bundle members. The checks are
 * added to `included` (only the fields the member picker needs).
 */
export function candidateSourceResource(source: BundleCandidateSource, included: Included): ResourceObject {
  const { checks, ...attributes } = source;
  included.add(
    ...checks.map(({ id, ...check }) => resource(MONITORING_TYPES.check, id, check, { links: { self: checkLink(id) } })),
  );
  return resource(MONITORING_TYPES.source, source.id, attributes, {
    relationships: { checks: toMany(MONITORING_TYPES.check, checks.map((c) => c.id)) },
    links: { self: sourceLink(source.id) },
  });
}

/** History import job; the user who started it goes to `included` (id and name only). */
export function historyImportResource(job: AdminHistoryImport, included: Included): ResourceObject {
  const { sourceId, createdBy, ...attributes } = job;
  if (createdBy) included.add(resource(MONITORING_TYPES.user, createdBy.id, { name: createdBy.name }));
  return resource(MONITORING_TYPES.historyImport, job.id, attributes, {
    relationships: {
      source: toOne(MONITORING_TYPES.source, sourceId),
      createdBy: toOne(MONITORING_TYPES.user, createdBy?.id ?? null),
    },
    links: { self: historyImportLink(sourceId, job.id) },
  });
}
