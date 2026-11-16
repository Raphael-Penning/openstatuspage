import { SettingsInput, type PublicPageSettings } from '@openstatuspage/shared';
import type { DB } from '../db/index.js';
import { nowIso } from '../lib/time.js';

const SETTINGS_KEY = 'page';

export const DEFAULT_SETTINGS: PublicPageSettings = SettingsInput.parse({ siteName: 'Status' });

/** Page settings, merged over defaults so new options get sensible values. */
export async function getSettings(db: DB): Promise<PublicPageSettings> {
  const row = await db.selectFrom('settings').select('value').where('key', '=', SETTINGS_KEY).executeTakeFirst();
  if (!row) return DEFAULT_SETTINGS;
  const merged = { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<PublicPageSettings>) };
  const parsed = SettingsInput.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(db: DB, settings: PublicPageSettings): Promise<PublicPageSettings> {
  const value = JSON.stringify(settings);
  const now = nowIso();
  const exists = await db.selectFrom('settings').select('key').where('key', '=', SETTINGS_KEY).executeTakeFirst();
  if (exists) {
    await db.updateTable('settings').set({ value, updated_at: now }).where('key', '=', SETTINGS_KEY).execute();
  } else {
    await db.insertInto('settings').values({ key: SETTINGS_KEY, value, updated_at: now }).execute();
  }
  return settings;
}
