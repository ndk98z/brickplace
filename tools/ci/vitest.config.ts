import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each hook test spawns node processes that run several git commands; under `pnpm verify`
    // they share the machine with every other package's tests.
    testTimeout: 30_000,
  },
});
