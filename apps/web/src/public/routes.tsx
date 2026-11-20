/**
 * Public status page routes. Owned by the public UI; mounted at "/".
 *
 * Feed items link to /incidents/:id and /maintenance/:id (see the server's
 * routes/feeds.ts) and notification emails to /subscription/confirm and
 * /subscription/manage; keep these paths stable.
 *
 * `handle.prefetch` lists the queries a page reads on its first render; the
 * server runs it before rendering the page (see loaders.ts).
 */
import type { RouteObject } from 'react-router';
import { publicQueries } from './hooks/queries';
import type { PublicRouteHandle } from './loaders';
import { HistoryPage, historyQuery } from './pages/HistoryPage';
import { IncidentPage } from './pages/IncidentPage';
import { LocationsPage } from './pages/LocationsPage';
import { MaintenancePage } from './pages/MaintenancePage';
import { NotFoundState } from './pages/NotFoundState';
import { OverviewPage } from './pages/OverviewPage';
import { ServiceDetailPage } from './pages/ServiceDetailPage';
import { ServicesPage } from './pages/ServicesPage';
import { SubscribePage } from './pages/SubscribePage';
import { SubscriptionConfirmPage } from './pages/SubscriptionConfirmPage';
import { SubscriptionManagePage } from './pages/SubscriptionManagePage';
import { PublicLayout } from './PublicLayout';

const handle = (h: PublicRouteHandle) => h;

export const publicRoutes: RouteObject[] = [
  {
    path: '/',
    element: <PublicLayout />,
    children: [
      {
        index: true,
        element: <OverviewPage />,
        handle: handle({ prefetch: ({ load, get }) => load(publicQueries.summary(get)) }),
      },
      {
        path: 'services',
        element: <ServicesPage />,
        handle: handle({ prefetch: ({ load, get }) => load(publicQueries.services(get)) }),
      },
      {
        path: 'services/:slug',
        element: <ServiceDetailPage />,
        handle: handle({
          prefetch: async ({ params, settings, load, get }) => {
            const service = await load(publicQueries.service(params.slug ?? '', get));
            if (settings.showLocations && (service?.locationIds.length ?? 0) > 0) await load(publicQueries.locations(get));
          },
        }),
      },
      {
        path: 'locations',
        element: <LocationsPage />,
        handle: handle({
          prefetch: async ({ settings, load, get }) => (settings.showLocations ? load(publicQueries.locations(get)) : undefined),
        }),
      },
      {
        path: 'history',
        element: <HistoryPage />,
        handle: handle({
          prefetch: ({ search, settings, load, get }) =>
            Promise.all([
              load(publicQueries.services(get)),
              settings.showLocations ? load(publicQueries.locations(get)) : undefined,
              load(publicQueries.history(historyQuery(search, settings.showLocations), get)),
            ]),
        }),
      },
      {
        path: 'incidents/:id',
        element: <IncidentPage />,
        handle: handle({ prefetch: ({ params, load, get }) => load(publicQueries.incident(params.id ?? '', get)) }),
      },
      {
        path: 'maintenance/:id',
        element: <MaintenancePage />,
        handle: handle({ prefetch: ({ params, load, get }) => load(publicQueries.maintenance(params.id ?? '', get)) }),
      },
      {
        path: 'subscribe',
        element: <SubscribePage />,
        handle: handle({ prefetch: ({ load, get }) => load(publicQueries.summary(get)) }),
      },
      // The link token is in the URL fragment: these pages load their data in the browser.
      { path: 'subscription/confirm', element: <SubscriptionConfirmPage /> },
      { path: 'subscription/manage', element: <SubscriptionManagePage /> },
      // Unknown public paths render inside the layout. /admin/* is matched by
      // the admin routes, which are more specific.
      { path: '*', element: <NotFoundState /> },
    ],
  },
];
