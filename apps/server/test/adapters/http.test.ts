import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AdapterError,
  basicAuth,
  createAdapterFetch,
  describeTransportError,
  describeUrl,
  insecureFetch,
  joinUrl,
  requestJson,
} from '../../src/adapters/http.js';
import { redactSecrets } from '../../src/adapters/runner.js';
import { jsonResponse, mockFetch } from './helpers.js';

// The only port assigned to this test suite.
const PORT = 3102;
const BASE = `http://127.0.0.1:${PORT}`;

let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/json') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-multi': ['a', 'b'] });
        res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization ?? null, body }));
      });
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 2000).unref();
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

  it('describes TLS and DNS failures', () => {
    expect(describeTransportError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }))).toMatch(
      /TLS certificate verification failed .* disable TLS verification/,
    );
    expect(describeTransportError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x' })).toBe(
      'host name could not be resolved (ENOTFOUND)',
    );
  });
});

describe('redactSecrets', () => {
  it('removes secrets and their basic-auth encodings', () => {
    const config = { username: 'svc', password: 'hunter2-pass', apiKey: 'k' };
    const b64 = Buffer.from('svc:hunter2-pass').toString('base64');
    expect(redactSecrets(`failed with hunter2-pass and ${b64}`, config, ['password', 'apiKey'])).toBe(
      'failed with *** and ***',
    );
  });
});
