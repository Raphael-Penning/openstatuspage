import { loadConfig } from '../config.js';
import { createDb, migrateToLatest } from '../db/index.js';
import { publicSchemaHint, setUpPublicRole } from '../db/public-role.js';

const config = loadConfig(process.env, { allowMissingSecret: true });
const db = await createDb(config);
await migrateToLatest(db);
console.log('Database is up to date.');
if (config.database.dialect === 'postgres') {
  // Same as on the start of an admin/worker instance (docs/security-model.md).
  const result = await setUpPublicRole(db, config.DB_PUBLIC_ROLE);
  if (result.schema === 'created') console.log('Public schema osp_public created.');
  console.log(
    result.grant === 'granted'
      ? `Public database role "${config.DB_PUBLIC_ROLE}" granted.`
      : result.grant === 'no-schema'
        ? `Note: ${publicSchemaHint()}.`
        : `Public database role "${config.DB_PUBLIC_ROLE}" does not exist (only needed for APP_ROLE=public).`,
  );
}
await db.destroy();
