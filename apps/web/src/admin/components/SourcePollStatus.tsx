import type { AdminMonitorSource } from '@openstatuspage/shared';
import { CircleCheck, CircleX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../lib/format';
import { isPullType } from '../lib/source-form';

export function SourcePollStatus({ source }: { source: AdminMonitorSource }) {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  if (!isPullType(source.type)) return <span className="text-sm text-muted">{t('sources.pushOnly')}</span>;
  if (source.lastPollOk === null) return <span className="text-sm text-muted">{t('sources.neverPolled')}</span>;
  return (
    <div className="text-sm">
      <span className={`inline-flex items-center gap-1 ${source.lastPollOk ? 'text-status-operational-text' : 'text-status-major-outage-text'}`}>
        {source.lastPollOk ? <CircleCheck aria-hidden className="size-4" /> : <CircleX aria-hidden className="size-4" />}
        {source.lastPollOk ? t('sources.pollOk') : t('sources.pollError')}
      </span>
      <span className="ml-1.5 text-xs text-muted" title={fmt.dateTime(source.lastPollAt)}>
        {fmt.relative(source.lastPollAt)}
      </span>
      {!source.lastPollOk && source.lastError && (
        <p className="mt-0.5 max-w-xs text-xs break-words text-status-major-outage-text">{source.lastError}</p>
      )}
    </div>
  );
}
