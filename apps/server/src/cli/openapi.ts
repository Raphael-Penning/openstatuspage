/**
 * Writes the OpenAPI document of the HTTP API to docs/openapi.json
 * (`pnpm openapi:generate`). With `--check` it only compares and exits with 1
 * when the committed file is out of date.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument, serializeOpenApiDocument } from '../openapi/document.js';

export const OPENAPI_FILE = fileURLToPath(new URL('../../../../docs/openapi.json', import.meta.url));

function current(): string | null {
  try {
    return readFileSync(OPENAPI_FILE, 'utf8');
  } catch {
    return null;
  }
}

const generated = serializeOpenApiDocument(buildOpenApiDocument('full'));
if (process.argv.includes('--check')) {
  if (current() !== generated) {
    console.error('docs/openapi.json is out of date: run pnpm openapi:generate');
    process.exit(1);
  }
  console.log('docs/openapi.json is up to date');
} else {
  writeFileSync(OPENAPI_FILE, generated);
  console.log(`Wrote ${OPENAPI_FILE}`);
}
