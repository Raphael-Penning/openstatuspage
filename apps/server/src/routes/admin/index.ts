import type { FastifyInstance } from 'fastify';
import { registerBundleRoutes } from './bundles.js';
import { registerContentRoutes } from './content.js';
import { registerCorrectionRoutes } from './corrections.js';
import { registerHistoryImportRoutes } from './history-imports.js';
import { registerIncidentRoutes } from './incidents.js';
import { registerLocationAndGroupRoutes } from './locations.js';
import { registerMaintenanceRoutes } from './maintenances.js';
import { registerMonitoringRoutes } from './monitoring.js';
import { registerOidcProviderRoutes } from './oidc-providers.js';
import { registerOverviewRoutes } from './overview.js';
import { registerPrivatePageRoutes } from './private-pages.js';
import { registerChannelRoutes } from './channels.js';
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
  await registerBundleRoutes(app);
  await registerHistoryImportRoutes(app);
  await registerUserRoutes(app);
  await registerSubscriberRoutes(app);
  await registerPrivatePageRoutes(app);
  await registerOidcProviderRoutes(app);
  await registerContentRoutes(app);
  await registerChannelRoutes(app);
}
