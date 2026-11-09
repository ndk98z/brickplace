import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Season runs take 1-2 s alone; under `pnpm verify` on a GitHub runner they share two
    // cores with every other package's tests and have passed the 5 s default (7.3 s seen).
    testTimeout: 30_000,
  },
});
