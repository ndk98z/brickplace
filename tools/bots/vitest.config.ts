import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Plain Node tests; under `pnpm verify` on CI's 2-CPU runner they share the cores with every
    // other package's tests (AGENTS.md).
    testTimeout: 30_000,
  },
});
