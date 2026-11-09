import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Randomised and whole-map tests take 1-2 s alone but 7-16 s under `pnpm verify` on a
    // GitHub runner, where every package's tests share two cores.
    testTimeout: 30_000,
  },
});
