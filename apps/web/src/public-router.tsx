import type { RouteObject } from 'react-router';
import { NotFound } from './components/NotFound';
import { publicRoutes } from './public/routes';

/**
 * Public pages only (public.html, APP_ROLE=public). Never import ./admin here:
 * the server tells public from admin files by what public.html reaches.
 */
export const publicOnlyRoutes: RouteObject[] = [...publicRoutes, { path: '*', element: <NotFound /> }];
