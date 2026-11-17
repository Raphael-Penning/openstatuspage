import type { AuditLogEntry } from '@openstatuspage/shared';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../lib/format';
import { Badge } from './ui';

/** Short human readable subject of an audit entry from its details (title, name, e-mail). */
export function auditSubject(entry: AuditLogEntry): string | null {
  const d = entry.details ?? {};
  for (const key of ['title', 'name', 'email', 'siteName'] as const) {
    const v = d[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

export function useAuditLabels() {
  const { t } = useTranslation('admin');
  return {
    action: (action: string) => t(`audit.actions.${action.replace(/\./g, '_')}`, { defaultValue: action }),
    entity: (type: string) => t(`audit.entities.${type}`, { defaultValue: type }),
    actor: (entry: AuditLogEntry) => {
      const token = entry.details?.apiToken;
      if (typeof token === 'string') return t('audit.viaToken', { name: token });
      return entry.userName ?? t('audit.system');
    },
  };
}

/** Compact list of audit entries (dashboard). */
export function AuditEntries({ entries }: { entries: AuditLogEntry[] }) {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const labels = useAuditLabels();
  if (entries.length === 0) return <p className="px-4 py-6 text-center text-sm text-muted">{t('audit.empty')}</p>;
  return (
    <ul className="divide-y divide-border">
      {entries.map((e) => {
        const subject = auditSubject(e);
        return (
          <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
            <div className="min-w-0">
              <span className="font-medium">{labels.action(e.action)}</span>
              {subject && <span className="text-muted"> · {subject}</span>}
              <div className="text-xs text-muted">{labels.actor(e)}</div>
            </div>
            <time dateTime={e.createdAt} title={fmt.dateTime(e.createdAt)} className="shrink-0 text-xs text-muted">
              {fmt.relative(e.createdAt)}
            </time>
          </li>
        );
      })}
    </ul>
  );
}

export function EntityBadge({ type }: { type: string }) {
  const labels = useAuditLabels();
  return <Badge>{labels.entity(type)}</Badge>;
}
