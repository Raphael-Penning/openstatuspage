/**
 * Child process of heap-limits.test.ts. Runs under the V8 heap flags of the
 * image (docker/Dockerfile) with ballast standing in for the rest of the server, polls one
 * URL with the default poll limits (and parses it like the adapters do) and
 * prints the outcome as one JSON line.
 * An out-of-memory abort shows as a crashed child instead.
 *
 * argv: <url> <json|text> <heap MB to fill before polling>
 */
import { AdapterError, createAdapterFetch, DEFAULT_POLL_LIMITS, requestJson, requestText } from '../../src/adapters/http.js';
import { parsePrometheusText } from '../../src/adapters/prometheus.js';

const [url, kind, heapMB] = process.argv.slice(2) as [string, 'json' | 'text', string];

// Live objects of a running server (caches, modules, connections): small objects, like the real heap.
const ballast: { id: number; name: string }[] = [];
while (process.memoryUsage().heapUsed < Number(heapMB) * 1e6) {
  for (let i = 0; i < 10_000; i++) ballast.push({ id: ballast.length, name: `entry-${ballast.length}` });
}

const options = { system: 'Test', limits: DEFAULT_POLL_LIMITS };
const fetchFn = createAdapterFetch({ verifyTls: true, maxResponseBytes: DEFAULT_POLL_LIMITS.maxBytes });
try {
  // Text is parsed like Uptime Kuma's /metrics.
  const value =
    kind === 'json'
      ? await requestJson<unknown[]>(fetchFn, url, options)
      : parsePrometheusText(await requestText(fetchFn, url, options)).samples;
  console.log(JSON.stringify({ ok: true, length: value.length, ballast: ballast.length }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, adapterError: err instanceof AdapterError, message: (err as Error).message }));
}
