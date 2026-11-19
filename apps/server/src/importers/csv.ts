/**
 * CSV history import. Strict parser, no I/O.
 *
 * Format (header row required, column order free, `,` or `;` as separator,
 * RFC 4180 quoting):
 *
 *   check,service,start,end,state
 *   web01!http,,2026-01-01T00:00:00Z,2026-01-01T02:30:00Z,critical
 *   ,checkout,2026-01-02T08:00:00Z,2026-01-02T09:00:00Z,major_outage
 *
 * - `check`: external id of a check of the source, or
 *   `service`: slug of a service (exactly one of both per row; either column may be omitted).
 * - `start`, `end`: ISO-8601 with time zone (`Z` or `+01:00`), start < end.
 * - `state`: check rows ok | warning | critical | unknown;
 *   service rows operational | degraded | partial_outage | major_outage | maintenance.
 *   `status` is accepted as the column name too.
 * - Rows of the same check or service must not overlap.
 */
import {
  CHECK_STATES,
  HISTORY_CSV_MAX_ROWS,
  SERVICE_STATUSES,
  type CheckState,
  type ServiceStatus,
} from '@openstatuspage/shared';
import { mergeAdjacent, type Valued } from '../lib/intervals.js';

/** A problem of the file; `code` and `params` are translated in the UI, `message` is the English fallback. */
export interface CsvError {
  line: number;
  code: string;
  params: Record<string, string | number>;
  message: string;
}

const issue = (line: number, code: string, message: string, params: Record<string, string | number> = {}): CsvError => ({
  line,
  code,
  params,
  message,
});

export interface ParsedHistoryCsv {
  checks: Map<string, Valued<CheckState>[]>;
  services: Map<string, Valued<ServiceStatus>[]>;
  rows: number;
}

export class CsvImportError extends Error {
  constructor(public readonly errors: CsvError[]) {
    super(`The CSV file is invalid: ${errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')}`);
    this.name = 'CsvImportError';
  }
}

const MAX_ERRORS = 20;
const BOM = String.fromCharCode(0xfeff);
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([zZ]|[+-]\d{2}:\d{2})$/;

/** Splits CSV text into records (array of fields) with their starting line numbers. */
export function parseCsvRecords(text: string, separator: string): { line: number; fields: string[] }[] {
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const pushRecord = () => {
    fields.push(field);
    if (!(fields.length === 1 && fields[0]!.trim() === '')) records.push({ line: recordLine, fields });
    fields = [];
    field = '';
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === separator) {
      fields.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      // handled by \n
    } else if (c === '\n' || c === '\r') {
      pushRecord();
      line++;
      recordLine = line;
    } else field += c;
    i++;
  }
  if (quoted) throw new CsvImportError([issue(recordLine, 'unterminated_quote', 'unterminated quoted field')]);
  if (field !== '' || fields.length > 0) pushRecord();
  return records;
}

export function parseHistoryCsv(input: string): ParsedHistoryCsv {
  const text = input.startsWith(BOM) ? input.slice(1) : input;
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const separator = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const records = parseCsvRecords(text, separator);
  const header = records.shift();
  if (!header) throw new CsvImportError([issue(1, 'empty', 'the file is empty')]);

  const columns = header.fields.map((h) => h.trim().toLowerCase());
  const index = (...names: string[]) => columns.findIndex((c) => names.includes(c));
  const col = {
    check: index('check'),
    service: index('service'),
    start: index('start'),
    end: index('end'),
    state: index('state', 'status'),
  };
  const missing: string[] = [];
  if (col.check < 0 && col.service < 0) missing.push('"check" or "service"');
  if (col.start < 0) missing.push('"start"');
  if (col.end < 0) missing.push('"end"');
  if (col.state < 0) missing.push('"state"');
  if (missing.length > 0) throw new CsvImportError([issue(header.line, 'missing_columns', `missing column ${missing.join(', ')}`, { columns: missing.join(', ') })]);
  if (records.length === 0) throw new CsvImportError([issue(header.line, 'no_rows', 'no data rows')]);
  if (records.length > HISTORY_CSV_MAX_ROWS) {
    throw new CsvImportError([issue(header.line, 'too_many_rows', `more than ${HISTORY_CSV_MAX_ROWS} data rows`, { max: HISTORY_CSV_MAX_ROWS })]);
  }

  const errors: CsvError[] = [];
  const fail = (line: number, code: string, message: string, params: Record<string, string | number> = {}) => {
    if (errors.length < MAX_ERRORS) errors.push(issue(line, code, message, params));
  };
  const checkRows = new Map<string, (Valued<CheckState> & { line: number })[]>();
  const serviceRows = new Map<string, (Valued<ServiceStatus> & { line: number })[]>();
  const get = (fields: string[], i: number) => (i >= 0 ? (fields[i] ?? '').trim() : '');

  for (const { line, fields } of records) {
    if (fields.length !== header.fields.length) {
      fail(line, 'field_count', `expected ${header.fields.length} fields, found ${fields.length}`, {
        expected: header.fields.length,
        found: fields.length,
      });
      continue;
    }
    const check = get(fields, col.check);
    const service = get(fields, col.service);
    const startText = get(fields, col.start);
    const endText = get(fields, col.end);
    const state = get(fields, col.state).toLowerCase();
    if ((check === '') === (service === '')) {
      fail(line, 'check_xor_service', 'set exactly one of "check" and "service"');
      continue;
    }
    if (check.length > 500 || service.length > 80) {
      fail(line, 'id_too_long', 'identifier too long');
      continue;
    }
    if (!ISO_WITH_ZONE.test(startText) || !ISO_WITH_ZONE.test(endText)) {
      fail(line, 'timestamp_format', 'start and end must be ISO-8601 timestamps with time zone, e.g. 2026-01-01T00:00:00Z');
      continue;
    }
    const start = Date.parse(startText);
    const end = Date.parse(endText);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      fail(line, 'invalid_date', 'invalid date');
      continue;
    }
    if (start >= end) {
      fail(line, 'start_not_before_end', 'start must be before end');
      continue;
    }
    if (check) {
      if (!(CHECK_STATES as readonly string[]).includes(state)) {
        fail(line, 'check_state', `state must be one of ${CHECK_STATES.join(', ')} for check rows`, { allowed: CHECK_STATES.join(', ') });
        continue;
      }
      const list = checkRows.get(check) ?? [];
      list.push({ start, end, value: state as CheckState, line });
      checkRows.set(check, list);
    } else {
      if (!(SERVICE_STATUSES as readonly string[]).includes(state)) {
        fail(line, 'service_status', `state must be one of ${SERVICE_STATUSES.join(', ')} for service rows`, {
          allowed: SERVICE_STATUSES.join(', '),
        });
        continue;
      }
      const list = serviceRows.get(service) ?? [];
      list.push({ start, end, value: state as ServiceStatus, line });
      serviceRows.set(service, list);
    }
  }

  const finish = <T>(rows: Map<string, (Valued<T> & { line: number })[]>, label: string) => {
    const out = new Map<string, Valued<T>[]>();
    for (const [id, list] of rows) {
      list.sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i++) {
        if (list[i]!.start < list[i - 1]!.end) fail(list[i]!.line, 'overlap', `overlaps line ${list[i - 1]!.line} of the same ${label}`, { other: list[i - 1]!.line, kind: label });
      }
      out.set(
        id,
        mergeAdjacent(list.map(({ start, end, value }) => ({ start, end, value }))),
      );
    }
    return out;
  };
  const checks = finish(checkRows, 'check');
  const services = finish(serviceRows, 'service');
  if (errors.length > 0) throw new CsvImportError(errors);
  return { checks, services, rows: records.length };
}
