/**
 * "Import history" dialog of a monitoring source: range and credentials (or a
 * CSV file) → background fetch with progress → preview → confirm → result.
 * Opening it while an import of the source is active resumes that import.
 */
import type { AdminHistoryImport, AdminMonitorSource, HistoryCsvIssue, HistoryImportServicePreview } from '@openstatuspage/shared';
import { History } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../lib/api';
import {
  API_IMPORT_TYPES,
  csvIssueText,
  emptyImportForm,
  importFormToPayload,
  isRunning,
  jobErrorText,
  progressPercent,
  readCsvFile,
  durationParts,
  warningText,
  type HistoryImportFormValues,
  type ImportMethod,
} from '../lib/history-import';
import { useFormat } from '../lib/format';
import { useAdminMutation, useHistoryImport } from '../lib/queries';
import { Dialog } from './Dialog';
import { CheckboxField, DateTimeField, FieldShell, inputClass, TextField } from './fields';
import { Badge, Button, StatusBadge, td, th, tr } from './ui';

interface Props {
  source: AdminMonitorSource;
  /** Job to show right away (an active import of the source). */
  initialJobId: string | null;
  onClose: () => void;
}

export function HistoryImportDialog({ source, initialJobId, onClose }: Props) {
  const { t } = useTranslation('admin');
  const [jobId, setJobId] = useState<string | null>(initialJobId);
  const job = useHistoryImport(source.id, jobId);

  const title = t('historyImport.dialogTitle', { name: source.name });
  if (!jobId) return <ImportForm source={source} title={title} onStarted={setJobId} onClose={onClose} />;

  return (
    <JobView
      source={source}
      title={title}
      job={job.data}
      loadError={job.error}
      onRestart={() => setJobId(null)}
      onClose={onClose}
    />
  );
}

// ---------------------------------------------------------------------------
// Step 1: form
// ---------------------------------------------------------------------------

function ImportForm({
  source,
  title,
  onStarted,
  onClose,
}: {
  source: AdminMonitorSource;
  title: string;
  onStarted: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const formId = useId();
  const [v, setV] = useState<HistoryImportFormValues>(() => emptyImportForm(source.sourceType));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [csvIssues, setCsvIssues] = useState<HistoryCsvIssue[]>([]);
  const set = <K extends keyof HistoryImportFormValues>(key: K, value: HistoryImportFormValues[K]) => {
    setV((prev) => ({ ...prev, [key]: value }));
    setErrors((e) => {
      const { [key]: _removed, ...rest } = e;
      return rest;
    });
  };
  const apiCapable = API_IMPORT_TYPES.includes(source.sourceType);
  const stored = (key: string) => source.config[key] !== undefined && source.config[key] !== null && source.config[key] !== '';

  const start = useAdminMutation(
    (body: Record<string, unknown>) =>
      api.post<AdminHistoryImport>(`/api/admin/monitor-sources/${source.id}/history-imports`, body),
    {
      onSuccess: (job) => onStarted(job.id),
      onError: (error) => {
        if (error instanceof ApiError && error.status === 400 && Array.isArray(error.body?.issues)) {
          const issues = error.body.issues as unknown[];
          const lines = issues.filter((i): i is HistoryCsvIssue => typeof (i as HistoryCsvIssue)?.line === 'number');
          if (lines.length > 0) {
            setCsvIssues(lines);
            return true;
          }
        }
        return false;
      },
    },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const payload = importFormToPayload(v, source.sourceType);
    if (!payload.from) next.from = t('validation.required');
    if (!payload.to) next.to = t('validation.required');
    if (payload.from && payload.to && Date.parse(String(payload.from)) >= Date.parse(String(payload.to))) {
      next.to = t('historyImport.rangeOrder');
    }
    if (v.method === 'csv' && !v.csv) next.csv = t('historyImport.csvRequired');
    if (v.method === 'source' && source.sourceType === 'uptimekuma') {
      if (!v.username.trim() && !stored('historyUsername')) next.username = t('validation.required');
      if (!v.password && !stored('historyPassword')) next.password = t('validation.required');
      if (v.totp.trim() && !/^\d{6}$/.test(v.totp.trim())) next.totp = t('historyImport.totpInvalid');
    }
    if (v.method === 'source' && source.sourceType === 'icinga2' && !v.databaseUrl.trim() && !stored('icingaDbUrl')) {
      next.databaseUrl = t('validation.required');
    }
    setErrors(next);
    setCsvIssues([]);
    if (Object.keys(next).length === 0) start.mutate(payload);
  };

  const onFile = async (file: File | undefined) => {
    setCsvIssues([]);
    if (!file) {
      set('csv', '');
      set('csvName', '');
      return;
    }
    const res = await readCsvFile(file);
    if (!res.ok) {
      setV((prev) => ({ ...prev, csv: '', csvName: '' }));
      setErrors((e) => ({ ...e, csv: t('historyImport.csvTooLarge') }));
      return;
    }
    setV((prev) => ({ ...prev, csv: res.text, csvName: file.name }));
    setErrors(({ csv: _removed, ...rest }) => rest);
  };

  const fileId = useId();
  const methodName = useId();

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" form={formId} variant="primary" icon={History} pending={start.isPending}>
            {t('historyImport.loadPreview')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-4 text-sm">
        <p className="text-muted">{t('historyImport.intro')}</p>

        {apiCapable && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t('historyImport.method')}</legend>
            {(['source', 'csv'] as ImportMethod[]).map((m) => (
              <label key={m} className="flex items-start gap-2.5">
                <input
                  type="radio"
                  name={methodName}
                  value={m}
                  checked={v.method === m}
                  onChange={() => set('method', m)}
                  className="mt-0.5 size-4 accent-[var(--accent)]"
                />
                <span>{m === 'source' ? t('historyImport.methodSource', { type: t(`sources.types.${source.sourceType}`) }) : t('historyImport.methodCsv')}</span>
              </label>
            ))}
          </fieldset>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <DateTimeField label={t('historyImport.from')} value={v.from} onValue={(x) => set('from', x)} error={errors.from} required />
          <DateTimeField label={t('historyImport.to')} value={v.to} onValue={(x) => set('to', x)} error={errors.to} required />
        </div>

        {v.method === 'source' && source.sourceType === 'uptimekuma' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <p className="text-muted sm:col-span-2">{t('historyImport.kumaHelp')}</p>
            <TextField
              label={t('historyImport.username')}
              value={v.username}
              onValue={(x) => set('username', x)}
              autoComplete="off"
              error={errors.username}
              placeholder={stored('historyUsername') ? String(source.config.historyUsername) : undefined}
              help={stored('historyUsername') ? t('historyImport.storedUsed') : undefined}
              required={!stored('historyUsername')}
            />
            <TextField
              label={t('historyImport.password')}
              type="password"
              autoComplete="new-password"
              value={v.password}
              onValue={(x) => set('password', x)}
              error={errors.password}
              help={stored('historyPassword') ? t('historyImport.storedUsed') : t('historyImport.notStored')}
              required={!stored('historyPassword')}
            />
            <TextField
              label={t('historyImport.totp')}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={v.totp}
              onValue={(x) => set('totp', x)}
              error={errors.totp}
              help={t('historyImport.totpHelp')}
            />
          </div>
        )}
        {v.method === 'source' && source.sourceType === 'icinga2' && (
          <TextField
            label={t('historyImport.databaseUrl')}
            type="password"
            autoComplete="off"
            value={v.databaseUrl}
            onValue={(x) => set('databaseUrl', x)}
            error={errors.databaseUrl}
            placeholder="mysql://reader:••••@db.example.com:3306/icingadb"
            help={stored('icingaDbUrl') ? t('historyImport.storedUsed') : t('historyImport.databaseUrlHelp')}
            required={!stored('icingaDbUrl')}
          />
        )}
        {v.method === 'source' && source.sourceType === 'openitcockpit' && <p className="text-muted">{t('historyImport.oitcHelp')}</p>}

        {v.method === 'csv' && (
          <FieldShell id={fileId} label={t('historyImport.csvFile')} help={t('historyImport.csvHelp')} error={errors.csv} required>
            <input
              id={fileId}
              type="file"
              accept=".csv,text/csv,text/plain"
              className={inputClass}
              onChange={(e) => void onFile(e.target.files?.[0])}
              aria-invalid={errors.csv ? true : undefined}
              aria-describedby={errors.csv ? `${fileId}-error` : `${fileId}-help`}
              required
            />
          </FieldShell>
        )}
        {csvIssues.length > 0 && (
          <div role="alert" className="rounded-lg border border-status-major-outage/40 p-3">
            <p className="font-medium">{t('historyImport.csvInvalid')}</p>
            <ul className="mt-1 list-disc pl-5 text-muted">
              {csvIssues.map((i) => (
                <li key={`${i.line}-${i.message}`}>{t('historyImport.csvIssue', { line: i.line, message: csvIssueText(t, i) })}</li>
              ))}
            </ul>
          </div>
        )}

        <CheckboxField
          label={t('historyImport.onlyLinked')}
          help={t('historyImport.onlyLinkedHelp')}
          checked={v.onlyLinkedChecks}
          onChecked={(x) => set('onlyLinkedChecks', x)}
        />
        <p className="text-xs text-muted">{t('historyImport.gapsOnly')}</p>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Step 2-4: progress, preview, result
// ---------------------------------------------------------------------------

function useDuration() {
  const { t } = useTranslation('admin');
  return (ms: number) => {
    const { d, h, min } = durationParts(ms);
    const parts: string[] = [];
    if (d > 0) parts.push(t('historyImport.duration.d', { count: d }));
    if (h > 0) parts.push(t('historyImport.duration.h', { count: h }));
    if (min > 0 || parts.length === 0) parts.push(t('historyImport.duration.min', { count: min }));
    return parts.join(' ');
  };
}

function JobView({
  source,
  title,
  job,
  loadError,
  onRestart,
  onClose,
}: {
  source: AdminMonitorSource;
  title: string;
  job: AdminHistoryImport | undefined;
  loadError: unknown;
  onRestart: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const base = `/api/admin/monitor-sources/${source.id}/history-imports/${job?.id}`;
  const apply = useAdminMutation(() => api.post<AdminHistoryImport>(`${base}/apply`), {});
  const cancel = useAdminMutation(() => api.post<AdminHistoryImport>(`${base}/cancel`), {
    success: t('historyImport.cancelled'),
  });

  let body = <p className="text-sm text-muted">{loadError ? t('errors.server') : t('common:loading')}</p>;
  let footer = <Button onClick={onClose}>{t('common:actions.close')}</Button>;

  if (job && isRunning(job.status)) {
    body = <Progress job={job} />;
    footer = (
      <>
        <Button onClick={onClose}>{t('historyImport.runInBackground')}</Button>
        {job.status === 'fetching' && (
          <Button variant="danger" pending={cancel.isPending} onClick={() => cancel.mutate()}>
            {t('historyImport.cancel')}
          </Button>
        )}
      </>
    );
  } else if (job?.status === 'ready' && job.preview) {
    body = <Preview job={job} />;
    footer = (
      <>
        <Button pending={cancel.isPending} onClick={() => cancel.mutate()}>
          {t('historyImport.discard')}
        </Button>
        <Button variant="primary" pending={apply.isPending} onClick={() => apply.mutate()}>
          {t('historyImport.apply')}
        </Button>
      </>
    );
  } else if (job) {
    body = <Outcome job={job} />;
    footer = (
      <>
        <Button onClick={onRestart}>{t('historyImport.newImport')}</Button>
        <Button variant="primary" onClick={onClose}>
          {t('common:actions.close')}
        </Button>
      </>
    );
  }

  return (
    <Dialog open wide onClose={onClose} title={title} footer={footer}>
      {body}
    </Dialog>
  );
}

function Progress({ job }: { job: AdminHistoryImport }) {
  const { t } = useTranslation('admin');
  const percent = progressPercent(job);
  const phase = job.progress?.phase ?? 'queued';
  const label = job.status === 'applying' ? t('historyImport.writing') : t(`historyImport.phase.${phase}`, { defaultValue: phase });
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p aria-live="polite">{label}</p>
      <div
        role="progressbar"
        aria-label={t('historyImport.progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent === null ? label : `${percent} %`}
        className="h-2 overflow-hidden rounded-full bg-surface-2"
      >
        <div className={'h-full bg-accent ' + (percent === null ? 'w-1/3 animate-pulse' : '')} style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
      {job.progress && job.progress.total > 0 && (
        <p className="text-muted">{t('historyImport.progressCount', { done: job.progress.done, total: job.progress.total })}</p>
      )}
      <p className="text-xs text-muted">{t('historyImport.backgroundHint')}</p>
    </div>
  );
}

function Preview({ job }: { job: AdminHistoryImport }) {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  const duration = useDuration();
  const p = job.preview!;
  const pct = (n: number | null) => (n === null ? '–' : `${fmt.number(n)} %`);
  const filled = p.services.filter((s) => s.filledMs > 0);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>
        {t('historyImport.previewSummary', {
          from: fmt.dateTime(p.from),
          to: fmt.dateTime(p.to),
          checks: p.checks.filter((c) => c.intervals > 0).length,
          services: filled.length,
        })}
      </p>
      {p.warnings.length > 0 && (
        <ul className="list-disc rounded-lg border border-status-degraded/40 py-2 pr-3 pl-7">
          {p.warnings.map((w) => (
            <li key={`${w.code}-${w.message}`}>{warningText(t, w, fmt.dateTime)}</li>
          ))}
        </ul>
      )}

      <section aria-labelledby="hi-services">
        <h3 id="hi-services" className="mb-2 font-semibold">
          {t('historyImport.servicesTitle')}
        </h3>
        {p.services.length === 0 ? (
          <p className="text-muted">{t('historyImport.noServices')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <caption className="sr-only">{t('historyImport.servicesTitle')}</caption>
              <thead>
                <tr>
                  <th scope="col" className={th}>{t('historyImport.col.service')}</th>
                  <th scope="col" className={th}>{t('historyImport.col.gap')}</th>
                  <th scope="col" className={th}>{t('historyImport.col.filled')}</th>
                  <th scope="col" className={th}>{t('historyImport.col.down')}</th>
                  <th scope="col" className={th}>{t('historyImport.col.uptime')}</th>
                </tr>
              </thead>
              <tbody>
                {p.services.map((s) => (
                  <tr key={s.serviceId} className={tr}>
                    <th scope="row" className={td + ' font-medium'}>
                      {s.name}
                      {s.skipped && (
                        <div className="mt-1">
                          <Badge tone="neutral">{t(`historyImport.skipped.${s.skipped}`)}</Badge>
                        </div>
                      )}
                      {s.segments.length > 0 && <Segments service={s} />}
                    </th>
                    <td className={td}>{duration(s.gapMs)}</td>
                    <td className={td}>{duration(s.filledMs)}</td>
                    <td className={td}>{duration(s.downMs)}</td>
                    <td className={td}>
                      {t('historyImport.uptimeChange', { before: pct(s.uptimeBefore), after: pct(s.uptime) })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="hi-checks">
        <h3 id="hi-checks" className="mb-2 font-semibold">
          {t('historyImport.checksTitle')}
        </h3>
        {p.checks.length === 0 ? (
          <p className="text-muted">{t('historyImport.noChecks')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <caption className="sr-only">{t('historyImport.checksTitle')}</caption>
              <thead>
                <tr>
                  <th scope="col" className={th}>{t('historyImport.col.check')}</th>
                  <th scope="col" className={th}>{t('historyImport.col.intervals')}</th>
                  <th scope="col" className={th}>{t('historyImport.col.covered')}</th>
                  <th scope="col" className={th}>{t('historyImport.col.period')}</th>
                </tr>
              </thead>
              <tbody>
                {p.checks.map((c) => (
                  <tr key={c.checkId} className={tr}>
                    <th scope="row" className={td + ' font-medium'}>
                      {c.host ? `${c.host} · ${c.name}` : c.name}
                    </th>
                    <td className={td}>{fmt.number(c.intervals)}</td>
                    <td className={td}>{duration(c.coveredMs)}</td>
                    <td className={td}>{c.firstAt && c.lastAt ? `${fmt.dateTime(c.firstAt)} – ${fmt.dateTime(c.lastAt)}` : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {p.checksWithoutData > 0 && <p className="mt-2 text-muted">{t('historyImport.checksWithoutData', { count: p.checksWithoutData })}</p>}
        {p.unmatchedCount > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-muted">{t('historyImport.unmatched', { count: p.unmatchedCount })}</summary>
            <ul className="mt-1 list-disc pl-5 font-mono text-xs break-all">
              {p.unmatched.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
      <p className="text-xs text-muted">{t('historyImport.applyHint')}</p>
    </div>
  );
}

function Segments({ service }: { service: HistoryImportServicePreview }) {
  const { t } = useTranslation('admin');
  const fmt = useFormat();
  return (
    <details className="mt-1 font-normal">
      <summary className="cursor-pointer text-xs text-muted">{t('historyImport.segments', { count: service.segmentCount })}</summary>
      <ul className="mt-1 flex flex-col gap-1 text-xs">
        {service.segments.map((s) => (
          <li key={s.startedAt} className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s.status} />
            <span className="text-muted">
              {fmt.dateTime(s.startedAt)} – {fmt.dateTime(s.endedAt)}
            </span>
          </li>
        ))}
      </ul>
      {service.segmentCount > service.segments.length && (
        <p className="mt-1 text-xs text-muted">{t('historyImport.moreSegments', { count: service.segmentCount - service.segments.length })}</p>
      )}
    </details>
  );
}

function Outcome({ job }: { job: AdminHistoryImport }) {
  const { t } = useTranslation('admin');
  const error = jobErrorText(t, job);
  if (job.status === 'completed' && job.result) {
    return (
      <p role="status" className="text-sm">
        {t('historyImport.completed', {
          intervals: job.result.checkIntervals,
          segments: job.result.serviceSegments,
          services: job.result.services,
        })}
      </p>
    );
  }
  if (job.status === 'failed') {
    return (
      <div role="alert" className="flex flex-col gap-1 text-sm">
        <p className="font-medium">{t('historyImport.failed')}</p>
        {error && <p className="text-muted break-words">{error}</p>}
      </div>
    );
  }
  return (
    <p role="status" className="text-sm">
      {error ?? t('historyImport.cancelled')}
    </p>
  );
}
