import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Several tests wait out real timers (2-3 s alone); under `pnpm verify` on a GitHub runner
  // every package's tests share two cores, and other packages ran 5-9x slower there than
  // alone, past the 5 s default.
  test: { testTimeout: 15_000, setupFiles: ['./test/setup.ts'] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Rebind the cross-script CANVAS namespace to the class re-exported by the test entry.
      main: './test/entry.ts',
      miniflare: {
        // Test-only draw key for the CanvasDO hosted here. Real keys are Workers secrets.
        // CONVERGENCE_SEEDS: how many seeds test/convergence.test.ts runs (more locally:
        // `CONVERGENCE_SEEDS=200 pnpm --filter @brickplace/realtime test convergence`).
        bindings: {
          ITEM_DRAW_KEY: 'test-only-item-draw-key',
          CONVERGENCE_SEEDS: process.env.CONVERGENCE_SEEDS ?? '',
          CONVERGENCE_FIRST_SEED: process.env.CONVERGENCE_FIRST_SEED ?? '',
        },
        durableObjects: {
          FANOUT: { className: 'FanoutDO', useSQLite: true },
          CANVAS: { className: 'CanvasDO', useSQLite: true },
        },
      },
    }),
  ],
});
