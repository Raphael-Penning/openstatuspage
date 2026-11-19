import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_initial.js';
import * as m0002 from './0002_email_subscriptions.js';
import * as m0003 from './0003_check_bundles.js';
import * as m0005 from './0005_check_history.js';

/**
 * Migrations are registered statically so they survive bundling.
 * Append new migrations here; never edit or reorder existing ones.
 *
 * 0004 is reserved for the history corrections migration (another branch).
 * Kysely refuses to start when a migration sorts before one that is already
 * applied, so 0004 must be merged and released before or together with 0005
 * (otherwise renumber at merge time).
 */
export const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
  '0002_email_subscriptions': m0002,
  '0003_check_bundles': m0003,
  '0005_check_history': m0005,
};
