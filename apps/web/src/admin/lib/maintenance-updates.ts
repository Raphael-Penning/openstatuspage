/**
 * Initial values of the maintenance update forms (post update and the
 * start / complete / cancel dialog). "Notify subscribers" starts from the
 * maintenance's stored flag, so a maintenance created without notifications
 * does not email subscribers by accident. (Incident forms default to on.)
 */
import type { AdminMaintenance, MaintenanceStatus } from '@openstatuspage/shared';

export interface PostUpdateValues {
  status: MaintenanceStatus;
  message: string;
  notify: boolean;
}

export interface TransitionValues {
  message: string;
  notify: boolean;
}

/** Empty "post update" form for a maintenance; also used to reset it after posting. */
export function postUpdateDefaults(maintenance: Pick<AdminMaintenance, 'status' | 'notify'>): PostUpdateValues {
  return { status: maintenance.status, message: '', notify: maintenance.notify };
}

/** Transition dialog with its pre-filled (localized) message. */
export function transitionDefaults(maintenance: Pick<AdminMaintenance, 'notify'>, message: string): TransitionValues {
  return { message, notify: maintenance.notify };
}
