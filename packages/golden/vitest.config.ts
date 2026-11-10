import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fixture replays are quick alone; under `pnpm verify` on a 2-CPU GitHub runner every
    // package's tests share the cores and run several times slower (as core's did).
    testTimeout: 30_000,
    // A module cache per package (see packages/core/vitest.config.ts).
    fsModuleCachePath: 'node_modules/.vitest-cache',
  },
});
