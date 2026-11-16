import { loadConfig } from '../config.js';
import { createDb, migrateToLatest } from '../db/index.js';

const db = await createDb(loadConfig());
await migrateToLatest(db);
await db.destroy();
console.log('Database is up to date.');
