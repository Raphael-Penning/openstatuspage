/**
 * Management UI routes, mounted at "/admin". Every page is loaded lazily so the
 * public status page bundle does not contain the admin code.
 */
import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';

type PageModule = { default: ComponentType };

/** Lazy route for a module whose default export is the page component. */
const page = (load: () => Promise<PageModule>): Pick<RouteObject, 'lazy'> => ({
  lazy: async () => ({ Component: (await load()).default }),
});

/** Same as `page`, wrapped in the admin-only guard. */
const adminPage = (load: () => Promise<PageModule>): Pick<RouteObject, 'lazy'> => ({
  lazy: async () => {
    const [{ default: Page }, { AdminOnly }] = await Promise.all([load(), import('./shell')]);
    return { Component: () => <AdminOnly><Page /></AdminOnly> };
  },
});

export const adminRoutes: RouteObject[] = [
  {
    path: '/admin',
    // The server denies framing only for /admin/... (lower case). React Router
    // matches case-insensitively by default, so without this /ADMIN/... would
    // render the management UI on a response that may be framed.
    caseSensitive: true,
    lazy: async () => ({ Component: (await import('./session')).AdminRoot }),
    children: [
      { path: 'login', ...page(() => import('./pages/LoginPage')) },
      {
        lazy: async () => ({ Component: (await import('./shell')).AdminShell }),
        children: [
          { index: true, ...page(() => import('./pages/DashboardPage')) },
          { path: 'incidents', ...page(() => import('./pages/incidents/IncidentListPage')) },
          { path: 'incidents/new', ...page(() => import('./pages/incidents/IncidentCreatePage')) },
          { path: 'incidents/:id', ...page(() => import('./pages/incidents/IncidentDetailPage')) },
          { path: 'maintenance', ...page(() => import('./pages/maintenance/MaintenanceListPage')) },
          { path: 'maintenance/new', ...page(() => import('./pages/maintenance/MaintenanceFormPage')) },
          { path: 'maintenance/:id', ...page(() => import('./pages/maintenance/MaintenanceDetailPage')) },
          { path: 'maintenance/:id/edit', ...page(() => import('./pages/maintenance/MaintenanceFormPage')) },
          { path: 'corrections', ...page(() => import('./pages/CorrectionsPage')) },
          { path: 'services', ...page(() => import('./pages/services/ServiceListPage')) },
          { path: 'services/new', ...adminPage(() => import('./pages/services/ServiceEditPage')) },
          { path: 'services/:id', ...page(() => import('./pages/services/ServiceEditPage')) },
          { path: 'groups', ...page(() => import('./pages/GroupsPage')) },
          { path: 'locations', ...page(() => import('./pages/locations/LocationListPage')) },
          { path: 'locations/new', ...adminPage(() => import('./pages/locations/LocationEditPage')) },
          { path: 'locations/:id', ...page(() => import('./pages/locations/LocationEditPage')) },
          { path: 'monitoring', ...adminPage(() => import('./pages/monitoring/SourceListPage')) },
          { path: 'monitoring/new', ...adminPage(() => import('./pages/monitoring/SourceEditPage')) },
          { path: 'monitoring/checks', ...page(() => import('./pages/monitoring/ChecksPage')) },
          { path: 'monitoring/bundles', ...adminPage(() => import('./pages/monitoring/BundlesPage')) },
          { path: 'monitoring/:id', ...adminPage(() => import('./pages/monitoring/SourceEditPage')) },
          { path: 'settings', ...adminPage(() => import('./pages/SettingsPage')) },
          { path: 'appearance', ...adminPage(() => import('./pages/AppearancePage')) },
          { path: 'users', ...adminPage(() => import('./pages/UsersPage')) },
          { path: 'subscribers', ...adminPage(() => import('./pages/SubscribersPage')) },
          { path: 'notifications', ...adminPage(() => import('./pages/NotificationChannelsPage')) },
          { path: 'api-tokens', ...adminPage(() => import('./pages/ApiTokensPage')) },
          { path: 'private-pages', ...adminPage(() => import('./pages/PrivatePagesPage')) },
          { path: 'sso', ...adminPage(() => import('./pages/SsoProvidersPage')) },
          { path: 'pages', ...adminPage(() => import('./pages/SitePagesPage')) },
          { path: 'audit-log', ...adminPage(() => import('./pages/AuditLogPage')) },
          // Help area for every signed-in user; the guide markdown lives in docs/guide.
          { path: 'help', ...page(() => import('../help/HelpPage')) },
          { path: 'help/:topic', ...page(() => import('../help/HelpPage')) },
          // The OpenAPI description of the HTTP API with "try it" (its own chunk).
          { path: 'api', ...page(() => import('./pages/ApiDocsPage')) },
          { path: '*', ...page(() => import('./pages/AdminNotFound')) },
        ],
      },
    ],
  },
];
