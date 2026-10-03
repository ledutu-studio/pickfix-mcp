import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@pickfix/protocol': fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['test/e2e/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
