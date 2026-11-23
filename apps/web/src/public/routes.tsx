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
import { isPrivatePageToken, isUptimeDay, normalizePrivatePageToken, SYSTEM_PAGE_KEYS } from '@openstatuspage/shared';
import { privateQueries, publicQueries } from './hooks/queries';
import { subscriptionQuery } from './hooks/subscriptions';
import type { PublicRouteHandle } from './loaders';
import { HistoryPage, historyQuery } from './pages/HistoryPage';
import { IncidentPage } from './pages/IncidentPage';
import { LocationsPage } from './pages/LocationsPage';
import { MaintenancePage } from './pages/MaintenancePage';
import { NotFoundState } from './pages/NotFoundState';
import { OverviewPage } from './pages/OverviewPage';
import { PrivateOverviewPage, PrivatePageRoot } from './pages/PrivatePage';
import { ServiceDayPage } from './pages/ServiceDayPage';
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
        // One day of the uptime bar (UTC). A malformed date is "not found" without asking the API.
        path: 'services/:slug/days/:date',
        element: <ServiceDayPage />,
        handle: handle({
          prefetch: async ({ params, load, get }) => {
            const date = params.date ?? '';
            if (isUptimeDay(date)) await load(publicQueries.serviceDay(params.slug ?? '', date, get));
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
      // Links carry the token in the query (older ones in the fragment, which only the browser sees).
      { path: 'subscription/confirm', element: <SubscriptionConfirmPage /> },
      {
        path: 'subscription/manage',
        element: <SubscriptionManagePage />,
        handle: handle({
          prefetch: async ({ search, load, get }) => {
            const id = search.get('id')?.trim();
            const token = search.get('token')?.trim();
            if (!id || !token) return;
            await Promise.all([load(subscriptionQuery(id, token, get)), load(publicQueries.summary(get))]);
          },
        }),
      },
      // Content pages (about, legal pages, custom pages): loaded lazily with their Markdown
      // renderer. The server renders them like every other page; the browser loads the
      // route module before it hydrates (hydrate.tsx).
      ...SYSTEM_PAGE_KEYS.map(
        (key): RouteObject => ({
          path: key,
          lazy: async () => ({ Component: (await import('./pages/ContentPage')).systemPage(key) }),
          handle: handle({ prefetch: ({ load, get }) => load(publicQueries.page(key, get)) }),
        }),
      ),
      {
        path: 'pages/:slug',
        lazy: async () => ({ Component: (await import('./pages/ContentPage')).CustomContentPage }),
        handle: handle({ prefetch: ({ params, load, get }) => load(publicQueries.page(params.slug ?? '', get)) }),
      },
      // Unknown public paths render inside the layout. /admin/* is matched by
      // the admin routes, which are more specific.
      { path: '*', element: <NotFoundState /> },
    ],
  },
  {
    // Private pages: the token is part of the path (never cached, never indexed, no analytics),
    // in any case (base32: /p/<TOKEN> is the same page). A malformed token is "not found" without asking the API.
    path: '/p/:token',
    element: <PrivatePageRoot />,
    children: [
      {
        index: true,
        element: <PrivateOverviewPage />,
        handle: handle({
          prefetch: async ({ params, load, get }) => {
            const token = normalizePrivatePageToken(params.token ?? '');
            if (isPrivatePageToken(token)) await load(privateQueries.page(token, get));
          },
        }),
      },
      {
        path: 'services/:slug',
        element: <ServiceDetailPage />,
        handle: handle({
          prefetch: async ({ params, load, get }) => {
            const token = normalizePrivatePageToken(params.token ?? '');
            if (isPrivatePageToken(token)) await load(privateQueries.service(token, params.slug ?? '', get));
          },
        }),
      },
      {
        path: 'services/:slug/days/:date',
        element: <ServiceDayPage />,
        handle: handle({
          prefetch: async ({ params, load, get }) => {
            const token = normalizePrivatePageToken(params.token ?? '');
            const date = params.date ?? '';
            if (isPrivatePageToken(token) && isUptimeDay(date)) await load(privateQueries.serviceDay(token, params.slug ?? '', date, get));
          },
        }),
      },
      {
        path: 'incidents/:id',
        element: <IncidentPage />,
        handle: handle({
          prefetch: async ({ params, load, get }) => {
            const token = normalizePrivatePageToken(params.token ?? '');
            if (isPrivatePageToken(token)) await load(privateQueries.incident(token, params.id ?? '', get));
          },
        }),
      },
      {
        path: 'maintenance/:id',
        element: <MaintenancePage />,
        handle: handle({
          prefetch: async ({ params, load, get }) => {
            const token = normalizePrivatePageToken(params.token ?? '');
            if (isPrivatePageToken(token)) await load(privateQueries.maintenance(token, params.id ?? '', get));
          },
        }),
      },
      { path: '*', element: <NotFoundState /> },
    ],
  },
];
