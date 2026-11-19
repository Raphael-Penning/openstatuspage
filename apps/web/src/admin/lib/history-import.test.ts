import { HISTORY_CSV_MAX_CHARS, HistoryImportCreateInput, type AdminHistoryImport } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import {
  activeImport,
  durationParts,
  emptyImportForm,
  importFormToPayload,
  progressPercent,
  csvIssueText,
  jobErrorText,
  readCsvFile,
  warningText,
} from './history-import';

const job = (over: Partial<AdminHistoryImport>): AdminHistoryImport => ({
  id: 'j',
  sourceId: 's',
  status: 'completed',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-02T00:00:00.000Z',
  onlyLinkedChecks: true,
  progress: null,
  preview: null,
  result: null,
  error: null,
  errorCode: null,
  createdBy: null,
  createdAt: '2026-01-03T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z',
  finishedAt: null,
  ...over,
});

describe('history import form', () => {
  it('defaults to the source API when the type has one, CSV otherwise', () => {
    expect(emptyImportForm('uptimekuma').method).toBe('source');
    expect(emptyImportForm('webhook').method).toBe('csv');
    const v = emptyImportForm('icinga2');
    expect(Date.parse(v.to) - Date.parse(v.from)).toBeGreaterThan(89 * 86_400_000);
  });

  it('builds a valid payload with only the credentials of the source type', () => {
    const v = {
      ...emptyImportForm('uptimekuma'),
      from: '2026-01-01T00:00',
      to: '2026-01-31T00:00',
      username: ' reader ',
      password: 'pw',
      totp: '',
      databaseUrl: 'mysql://ignored@db.example.com/x',
    };
    const payload = importFormToPayload(v, 'uptimekuma');
    expect(payload.credentials).toEqual({ username: 'reader', password: 'pw' });
    expect(HistoryImportCreateInput.safeParse(payload).success).toBe(true);

    const icinga = importFormToPayload({ ...v, databaseUrl: ' mysql://reader:x@db.example.com/icingadb ' }, 'icinga2');
    expect(icinga.credentials).toEqual({ databaseUrl: 'mysql://reader:x@db.example.com/icingadb' });

    const stored = importFormToPayload({ ...v, username: '', password: '' }, 'uptimekuma');
    expect(stored.credentials).toBeUndefined();

    const csv = importFormToPayload({ ...v, method: 'csv', csv: 'check,start,end,state\n' }, 'webhook');
    expect(csv).toMatchObject({ csv: 'check,start,end,state\n' });
    expect(csv.credentials).toBeUndefined();
  });

  it('rejects CSV files over the limit before uploading', async () => {
    const small = await readCsvFile(new File(['check,start,end,state\n'], 'h.csv'));
    expect(small).toEqual({ ok: true, text: 'check,start,end,state\n' });
    const big = { size: HISTORY_CSV_MAX_CHARS + 1, text: async () => '' } as unknown as File;
    expect(await readCsvFile(big)).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('history import helpers', () => {
  it('finds the active job', () => {
    expect(activeImport([job({ id: 'a' }), job({ id: 'b', status: 'ready' })])?.id).toBe('b');
    expect(activeImport([job({ status: 'failed' })])).toBeUndefined();
    expect(activeImport(undefined)).toBeUndefined();
  });

  it('splits durations and computes progress', () => {
    expect(durationParts(((2 * 24 + 3) * 60 + 4) * 60_000 + 20_000)).toEqual({ d: 2, h: 3, min: 4 });
    expect(durationParts(-5)).toEqual({ d: 0, h: 0, min: 0 });
    expect(progressPercent(job({ progress: { phase: 'fetching', done: 1, total: 4 } }))).toBe(25);
    expect(progressPercent(job({ progress: { phase: 'connecting', done: 0, total: 0 } }))).toBeNull();
  });
});

describe('server messages', () => {
  // A fake t: known keys are rendered with their options, unknown ones fall back.
  const known = new Set([
    'historyImport.warning.kuma_retention',
    'historyImport.csvIssues.overlap_service',
    'historyImport.error.apply_failed',
    'historyImport.error.expired',
  ]);
  const t = (key: string, options: Record<string, unknown> = {}) => {
    const { defaultValue, ...rest } = options;
    return known.has(key) ? `${key} ${JSON.stringify(rest)}` : String(defaultValue);
  };

  it('translates warnings by code and formats dates', () => {
    const w = { code: 'kuma_retention', params: { earliest: '2026-01-01T00:00:00.000Z' }, message: 'English' };
    expect(warningText(t, w, () => '1/1/2026')).toBe('historyImport.warning.kuma_retention {"earliest":"1/1/2026"}');
    expect(warningText(t, { code: 'new_code', params: {}, message: 'English fallback' })).toBe('English fallback');
  });

  it('translates CSV issues, including the kind of an overlap', () => {
    expect(csvIssueText(t, { code: 'overlap', params: { other: 2, kind: 'service' }, message: 'x' })).toBe(
      'historyImport.csvIssues.overlap_service {"other":2,"kind":"service"}',
    );
    expect(csvIssueText(t, { code: 'unknown', params: {}, message: 'fallback' })).toBe('fallback');
  });

  it('translates job errors and keeps the detail', () => {
    expect(jobErrorText(t, job({ errorCode: 'expired', error: 'The preview expired.' }))).toBe('historyImport.error.expired {"message":"The preview expired."}');
    expect(jobErrorText(t, job({ errorCode: 'apply_failed', error: 'Applying failed, nothing was written: disk full' }))).toBe(
      'historyImport.error.apply_failed {"message":"disk full"}',
    );
    expect(jobErrorText(t, job({ errorCode: null, error: null }))).toBeNull();
  });
});
