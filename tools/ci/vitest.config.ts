import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each hook test spawns node processes that run several git commands; under `pnpm verify`
    // they share the machine with every other package's tests.
    testTimeout: 30_000,
    // A module cache per package (see packages/core/vitest.config.ts).
    fsModuleCachePath: 'node_modules/.vitest-cache',
  },
});
