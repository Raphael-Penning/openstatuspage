import { loadConfig } from '../config.js';
import { createDb, migrateToLatest } from '../db/index.js';
import { grantPublicRole } from '../db/public-role.js';

const config = loadConfig(process.env, { allowMissingSecret: true });
const db = await createDb(config);
await migrateToLatest(db);
console.log('Database is up to date.');
if (config.database.dialect === 'postgres') {
  // Same as on the start of an admin/worker instance (docs/security-model.md).
  const result = await grantPublicRole(db, config.DB_PUBLIC_ROLE);
  console.log(
    result === 'granted'
      ? `Public database role "${config.DB_PUBLIC_ROLE}" granted.`
      : `Public database role "${config.DB_PUBLIC_ROLE}" does not exist (only needed for APP_ROLE=public).`,
  );
}
await db.destroy();
