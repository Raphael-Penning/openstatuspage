import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AdapterError,
  basicAuth,
  countJsonValues,
  countTextValues,
  createAdapterFetch,
  describeTransportError,
  describeUrl,
  insecureFetch,
  joinUrl,
  MAX_ERROR_BODY_BYTES,
  MAX_RESPONSE_BYTES,
  readBodyLimited,
  requestJson,
  requestText,
} from '../../src/adapters/http.js';
import { redactSecrets } from '../../src/adapters/runner.js';
import { jsonResponse, mockFetch } from './helpers.js';

// The only port assigned to this test suite.
const PORT = 3102;
const BASE = `http://127.0.0.1:${PORT}`;

let server: Server;
// Decompresses to just over MAX_RESPONSE_BYTES while only ~50 KiB go over the wire.
let gzipBomb: Buffer;

beforeAll(async () => {
  gzipBomb = gzipSync(Buffer.alloc(MAX_RESPONSE_BYTES + 1024, 'a'));
  server = createServer((req, res) => {
    if (req.url === '/gzip-bomb') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(gzipBomb);
      return;
    }
    if (req.url === '/declared-huge') {
      // Announces more than the limit and then stalls: the client must not wait for it.
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(MAX_RESPONSE_BYTES + 1) });
      res.write('a');
      return;
    }
    if (req.url === '/json') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-multi': ['a', 'b'] });
        res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization ?? null, body }));
      });
      return;
    }
    if (req.url === '/two-mib') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(Buffer.alloc(2 * 1024 * 1024, 'a'));
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 2000).unref();
      return;
    }
    if (req.url === '/partial') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first chunk');
      return;
    }
    if (req.url === '/empty') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('url helpers', () => {
  it('strips credentials, query and fragment', () => {
    expect(describeUrl('https://user:pass@mon.example.com:8443/api/x?token=abc#frag')).toBe(
      'https://mon.example.com:8443/api/x',
    );
    expect(describeUrl('not a url')).toBe('(invalid URL)');
  });

  it('joins paths', () => {
    expect(joinUrl('https://kuma.example.com/', '/metrics')).toBe('https://kuma.example.com/metrics');
    expect(joinUrl('https://example.com/kuma', 'metrics')).toBe('https://example.com/kuma/metrics');
  });

  it('encodes basic auth', () => {
    expect(basicAuth('', 'key')).toBe(`Basic ${Buffer.from(':key').toString('base64')}`);
  });
});

describe('insecureFetch', () => {
  it('performs requests and returns a standard Response', async () => {
    const res = await insecureFetch(`${BASE}/json`, {
      method: 'POST',
      headers: { authorization: 'Basic abc', 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-multi')).toBe('a, b');
    expect(await res.json()).toEqual({ method: 'POST', auth: 'Basic abc', body: '{"a":1}' });
  });

  it('handles empty responses', async () => {
    const res = await insecureFetch(`${BASE}/empty`);
    expect(res.status).toBe(204);
  });

  it('honours abort signals', async () => {
    await expect(insecureFetch(`${BASE}/slow`, { signal: AbortSignal.timeout(50) })).rejects.toThrow();
  });

  it('rejects when aborted in the middle of the body', async () => {
    await expect(insecureFetch(`${BASE}/partial`, { signal: AbortSignal.timeout(100) })).rejects.toThrow();
  });
});

describe('createAdapterFetch', () => {
  it.each([true, false])('applies the request timeout (verifyTls=%s)', async (verifyTls) => {
    const f = createAdapterFetch({ verifyTls, timeoutMs: 50 });
    const err = await requestJson(f, `${BASE}/slow`, { system: 'Test' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as Error).message).toBe(`Test: request to ${BASE}/slow failed: timed out`);
  });

  it.each([true, false])('works for plain requests (verifyTls=%s)', async (verifyTls) => {
    const f = createAdapterFetch({ verifyTls });
    await expect(requestJson(f, `${BASE}/json`, { system: 'Test' })).resolves.toMatchObject({ method: 'GET' });
  });

  it('reports refused connections', async () => {
    const f = createAdapterFetch({ verifyTls: false });
    // Port 1 is never listening locally.
    const err = (await requestJson(f, 'http://127.0.0.1:1/x', { system: 'Test' }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain('connection refused');
  });
});

describe('requestJson errors', () => {
  it('includes status, short JSON detail and a hint', async () => {
    const { fetch } = mockFetch(() => jsonResponse({ message: 'Forbidden for this user' }, 403));
    await expect(requestJson(fetch, 'https://a:b@mon.example.com/x?apikey=1', { system: 'Mon' })).rejects.toThrow(
      'Mon returned HTTP 403 for https://mon.example.com/x: Forbidden for this user – the API user lacks the required permissions.',
    );
  });

  it('does not echo non-JSON error bodies', async () => {
    const { fetch } = mockFetch(() => new Response('<html>secret stuff</html>', { status: 500 }));
    const err = (await requestJson(fetch, 'https://mon.example.com/x', { system: 'Mon' }).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('Mon returned HTTP 500 for https://mon.example.com/x');
  });

  it('never passes URL credentials or query strings of transport errors on', async () => {
    // undici quotes the complete URL in this message.
    const err = (await requestJson(fetch, 'https://svc:url-pass-123@mon.example.com/x?apikey=key-456', { system: 'Mon' }).catch(
      (e: Error) => e,
    )) as Error;
    expect(err).toBeInstanceOf(AdapterError);
    expect(err.message).toContain('https://mon.example.com/x');
    expect(err.message).not.toMatch(/url-pass-123|key-456|svc:/);
    expect(describeTransportError(new Error('failed for http://u:p@h.example.com:8080/a?b=c#d and ftp://x@y.example.com'))).toBe(
      'failed for http://h.example.com:8080/a and ftp://y.example.com/',
    );
  });

  it('describes TLS and DNS failures', () => {
    expect(describeTransportError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }))).toMatch(
      /TLS certificate verification failed .* disable TLS verification/,
    );
    expect(describeTransportError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x' })).toBe(
      'host name could not be resolved (ENOTFOUND)',
    );
  });
});

/** Response whose body never ends; records how much was pulled and whether it was cancelled. */
function endlessResponse(status = 200, headers: Record<string, string> = {}) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(1024 * 1024).fill(97);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { res: new Response(body, { status, headers }), state };
}

describe('response size limits', () => {
  it('reads bodies up to the limit', async () => {
    await expect(readBodyLimited(new Response('héllo'), 6)).resolves.toBe('héllo');
    await expect(readBodyLimited(new Response('héllo'), 5)).rejects.toThrow('too large');
    await expect(readBodyLimited(new Response(null, { status: 204 }), 0)).resolves.toBe('');
  });

  it('rejects a larger Content-Length before reading', async () => {
    const { res, state } = endlessResponse(200, { 'content-length': String(MAX_RESPONSE_BYTES + 1) });
    await expect(readBodyLimited(res, MAX_RESPONSE_BYTES)).rejects.toThrow('too large');
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('stops reading and cancels an endless body', async () => {
    const { res, state } = endlessResponse();
    const { fetch } = mockFetch(() => res);
    const err = await requestText(fetch, 'https://mon.example.com/metrics?k=1', { system: 'Mon' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as Error).message).toBe('Mon: the response of https://mon.example.com/metrics exceeds 50 MiB. Check the base URL.');
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(MAX_RESPONSE_BYTES + 3 * 1024 * 1024);
  });

  it('reads only a few KiB of an error body', async () => {
    const { res, state } = endlessResponse(500);
    const { fetch } = mockFetch(() => res);
    const err = (await requestJson(fetch, 'https://mon.example.com/x', { system: 'Mon' }).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('Mon returned HTTP 500 for https://mon.example.com/x');
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(MAX_ERROR_BODY_BYTES + 2 * 1024 * 1024);
  });

  it('applies the limit after decompression on the default fetch path', async () => {
    const f = createAdapterFetch({ verifyTls: true });
    await expect(requestText(f, `${BASE}/gzip-bomb`, { system: 'Test' })).rejects.toThrow(
      `Test: the response of ${BASE}/gzip-bomb exceeds 50 MiB. Check the base URL.`,
    );
  });

  it('does not wait for an announced oversized body', async () => {
    const f = createAdapterFetch({ verifyTls: true, timeoutMs: 5000 });
    const started = performance.now();
    await expect(requestText(f, `${BASE}/declared-huge`, { system: 'Test' })).rejects.toThrow('exceeds 50 MiB');
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('value limits', () => {
  it('over-counts the values JSON.parse would create', () => {
    expect(countJsonValues('{}')).toBe(1);
    expect(countJsonValues('[{},{},[1,2]]')).toBe(7);
    expect(countJsonValues('{"a":"x,y"}')).toBe(2);
    expect(countJsonValues('[1,2,3,4,5]', 2)).toBe(3);
    expect(countTextValues('a 1')).toBe(2);
    expect(countTextValues('a{b="1",c="2"} 1\nd 2')).toBe(6);
  });

  it('rejects bodies over the limits before parsing them', async () => {
    const { fetch } = mockFetch(() => new Response(JSON.stringify(Array.from({ length: 20 }, () => ({})))));
    const limits = { maxBytes: 1024, maxValues: 10 };
    await expect(requestJson(fetch, 'https://mon.example.com/x?k=1', { system: 'Mon', limits })).rejects.toThrow(
      'Mon: the response of https://mon.example.com/x has more than 10 JSON values.',
    );
    await expect(requestJson(fetch, 'https://mon.example.com/x', { system: 'Mon', limits: { maxBytes: 1024 } })).resolves.toHaveLength(20);
    await expect(requestText(fetch, 'https://mon.example.com/x', { system: 'Mon', limits: { maxBytes: 16 } })).rejects.toThrow(
      'exceeds 0 MiB. Check the base URL or raise POLL_MAX_RESPONSE_MB.',
    );
    const lines = mockFetch(() => new Response('a 1\n'.repeat(10))).fetch;
    await expect(requestText(lines, 'https://mon.example.com/m', { system: 'Mon', limits: { maxBytes: 1024, maxValues: 10 } })).rejects.toThrow(
      'too many lines or labels',
    );
  });

  it('applies the byte limit on the transport without TLS verification', async () => {
    const f = createAdapterFetch({ verifyTls: false, maxResponseBytes: 1024 * 1024 });
    await expect(requestText(f, `${BASE}/two-mib`, { system: 'Test' })).rejects.toThrow('Response body too large');
    const unlimited = createAdapterFetch({ verifyTls: false });
    await expect(requestText(unlimited, `${BASE}/two-mib`, { system: 'Test' })).resolves.toHaveLength(2 * 1024 * 1024);
  });
});

describe('redactSecrets', () => {
  it('removes the userinfo of the base URL', () => {
    const config = { baseUrl: 'https://svc-user:p%40ss-word@mon.example.com', apiKey: 'k' };
    expect(redactSecrets('svc-user p%40ss-word p@ss-word', config, ['apiKey'])).toBe('*** *** ***');
  });

  it('removes secrets and their basic-auth encodings', () => {
    const config = { username: 'svc', password: 'hunter2-pass', apiKey: 'k' };
    const b64 = Buffer.from('svc:hunter2-pass').toString('base64');
    expect(redactSecrets(`failed with hunter2-pass and ${b64}`, config, ['password', 'apiKey'])).toBe(
      'failed with *** and ***',
    );
  });
});
