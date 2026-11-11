import { defineConfig } from 'vitest/config';

// Sandbox e2e tests: one local chain per file, network-bound, so generous timeouts.
export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 300_000,
  },
});
