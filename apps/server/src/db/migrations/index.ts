import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_initial.js';
import * as m0002 from './0002_email_subscriptions.js';
import * as m0004 from './0004_history_corrections.js';

/**
 * Migrations are registered statically so they survive bundling.
 * Append new migrations here; never edit or reorder existing ones.
 *
 * 0003 (check bundles) lands with a separate change and must be registered
 * before any release ships 0004: the Migrator rejects running an older
 * migration on a database that already ran a newer one.
 */
export const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
  '0002_email_subscriptions': m0002,
  '0004_history_corrections': m0004,
};
