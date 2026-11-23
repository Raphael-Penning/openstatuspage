import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

/** Version of the server package, built in as process.env.OSP_VERSION (src/lib/version.ts). */
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * Dependencies stay external only when they cannot be bundled: native modules
 * (argon2, better-sqlite3, pg-native), the development log formatter and mysql2
 * (loaded by the Icinga DB importer only).
 */
const EXTERNAL = ['better-sqlite3', '@node-rs/argon2', 'pg-native', 'pino-pretty', 'mysql2'];

export default defineConfig({
  entry: ['src/index.ts', 'src/cli/migrate.ts', 'src/cli/seed.ts', 'src/cli/create-user.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  env: { OSP_VERSION: version },
  sourcemap: true,
  // Everything else is bundled and minified: V8 keeps the source text of every
  // loaded module in memory, so a smaller, tree-shaken bundle saves several MB
  // per instance (docs/architecture.md#memory). Code used by one role or path
  // only (admin routes, OIDC, SMTP, importers) is split into chunks that load
  // on first use.
  noExternal: [new RegExp(`^(?!(${EXTERNAL.map((m) => m.replace('/', '\\/')).join('|')})(\\/|$))`)],
  minify: true,
  // Readable function names in stack traces and logs.
  keepNames: true,
  esbuildOptions(options) {
    // V8 stores a source with a single non-ASCII character as UTF-16, twice the
    // size. License comments of the bundled dependencies go to *.LEGAL.txt.
    options.charset = 'ascii';
    options.legalComments = 'external';
  },
  // Bundled CommonJS dependencies call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __osp_createRequire } from 'node:module'; const require = __osp_createRequire(import.meta.url);",
  },
});
