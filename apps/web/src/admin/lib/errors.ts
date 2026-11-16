import type { TFunction } from 'i18next';
import { ApiError } from '../../lib/api';

/** Human readable, localized message for an API or network error. */
export function apiErrorMessage(error: unknown, t: TFunction<'admin'>): string {
  if (error instanceof ApiError) {
    const detail = error.body?.message;
    switch (error.status) {
      case 400:
        return error.body?.issues ? t('errors.validation') : withDetail(t('errors.badRequest'), detail);
      case 401:
        return t('errors.unauthorized');
      case 403:
        return t('errors.forbidden');
      case 404:
        return t('errors.notFound');
      case 409:
        return withDetail(t('errors.conflict'), detail);
      case 429:
        return t('errors.rateLimited');
      default:
        return t('errors.server');
    }
  }
  return t('errors.network');
}

/** Server messages are English; they are appended as detail to the localized text. */
function withDetail(message: string, detail: string | undefined): string {
  return detail ? `${message} (${detail})` : message;
}

export const isApiStatus = (error: unknown, status: number): boolean =>
  error instanceof ApiError && error.status === status;
