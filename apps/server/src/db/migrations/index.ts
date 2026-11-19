import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_initial.js';
import * as m0002 from './0002_email_subscriptions.js';
import * as m0003 from './0003_check_bundles.js';
import * as m0004 from './0004_history_corrections.js';

/**
 * Migrations are registered statically so they survive bundling.
 * Append new migrations here; never edit or reorder existing ones.
 */
export const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
  '0002_email_subscriptions': m0002,
  '0003_check_bundles': m0003,
  '0004_history_corrections': m0004,
};
