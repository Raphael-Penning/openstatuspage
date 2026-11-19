import { describe, expect, it } from 'vitest';
import { CsvImportError, parseCsvRecords, parseHistoryCsv } from '../../src/importers/csv.js';

const t = (iso: string) => Date.parse(iso);

function errorsOf(text: string) {
  try {
    parseHistoryCsv(text);
  } catch (err) {
    if (err instanceof CsvImportError) return err.errors;
    throw err;
  }
  throw new Error('expected a CsvImportError');
}

describe('CSV records', () => {
  it('handles quotes, escaped quotes, CRLF and blank lines', () => {
    const records = parseCsvRecords('a,b\r\n"x, y","say ""hi"""\r\n\r\nlast,"multi\nline"\n', ',');
    expect(records).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['x, y', 'say "hi"'] },
      { line: 4, fields: ['last', 'multi\nline'] },
    ]);
  });
});

describe('parseHistoryCsv', () => {
  it('parses check and service rows, merges touching rows, accepts ";" and a BOM', () => {
    const csv = [
      `${String.fromCharCode(0xfeff)}check;service;start;end;state`,
      'web01!http;;2026-01-01T00:00:00Z;2026-01-01T02:00:00Z;OK',
      'web01!http;;2026-01-01T02:00:00Z;2026-01-01T04:00:00+01:00;ok',
      'web01!http;;2026-01-01T03:00:00Z;2026-01-01T04:00:00Z;critical',
      ';checkout;2026-01-02T08:00:00Z;2026-01-02T09:00:00Z;major_outage',
    ].join('\n');
    const parsed = parseHistoryCsv(csv);
    expect(parsed.rows).toBe(4);
    // 04:00+01:00 = 03:00Z; states are case-insensitive.
    expect(parsed.checks.get('web01!http')).toEqual([
      { start: t('2026-01-01T00:00:00Z'), end: t('2026-01-01T03:00:00Z'), value: 'ok' },
      { start: t('2026-01-01T03:00:00Z'), end: t('2026-01-01T04:00:00Z'), value: 'critical' },
    ]);
    expect(parsed.services.get('checkout')).toEqual([
      { start: t('2026-01-02T08:00:00Z'), end: t('2026-01-02T09:00:00Z'), value: 'major_outage' },
    ]);
  });

  it('merges adjacent rows of the same state', () => {
    const parsed = parseHistoryCsv(
      [
        'check,start,end,status',
        'db,2026-01-01T00:00:00Z,2026-01-01T01:00:00Z,ok',
        'db,2026-01-01T01:00:00Z,2026-01-01T02:00:00Z,ok',
        'db,2026-01-01T02:00:00Z,2026-01-01T03:00:00Z,warning',
      ].join('\n'),
    );
    expect(parsed.checks.get('db')).toEqual([
      { start: t('2026-01-01T00:00:00Z'), end: t('2026-01-01T02:00:00Z'), value: 'ok' },
      { start: t('2026-01-01T02:00:00Z'), end: t('2026-01-01T03:00:00Z'), value: 'warning' },
    ]);
  });

  it('rejects missing columns and empty files', () => {
    expect(errorsOf('check,start,state\n')[0]!.message).toContain('"end"');
    expect(errorsOf('')[0]!.message).toBe('the file is empty');
    expect(errorsOf('check,start,end,state\n')[0]!.message).toBe('no data rows');
  });

  it('reports invalid rows with line numbers', () => {
    const errors = errorsOf(
      [
        'check,service,start,end,state',
        'a,,2026-01-01T00:00:00Z,2026-01-01T01:00:00Z,ok',
        'a,s,2026-01-01T00:00:00Z,2026-01-01T01:00:00Z,ok',
        'b,,2026-01-01 00:00,2026-01-01T01:00:00Z,ok',
        'c,,2026-01-01T00:00:00,2026-01-01T01:00:00Z,ok',
        'd,,2026-01-01T02:00:00Z,2026-01-01T01:00:00Z,ok',
        'e,,2026-01-01T00:00:00Z,2026-01-01T01:00:00Z,down',
        ',f,2026-01-01T00:00:00Z,2026-01-01T01:00:00Z,critical',
        'a,,2026-01-01T00:30:00Z,2026-01-01T02:00:00Z,critical',
        'too,few',
      ].join('\n'),
    );
    expect(errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7, 8, 10, 9]);
    expect(errors.find((e) => e.line === 9)!.message).toContain('overlaps line 2');
    expect(errors.find((e) => e.line === 8)!.message).toContain('for service rows');
  });
});
