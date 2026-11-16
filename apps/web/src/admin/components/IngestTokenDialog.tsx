import type { MonitorSourceType } from '@openstatuspage/shared';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CopyField } from './CopyField';
import { Dialog } from './Dialog';
import { Button } from './ui';

/** Push endpoint for a source type (the generic endpoint accepts every type). */
export function typedIngestUrl(ingestUrl: string, type: MonitorSourceType): string {
  return type === 'webhook' ? ingestUrl : `${ingestUrl}/${type}`;
}

/** Shows the ingest URL and token once, with short integration hints. */
export function IngestTokenDialog({
  open,
  onClose,
  type,
  ingestUrl,
  token,
}: {
  open: boolean;
  onClose: () => void;
  type: MonitorSourceType;
  ingestUrl: string;
  token: string;
}) {
  const { t } = useTranslation('admin');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('ingest.title')}
      wide
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('ingest.done')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="flex items-start gap-2 rounded-lg bg-status-degraded/10 px-3 py-2 text-sm text-status-degraded">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t('ingest.onceWarning')}
        </p>
        <CopyField label={t('ingest.url')} value={typedIngestUrl(ingestUrl, type)} />
        {type !== 'webhook' && <CopyField label={t('ingest.genericUrl')} value={ingestUrl} />}
        <CopyField label={t('ingest.token')} value={token} secret />
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3 text-sm">
          <p className="font-medium">{t('ingest.howTo')}</p>
          <p className="text-muted">{t(`ingest.hints.${type}`)}</p>
          <p className="text-muted">{t('ingest.authHint')}</p>
          <p className="text-muted">
            {t('ingest.docs')}{' '}
            <code className="rounded bg-surface px-1 py-0.5 text-xs">{type === 'webhook' ? 'docs/api.md' : `docs/adapters/${type}.md`}</code>
          </p>
        </div>
      </div>
    </Dialog>
  );
}
