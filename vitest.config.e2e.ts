import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { testDatabaseUrl } from './scripts/test-database-url.js';

process.env.TEST_DATABASE_URL = testDatabaseUrl();

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    // `.tmp/` holds the scratch copies a CHECK builds (historical backends, adversarial suites it
    // writes on the fly). They are not the product's suite: picking them up ran obsolete
    // expectations, inflated the file count and exhausted the per-IP rate limit, failing real
    // suites. The official suite lives in `test/`, and the exclusion says so twice on purpose.
    exclude: ['**/node_modules/**', '.claude/**', '.tmp/**'],
    // All E2E files share one database and, since V1.10-B/C, global credit policies that some
    // suites replace while others open Dispatches that require them: files run one at a time.
    fileParallelism: false,
  },
});
