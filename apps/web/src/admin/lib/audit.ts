/**
 * Entity types offered by the audit log filter. Keep in sync with the
 * entity types the server writes (auditRequest / audit calls) and with
 * `audit.entities` in the admin locales.
 */
export const AUDIT_ENTITY_TYPES = [
  'incident',
  'maintenance',
  'correction',
  'service',
  'service_group',
  'location',
  'monitor_source',
  'check',
  'check_bundle',
  'settings',
  'user',
  'api_token',
  'private_page',
  'oidc_provider',
  'page',
  'upload',
  'subscriber',
  'notifications',
  'theme',
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
