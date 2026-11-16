/**
 * Public status page routes. Owned by the public UI; mounted at "/".
 *
 * Feed items link to /incidents/:id and /maintenance/:id (see the server's
 * routes/feeds.ts); keep these paths stable.
 */
import type { RouteObject } from 'react-router';
import { HistoryPage } from './pages/HistoryPage';
import { IncidentPage } from './pages/IncidentPage';
import { LocationsPage } from './pages/LocationsPage';
import { MaintenancePage } from './pages/MaintenancePage';
import { NotFoundState } from './pages/NotFoundState';
import { OverviewPage } from './pages/OverviewPage';
import { ServiceDetailPage } from './pages/ServiceDetailPage';
import { ServicesPage } from './pages/ServicesPage';
import { PublicLayout } from './PublicLayout';

export const publicRoutes: RouteObject[] = [
  {
    path: '/',
    element: <PublicLayout />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'services', element: <ServicesPage /> },
      { path: 'services/:slug', element: <ServiceDetailPage /> },
      { path: 'locations', element: <LocationsPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'incidents/:id', element: <IncidentPage /> },
      { path: 'maintenance/:id', element: <MaintenancePage /> },
      // Unknown public paths render inside the layout. /admin/* is matched by
      // the admin routes, which are more specific.
      { path: '*', element: <NotFoundState /> },
    ],
  },
];
