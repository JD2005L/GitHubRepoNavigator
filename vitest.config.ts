import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __GRN_CONFIG__: JSON.stringify({
      clientId: 'Iv1.testclientid0000',
      appSlug: 'repo-navigator-test',
      apiBase: 'https://api.github.com',
      oauthBase: 'https://github.com',
      e2e: false,
    }),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    environmentOptions: { jsdom: { url: 'https://github.com/', pretendToBeVisual: true } },
    restoreMocks: true,
  },
});
