import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_initial.js';
import * as m0002 from './0002_email_subscriptions.js';

/**
 * Migrations are registered statically so they survive bundling.
 * Append new migrations here; never edit or reorder existing ones.
 */
export const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
  '0002_email_subscriptions': m0002,
};
