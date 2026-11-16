/**
 * Public status page routes. Owned by the public UI; mounted at "/".
 */
import type { RouteObject } from 'react-router';

function Placeholder() {
  return <div className="p-8 text-muted">Public status page</div>;
}

export const publicRoutes: RouteObject[] = [{ path: '/', element: <Placeholder /> }];
