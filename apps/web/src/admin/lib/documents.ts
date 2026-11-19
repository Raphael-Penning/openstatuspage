/**
 * JSON:API request options of the admin catalog endpoints: the resource type of
 * each request document and the plain fields sent as relationships.
 *
 *   api.patch(`/api/admin/services/${id}`, body, { ...SERVICE_DOCUMENT, id });
 */
import type { RequestOptions } from '../../lib/api';

type DocumentOptions = Pick<RequestOptions, 'type' | 'relationships'>;

/** The group and locations of a service are relationships; check links are attributes. */
export const SERVICE_DOCUMENT: DocumentOptions = {
  type: 'services',
  relationships: { groupId: 'service-groups', locationIds: 'locations' },
};
/** Body of the reorder actions: `{ ids }` in the new display order. */
export const ORDERING_DOCUMENT: DocumentOptions = { type: 'orderings' };
export const GROUP_DOCUMENT: DocumentOptions = { type: 'service-groups' };
export const LOCATION_DOCUMENT: DocumentOptions = { type: 'locations' };
/** Affected services carry an impact per service and stay attributes. */
export const INCIDENT_DOCUMENT: DocumentOptions = { type: 'incidents', relationships: { locationIds: 'locations' } };
export const INCIDENT_UPDATE_DOCUMENT: DocumentOptions = { type: 'incident-updates' };
export const MAINTENANCE_DOCUMENT: DocumentOptions = {
  type: 'maintenances',
  relationships: { serviceIds: 'services', locationIds: 'locations' },
};
export const MAINTENANCE_UPDATE_DOCUMENT: DocumentOptions = { type: 'maintenance-updates' };
export const CORRECTION_DOCUMENT: DocumentOptions = { type: 'corrections', relationships: { serviceIds: 'services' } };
