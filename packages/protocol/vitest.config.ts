import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Whole-tile round trips take a fraction of a second alone but several seconds under
    // `pnpm verify` on a 2-CPU GitHub runner, where every package's tests share the cores.
    testTimeout: 30_000,
  },
});
