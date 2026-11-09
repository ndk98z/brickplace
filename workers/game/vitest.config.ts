import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { experimental_readRawConfig, unstable_readConfig } from 'wrangler';

const configPath = './wrangler.jsonc';

/** The standings schema, where the canvas writes team standings (ADR 0020). */
const migrations = await readD1Migrations('./migrations');

/** Each committed environment's required secret names; null when it has no `secrets` block. */
const committedSecrets = Object.fromEntries(
  ['', ...Object.keys(experimental_readRawConfig({ config: configPath }).rawConfig.env ?? {})].map(
    (name) => [
      name,
      unstable_readConfig({ config: configPath, env: name || undefined }).secrets?.required ?? null,
    ],
  ),
);

export default defineConfig({
  // Most tests here build, checkpoint and restore 2048² grids (1-2 s each alone); with the
  // whole repo's suites running in parallel on a loaded machine they pass the 5 s default.
  // The few longer ones set their own timeouts.
  test: { setupFiles: ['./test/setup.ts'], testTimeout: 15_000 },
  plugins: [
    cloudflareTest({
      wrangler: { configPath },
      // FANOUT names the realtime script; here it is a recording stand-in (test/entry.ts).
      main: './test/entry.ts',
      miniflare: {
        durableObjects: {
          CANVAS: { className: 'CanvasDO', useSQLite: true },
          FANOUT: { className: 'FanoutDO' },
        },
        bindings: {
          // Test-only draw key, overriding any local .dev.vars. Real keys are Workers secrets.
          ITEM_DRAW_KEY: 'test-only-item-draw-key',
          TEST_MIGRATIONS: migrations,
          // Test-only: lets the tests check every environment requires ITEM_DRAW_KEY.
          COMMITTED_SECRETS: committedSecrets,
        },
      },
    }),
  ],
});
