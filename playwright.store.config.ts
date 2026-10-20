import { defineConfig } from '@playwright/test';

/**
 * Generates the Chrome Web Store screenshots (not a test suite): `npm run package:screenshots`.
 * Kept out of the normal browser tests by its file pattern (*.store.ts).
 */
export default defineConfig({
  testDir: 'e2e/store',
  testMatch: '*.store.ts',
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/store',
});
