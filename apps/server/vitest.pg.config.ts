import { defineConfig } from 'vitest/config';

/**
 * PostgreSQL integration tests (test-pg/), separate from the SQLite suite.
 * Needs PG_TEST_URL and PG_TEST_PUBLIC_URL, see test-pg/setup.ts.
 */
export default defineConfig({
  test: {
    include: ['test-pg/**/*.test.ts'],
    environment: 'node',
    // One database per file; files may run in parallel.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
