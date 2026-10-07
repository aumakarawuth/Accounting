import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.test.ts'], // e2e/*.spec.ts เป็นของ Playwright
    globalSetup: ['./global-setup.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
