/**
 * Small parser for the Prometheus text exposition format (version 0.0.4).
 * Comments (`# HELP`, `# TYPE`) and blank lines are skipped; malformed lines
 * are counted and skipped instead of failing the whole document. Overlong
 * lines and value tokens count as malformed: the input comes from a remote
 * system and is parsed synchronously on the event loop.
 */

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
  timestamp?: number;
}

export interface PromParseResult {
  samples: PromSample[];
  /** Number of non-comment lines that could not be parsed. */
  invalidLines: number;
}

const NAME_START = /[a-zA-Z_:]/;
const NAME_CHAR = /[a-zA-Z0-9_:]/;
const LABEL_START = /[a-zA-Z_]/;
const LABEL_CHAR = /[a-zA-Z0-9_]/;

/**
 * Longest line that is parsed at all. Real exposition lines are far shorter;
 * the cap bounds the work an untrusted /metrics body can cause per line.
 */
export const MAX_LINE_LENGTH = 16 * 1024;
/** Longest sample value token (a float64 needs about 25 characters). */
export const MAX_VALUE_LENGTH = 64;
/**
 * Float syntax without overlapping quantifiers, so a failing match is linear
 * in the token length instead of quadratic (no catastrophic backtracking).
 */
const FLOAT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Whether `raw` is a plain decimal float; exported so its linear runtime stays tested. */
export function isPromFloat(raw: string): boolean {
  return FLOAT.test(raw);
}

export function parsePrometheusText(text: string): PromParseResult {
  const samples: PromSample[] = [];
  let invalidLines = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sample = line.length <= MAX_LINE_LENGTH ? parseLine(line) : null;
    if (sample) samples.push(sample);
    else invalidLines++;
  }
  return { samples, invalidLines };
}

function parseLine(line: string): PromSample | null {
  let i = 0;
  const n = line.length;

  // Metric name
  if (!NAME_START.test(line[i] ?? '')) return null;
  const nameStart = i;
  while (i < n && NAME_CHAR.test(line[i]!)) i++;
  const name = line.slice(nameStart, i);

  const labels: Record<string, string> = {};
  if (line[i] === '{') {
    i++;
    for (;;) {
      while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
      if (line[i] === '}') {
        i++;
        break;
      }
      // Label name
      if (!LABEL_START.test(line[i] ?? '')) return null;
      const ls = i;
      while (i < n && LABEL_CHAR.test(line[i]!)) i++;
      const labelName = line.slice(ls, i);
      while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
      if (line[i] !== '=') return null;
      i++;
      while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
      if (line[i] !== '"') return null;
      i++;
      // Label value with escapes \\ \" \n
      let value = '';
      let closed = false;
      while (i < n) {
        const c = line[i]!;
        if (c === '\\') {
          const next = line[i + 1];
          if (next === 'n') value += '\n';
          else if (next === '\\') value += '\\';
          else if (next === '"') value += '"';
          else if (next === undefined) return null;
          else value += `\\${next}`;
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        value += c;
        i++;
      }
      if (!closed) return null;
      labels[labelName] = value;
      while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
      if (line[i] === ',') {
        i++;
        continue;
      }
      if (line[i] === '}') {
        i++;
        break;
      }
      return null;
    }
  }

  // Value and optional timestamp
  const rest = line.slice(i).trim().split(/[ \t]+/);
  if (rest.length < 1 || rest.length > 2 || !rest[0]) return null;
  const value = parseValue(rest[0]);
  if (value === null) return null;
  const sample: PromSample = { name, labels, value };
  if (rest[1] !== undefined) {
    const ts = Number(rest[1]);
    if (!Number.isFinite(ts)) return null;
    sample.timestamp = ts;
  }
  return sample;
}

function parseValue(raw: string): number | null {
  switch (raw) {
    case '+Inf':
    case 'Inf':
      return Number.POSITIVE_INFINITY;
    case '-Inf':
      return Number.NEGATIVE_INFINITY;
    case 'NaN':
      return Number.NaN;
  }
  if (raw.length > MAX_VALUE_LENGTH || !isPromFloat(raw)) return null;
  return Number(raw);
}
