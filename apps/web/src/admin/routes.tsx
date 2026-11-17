/**
 * Management UI routes. Owned by the admin UI; mounted at "/admin".
 */
import type { RouteObject } from 'react-router';

function Placeholder() {
  return <div className="p-8 text-muted">Admin</div>;
}

export const adminRoutes: RouteObject[] = [{ path: '/admin', element: <Placeholder /> }];
