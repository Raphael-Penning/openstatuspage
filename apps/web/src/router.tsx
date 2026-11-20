import type { RouteObject } from 'react-router';
import { adminRoutes } from './admin/routes';
import { NotFound } from './components/NotFound';
import { publicRoutes } from './public/routes';

/**
 * Everything (index.html): public pages and the management UI. The public-only
 * route list lives in public-router.tsx, which must never import the admin routes.
 */
export const routes: RouteObject[] = [...publicRoutes, ...adminRoutes, { path: '*', element: <NotFound /> }];
