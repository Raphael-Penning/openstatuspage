import { matchRoutes, type RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import { adminRoutes } from './routes';

// Same order as router.tsx: anything the admin tree does not match falls through to NotFound.
const routes: RouteObject[] = [...adminRoutes, { path: '*', id: 'not-found' }];

const matchesAdmin = (path: string) => matchRoutes(routes, path)?.[0]?.route.path === '/admin';

describe('adminRoutes', () => {
  it('matches the management UI under /admin', () => {
    expect(matchesAdmin('/admin')).toBe(true);
    expect(matchesAdmin('/admin/users')).toBe(true);
  });

  it('does not render the management UI for case variants of /admin', () => {
    // The server only denies framing for the lower-case prefix.
    for (const path of ['/ADMIN', '/Admin/users', '/aDmIn/api-tokens']) {
      expect(matchesAdmin(path), path).toBe(false);
    }
  });
});
