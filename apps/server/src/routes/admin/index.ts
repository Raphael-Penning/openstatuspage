import type { FastifyInstance } from 'fastify';
import { registerCorrectionRoutes } from './corrections.js';
import { registerIncidentRoutes } from './incidents.js';
import { registerLocationAndGroupRoutes } from './locations.js';
import { registerMaintenanceRoutes } from './maintenances.js';
import { registerMonitoringRoutes } from './monitoring.js';
import { registerOverviewRoutes } from './overview.js';
import { registerServiceRoutes } from './services.js';
import { registerSubscriberRoutes } from './subscribers.js';
import { registerUserRoutes } from './users.js';

/** /api/admin/*: every route declares its role with `editor` / `admin` from ./util.ts. */
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await registerOverviewRoutes(app);
  await registerLocationAndGroupRoutes(app);
  await registerServiceRoutes(app);
  await registerIncidentRoutes(app);
  await registerMaintenanceRoutes(app);
  await registerCorrectionRoutes(app);
  await registerMonitoringRoutes(app);
  await registerUserRoutes(app);
  await registerSubscriberRoutes(app);
}
