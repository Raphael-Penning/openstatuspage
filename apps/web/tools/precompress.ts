/**
 * Writes a Brotli (.br) and a gzip (.gz) copy next to every compressible file of
 * the client build. The server sends them as they are (@fastify/static with
 * preCompressed), so it never compresses a static file at runtime: no CPU and no
 * memory per request, and the strongest settings once at build time.
 *
 * Skipped: source maps (only developer tools load them), the Vite manifest and
 * the render bundle (.vite/, .ssr/: never served), small files and files that
 * do not get at least 10 % smaller.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|txt|xml|webmanifest)$/;
const SKIPPED_DIRS = new Set(['.vite', '.ssr']);
const MIN_BYTES = 1024;

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* files(path);
    } else if (COMPRESSIBLE.test(entry.name)) {
      yield path;
    }
  }
}

/** Compresses the files below dir; returns the number of files compressed. */
export function precompress(dir: string): number {
  let count = 0;
  for (const path of files(dir)) {
    if (statSync(path).size < MIN_BYTES) continue;
    const source = readFileSync(path);
    const variants = [
      ['.br', brotliCompressSync(source, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
        },
      })],
      ['.gz', gzipSync(source, { level: 9 })],
    ] as const;
    let written = false;
    for (const [ext, data] of variants) {
      if (data.length > source.length * 0.9) continue;
      writeFileSync(path + ext, data);
      written = true;
    }
    if (written) count++;
  }
  return count;
}
