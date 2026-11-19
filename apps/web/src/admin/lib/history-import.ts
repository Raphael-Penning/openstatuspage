/**
 * Form model and helpers of the history import dialog (pure, unit tested).
 */
import {
  HISTORY_CSV_MAX_CHARS,
  type AdminHistoryImport,
  type HistoryCsvIssue,
  type HistoryImportStatus,
  type HistoryImportWarning,
  type MonitorSourceType,
} from '@openstatuspage/shared';
import { localInputToIso, nowLocalInput } from './datetime';

export type ImportMethod = 'source' | 'csv';

export interface HistoryImportFormValues {
  method: ImportMethod;
  from: string;
  to: string;
  onlyLinkedChecks: boolean;
  username: string;
  password: string;
  totp: string;
  databaseUrl: string;
  csv: string;
  csvName: string;
}

/** Source types with a history API; all others import CSV only. */
export const API_IMPORT_TYPES: readonly MonitorSourceType[] = ['icinga2', 'uptimekuma', 'openitcockpit'];

export const DEFAULT_IMPORT_DAYS = 90;

export function emptyImportForm(type: MonitorSourceType): HistoryImportFormValues {
  return {
    method: API_IMPORT_TYPES.includes(type) ? 'source' : 'csv',
    from: nowLocalInput(-DEFAULT_IMPORT_DAYS * 24 * 60),
    to: nowLocalInput(),
    onlyLinkedChecks: true,
    username: '',
    password: '',
    totp: '',
    databaseUrl: '',
    csv: '',
    csvName: '',
  };
}

/** HistoryImportCreateInput payload; empty optional fields are left out. */
export function importFormToPayload(v: HistoryImportFormValues, type: MonitorSourceType) {
  const payload: Record<string, unknown> = {
    from: localInputToIso(v.from) ?? '',
    to: localInputToIso(v.to) ?? '',
    onlyLinkedChecks: v.onlyLinkedChecks,
  };
  if (v.method === 'csv') {
    payload.csv = v.csv;
    return payload;
  }
  const credentials: Record<string, string> = {};
  if (type === 'uptimekuma') {
    if (v.username.trim()) credentials.username = v.username.trim();
    if (v.password) credentials.password = v.password;
    if (v.totp.trim()) credentials.totp = v.totp.trim();
  }
  if (type === 'icinga2' && v.databaseUrl.trim()) credentials.databaseUrl = v.databaseUrl.trim();
  if (Object.keys(credentials).length > 0) payload.credentials = credentials;
  return payload;
}

/** Reads a CSV file; rejects files over the server limit before uploading. */
export async function readCsvFile(file: File): Promise<{ ok: true; text: string } | { ok: false; reason: 'too_large' }> {
  if (file.size > HISTORY_CSV_MAX_CHARS) return { ok: false, reason: 'too_large' };
  const text = await file.text();
  if (text.length > HISTORY_CSV_MAX_CHARS) return { ok: false, reason: 'too_large' };
  return { ok: true, text };
}

export const isRunning = (status: HistoryImportStatus) => status === 'fetching' || status === 'applying';
export const isActive = (status: HistoryImportStatus) => isRunning(status) || status === 'ready';

/** The job the dialog should show first: an active one, if any. */
export function activeImport(jobs: AdminHistoryImport[] | undefined): AdminHistoryImport | undefined {
  return jobs?.find((j) => isActive(j.status));
}

/** Days, hours and minutes of a duration (rounded to minutes). */
export function durationParts(ms: number): { d: number; h: number; min: number } {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  return { d: Math.floor(minutes / 1440), h: Math.floor((minutes % 1440) / 60), min: minutes % 60 };
}

/** Progress in percent, or null when unknown. */
export function progressPercent(job: Pick<AdminHistoryImport, 'progress'>): number | null {
  const p = job.progress;
  if (!p || p.total <= 0) return null;
  return Math.min(100, Math.round((p.done / p.total) * 100));
}

// ---------------------------------------------------------------------------
// Server messages: the server sends codes with parameters and an English
// fallback; known codes are translated, unknown ones show the fallback.
// ---------------------------------------------------------------------------

/** Minimal translate function (i18next `t` of the admin namespace). */
export type Translate = (key: string, options: Record<string, unknown>) => string;

/** A preview warning in the UI language. `fmtDate` formats ISO timestamps in parameters. */
export function warningText(t: Translate, w: HistoryImportWarning, fmtDate: (iso: string) => string = (x) => x): string {
  const params: Record<string, unknown> = { ...w.params };
  if (typeof params.earliest === 'string') params.earliest = fmtDate(params.earliest);
  return t(`historyImport.warning.${w.code}`, { ...params, defaultValue: w.message });
}

/** A CSV issue (without the line number) in the UI language. */
export function csvIssueText(t: Translate, issue: Pick<HistoryCsvIssue, 'code' | 'params' | 'message'>): string {
  if (!issue.code) return issue.message;
  const key = issue.code === 'overlap' ? `overlap_${String(issue.params?.kind ?? 'check')}` : issue.code;
  return t(`historyImport.csvIssues.${key}`, { ...(issue.params ?? {}), defaultValue: issue.message });
}

/** Why a job failed or was cancelled by the server; null when a user cancelled it. */
export function jobErrorText(t: Translate, job: Pick<AdminHistoryImport, 'error' | 'errorCode'>): string | null {
  if (!job.errorCode) return job.error;
  const message = (job.error ?? '').replace(/^Applying failed, nothing was written: /, '');
  return t(`historyImport.error.${job.errorCode}`, { message, defaultValue: job.error ?? '' });
}
