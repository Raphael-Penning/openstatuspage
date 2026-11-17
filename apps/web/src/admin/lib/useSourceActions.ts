import type { AdminMonitorSource, MonitorSourceTestResult } from '@openstatuspage/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { useToast } from '../components/Toast';
import { isApiStatus } from './errors';
import { useAdminMutation } from './queries';

/** Test / poll / rotate-token actions of a monitoring source with toast feedback. */
export function useSourceActions() {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const [token, setToken] = useState<{ source: AdminMonitorSource; token: string } | null>(null);

  const report = (r: MonitorSourceTestResult) => {
    const text = r.checkCount !== undefined ? `${r.message} (${t('sources.checkCount', { count: r.checkCount })})` : r.message;
    if (r.ok) toast.success(text);
    else toast.error(text);
  };
  // Test and poll are provided by the adapters; older servers answer 404.
  const unavailable = (err: unknown) => {
    if (isApiStatus(err, 404)) {
      toast.error(t('sources.actionUnavailable'));
      return true;
    }
    return false;
  };

  const test = useAdminMutation(
    (s: AdminMonitorSource) => api.post<MonitorSourceTestResult>(`/api/admin/monitor-sources/${s.id}/test`),
    { onSuccess: report, onError: unavailable },
  );
  const poll = useAdminMutation(
    (s: AdminMonitorSource) => api.post<MonitorSourceTestResult>(`/api/admin/monitor-sources/${s.id}/poll`),
    { onSuccess: report, onError: unavailable },
  );
  const rotate = useAdminMutation(
    (s: AdminMonitorSource) => api.post<{ ingestToken: string }>(`/api/admin/monitor-sources/${s.id}/rotate-token`),
    { success: t('sources.tokenRotated'), onSuccess: (r, s) => setToken({ source: s, token: r.ingestToken }) },
  );

  return { test, poll, rotate, token, clearToken: () => setToken(null) };
}
