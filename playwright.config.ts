import { defineConfig } from '@playwright/test';

/**
 * Browser tests load the unpacked dist-e2e/ extension into Playwright's Chromium (one persistent profile per
 * test). github.com pages are served from a realistic drawer fixture; the extension's service worker talks to
 * a local mock GitHub (OAuth device flow + REST) on 127.0.0.1.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure' },
});
