import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  describeAnswer,
  isBlockedAddress,
  OutboundRequestError,
  pinnedLookup,
  resolvePublic,
  safeRequest,
  type Resolver,
} from '../src/lib/safe-http.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '172.16.5.4',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.100.100.200',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.10',
    '::1',
    '::',
    'fe80::1',
    'fe80::1%eth0',
    'fd00:ec2::254',
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:8.8.8.8',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    'not-an-ip',
    '',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e'])('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('resolvePublic', () => {
  it('refuses a host if any of its addresses is internal', async () => {
    const resolve: Resolver = async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    await expect(resolvePublic('hooks.example.com', { resolve })).rejects.toMatchObject({ code: 'address' });
  });

  it('refuses IP literals in every spelling the URL parser normalizes', async () => {
    for (const url of ['https://127.0.0.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/', 'https://[::ffff:127.0.0.1]/']) {
      await expect(safeRequest(url)).rejects.toMatchObject({ code: 'address' });
    }
  });

  it('reports DNS failures without details', async () => {
    const resolve: Resolver = async () => {
      throw new Error('ENOTFOUND hooks.example.com');
    };
    await expect(resolvePublic('hooks.example.com', { resolve })).rejects.toMatchObject({ code: 'dns' });
  });
});

describe('pinnedLookup', () => {
  it('answers every lookup with the checked address', async () => {
    const lookup = pinnedLookup({ address: '93.184.216.34', family: 4 });
    const single = await new Promise((resolve) =>
      lookup('evil.example.com', {}, (_err, address, family) => resolve([address, family])),
    );
    expect(single).toEqual(['93.184.216.34', 4]);
    const all = await new Promise((resolve) => lookup('evil.example.com', { all: true }, (_err, addresses) => resolve(addresses)));
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('safeRequest', () => {
  let server: Server;
  let port = 0;
  const seen: { host?: string; path?: string; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ host: req.headers.host, path: req.url, body });
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
          return res.end();
        }
        if (req.url === '/big') {
          res.writeHead(200);
          return res.end('x'.repeat(100_000));
        }
        if (req.url === '/slow') return; // never answers
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  /** A test host that resolves to the local server; only 127.0.0.1 passes the (test) address check. */
  const local = { allowHttp: true, allowAddress: (a: string) => a === '127.0.0.1' };

  it('refuses http unless allowed, and https URLs with credentials', async () => {
    await expect(safeRequest('http://hooks.example.com/x')).rejects.toMatchObject({ code: 'scheme' });
    await expect(safeRequest('https://user:pw@hooks.example.com/x')).rejects.toMatchObject({ code: 'scheme' });
    await expect(safeRequest('file:///etc/passwd')).rejects.toMatchObject({ code: 'scheme' });
  });

  it('connects to the address it checked, resolving only once (DNS rebinding)', async () => {
    let calls = 0;
    // First answer passes the check, a second one would point to another address.
    const resolve: Resolver = async () => (++calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.1', family: 4 }]);
    const res = await safeRequest(`http://rebind.example.test:${port}/hook`, { body: '{}' }, { ...local, resolve });
    expect(res.status).toBe(204);
    expect(res.address).toBe('127.0.0.1');
    expect(calls).toBe(1);
    // The Host header still names the host (virtual hosts, TLS SNI).
    expect(seen.at(-1)).toMatchObject({ host: `rebind.example.test:${port}`, path: '/hook', body: '{}' });
  });

  it('refuses a host whose DNS answer is internal', async () => {
    const resolve: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    await expect(safeRequest(`https://internal.example.test:${port}/`, {}, { resolve })).rejects.toBeInstanceOf(OutboundRequestError);
  });

  it('does not follow redirects', async () => {
    const resolve: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    const before = seen.length;
    const res = await safeRequest(`http://hooks.example.test:${port}/redirect`, {}, { ...local, resolve });
    expect(res.status).toBe(302);
    expect(seen.length).toBe(before + 1);
    expect(describeAnswer(res)).toBe('HTTP 302 (redirects are not followed)');
  });

  it('reads at most maxResponseBytes', async () => {
    const resolve: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    const res = await safeRequest(`http://hooks.example.test:${port}/big`, { method: 'GET' }, { ...local, resolve, maxResponseBytes: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1000);
  });

  it('gives up after the timeout', async () => {
    const resolve: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    await expect(
      safeRequest(`http://hooks.example.test:${port}/slow`, {}, { ...local, resolve, timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('never puts the path or query into error messages', async () => {
    const resolve: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    const err = await safeRequest('https://hooks.example.test/services/SECRET?token=SECRET', {}, { resolve }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('SECRET');
  });
});
