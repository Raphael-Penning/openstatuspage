/**
 * Schedules one poll task per enabled pull-capable monitoring source.
 *
 * STUB in feat/core, implemented together with the adapters.
 * `syncPollers` must be called on startup and whenever a monitoring source is
 * created, updated or deleted (the admin API does this).
 */
import type { AppContext } from '../context.js';

export async function syncPollers(_ctx: AppContext): Promise<void> {}
