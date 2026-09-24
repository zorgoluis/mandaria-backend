import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // Same reason as the E2E config: `.tmp/` holds the scratch copies a CHECK builds, and picking
    // them up silently inflated the official unit count (224 in 22 files reported for V1.12-A was
    // really 216 in 20; the difference was scratch). The official suite lives in `src/` and `test/`.
    exclude: ['**/node_modules/**', '.claude/**', '.tmp/**'],
  },
});
