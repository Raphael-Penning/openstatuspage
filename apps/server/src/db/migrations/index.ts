import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_initial.js';
import * as m0002 from './0002_email_subscriptions.js';
import * as m0003 from './0003_check_bundles.js';
import * as m0004 from './0004_history_corrections.js';
import * as m0005 from './0005_check_history.js';
import * as m0006 from './0006_subscription_token_hashes.js';
import * as m0007 from './0007_public_role.js';
import * as m0008 from './0008_task_leases.js';
import * as m0009 from './0009_private_pages.js';
import * as m0010 from './0010_poll_markers.js';
import * as m0011 from './0011_full_sync_guard.js';
import * as m0012 from './0012_definer_search_path.js';
import * as m0013 from './0013_schema_create_hardening.js';
import * as m0014 from './0014_site_pages_uploads.js';
import * as m0015 from './0015_notification_channels.js';
import * as m0016 from './0016_oidc_providers.js';

/**
 * Migrations are registered statically so they survive bundling.
 * Append new migrations here; never edit or reorder existing ones.
 */
export const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
  '0002_email_subscriptions': m0002,
  '0003_check_bundles': m0003,
  '0004_history_corrections': m0004,
  '0005_check_history': m0005,
  '0006_subscription_token_hashes': m0006,
  '0007_public_role': m0007,
  '0008_task_leases': m0008,
  '0009_private_pages': m0009,
  '0010_poll_markers': m0010,
  '0011_full_sync_guard': m0011,
  '0012_definer_search_path': m0012,
  '0013_schema_create_hardening': m0013,
  '0014_site_pages_uploads': m0014,
  '0015_notification_channels': m0015,
  '0016_oidc_providers': m0016,
};
