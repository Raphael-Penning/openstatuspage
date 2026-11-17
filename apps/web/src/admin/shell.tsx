/**
 * Authenticated part of the management UI: session guard + layout.
 */
import type { ReactNode } from 'react';
import { AdminLayout } from './components/AdminLayout';
import { RequireAdmin, RequireSession } from './session';

export function AdminShell() {
  return (
    <RequireSession>
      <AdminLayout />
    </RequireSession>
  );
}

export function AdminOnly({ children }: { children: ReactNode }) {
  return <RequireAdmin>{children}</RequireAdmin>;
}
