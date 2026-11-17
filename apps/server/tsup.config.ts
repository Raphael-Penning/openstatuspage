import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli/migrate.ts', 'src/cli/seed.ts', 'src/cli/create-user.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  // Bundle the workspace package; keep real dependencies external.
  noExternal: ['@openstatuspage/shared'],
});
