/**
 * The poll limits must keep a hostile or broken monitoring endpoint from
 * exhausting the heap the image ships (docker/Dockerfile NODE_OPTIONS): a body
 * just under each bound is parsed, a body over a bound ends in an AdapterError,
 * and the process keeps running in both cases.
 */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_POLL_LIMITS } from '../../src/adapters/http.js';

const run = promisify(execFile);
const CHILD = fileURLToPath(new URL('./heap-child.ts', import.meta.url));
/** V8 flags of the image (docker/Dockerfile ENV NODE_OPTIONS and CMD). */
const IMAGE_FLAGS = ['--max-semi-space-size=1', '--max-old-space-size=96', '--max-opt=2'];
/**
 * Heap in use before the poll starts: twice the steady state of a running server
 * (about 27 MB after GC for APP_ROLE=all on SQLite), so the bounds keep a margin.
 */
const HEAP_IN_USE_MB = 54;

const { maxBytes, maxValues } = DEFAULT_POLL_LIMITS;

/** Distinct short strings that fill the body to just under the byte bound with `count` values. */
function stringArray(count: number): string {
  const width = Math.floor((maxBytes - 2) / count) - 1;
  const items: string[] = [];
  for (let i = 0; i < count; i++) items.push(JSON.stringify(i.toString(36).padStart(width - 2, 'x')));
  return `[${items.join(',')}]`;
}

const bodies: Record<string, () => string> = {
  // Empty objects up to the byte bound: about 2.8 million objects, the shape that aborted the process.
  'json-objects-over': () => `[${'{},'.repeat(Math.floor((maxBytes - 4) / 3))}{}]`,
  // Just under the value bound: as many objects as allowed ...
  'json-objects-under': () => `[${'{},'.repeat(Math.floor(maxValues / 2) - 10)}{}]`,
  // ... and as many distinct strings as allowed, filling the byte bound.
  'json-strings-under': () => stringArray(maxValues - 10),
  'json-bytes-over': () => JSON.stringify(['x'.repeat(maxBytes)]),
  // Bare samples up to the byte bound.
  'text-lines-over': () => 'm 1\n'.repeat(Math.floor(maxBytes / 4)),
  // Just under the value bound: samples with one label each, distinct values.
  'text-lines-under': () => {
    const lines: string[] = [];
    for (let i = 0; i < Math.floor(maxValues / 3) - 10; i++) lines.push(`m{a="${i.toString(36)}"} 1`);
    return lines.join('\n');
  },
};

let server: Server;
let base: string;

beforeAll(async () => {
  const gzipped = new Map(Object.entries(bodies).map(([name, make]) => [name, gzipSync(make())]));
  server = createServer((req, res) => {
    const body = gzipped.get(req.url!.slice(1));
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    // A few KB to a few hundred KB on the wire, megabytes after decompression.
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

interface ChildResult {
  ok: boolean;
  adapterError?: boolean;
  message?: string;
  length?: number;
}

async function pollInChild(name: string, kind: 'json' | 'text'): Promise<ChildResult> {
  // A crash (heap out of memory) rejects with the child's exit status.
  const { stdout } = await run(
    process.execPath,
    [...IMAGE_FLAGS, '--import', 'tsx', CHILD, `${base}/${name}`, kind, String(HEAP_IN_USE_MB)],
    { maxBuffer: 1024 * 1024, timeout: 60_000 },
  );
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as ChildResult;
}

describe('poll limits under the image heap cap', { timeout: 120_000 }, () => {
  it('rejects a body with too many JSON values before parsing it', async () => {
    const result = await pollInChild('json-objects-over', 'json');
    expect(result).toMatchObject({ ok: false, adapterError: true });
    expect(result.message).toContain(`more than ${maxValues} JSON values`);
  });

  it('parses JSON bodies just under the bounds', async () => {
    expect(await pollInChild('json-objects-under', 'json')).toMatchObject({ ok: true, length: Math.floor(maxValues / 2) - 9 });
    expect(await pollInChild('json-strings-under', 'json')).toMatchObject({ ok: true, length: maxValues - 10 });
  });

  it('rejects a body over the byte bound', async () => {
    const result = await pollInChild('json-bytes-over', 'json');
    expect(result).toMatchObject({ ok: false, adapterError: true });
    expect(result.message).toContain(`exceeds ${maxBytes / 1024 / 1024} MiB`);
  });

  it('bounds Prometheus text the same way', async () => {
    const over = await pollInChild('text-lines-over', 'text');
    expect(over).toMatchObject({ ok: false, adapterError: true });
    expect(over.message).toContain('too many lines or labels');
    expect(await pollInChild('text-lines-under', 'text')).toMatchObject({ ok: true, length: Math.floor(maxValues / 3) - 10 });
  });
});
