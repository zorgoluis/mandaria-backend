import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { testDatabaseUrl } from './scripts/test-database-url.js';

process.env.TEST_DATABASE_URL = testDatabaseUrl();

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    exclude: ['**/node_modules/**', '.claude/**'],
    // All E2E files share one database and, since V1.10-B/C, global credit policies that some
    // suites replace while others open Dispatches that require them: files run one at a time.
    fileParallelism: false,
  },
});
