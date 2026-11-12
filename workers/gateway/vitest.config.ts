import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { experimental_readRawConfig, unstable_readConfig } from 'wrangler';

const configPath = './wrangler.jsonc';

/**
 * ENVIRONMENT exactly as committed in wrangler.jsonc, for the top level ('') and every env
 * block. Read from the config file alone: the test runner would also merge a local
 * .dev.vars (ENVIRONMENT=dev after one `pnpm dev`), which must never decide a test.
 */
const resolved = [
  '',
  ...Object.keys(experimental_readRawConfig({ config: configPath }).rawConfig.env ?? {}),
].map(
  (name) => [name, unstable_readConfig({ config: configPath, env: name || undefined })] as const,
);
const committedEnvironments = Object.fromEntries(
  resolved.map(([name, config]) => [name, config.vars.ENVIRONMENT]),
);

/** Each committed environment's required secret names (null: no `secrets` block) and vars. */
const committedSecrets = Object.fromEntries(
  resolved.map(([name, config]) => [
    name,
    { required: config.secrets?.required ?? null, vars: config.vars },
  ]),
);

/**
 * Each committed environment's ways in: the paths that run the Worker before assets, whether
 * workers.dev and preview URLs are written out (null: wrangler's default), every route
 * pattern and the custom-domain ones.
 */
const committedRoutes = Object.fromEntries(
  resolved.map(([name, config]) => {
    const routes = ((config.routes ?? []) as unknown[]).map((route) =>
      typeof route === 'string'
        ? { pattern: route, custom_domain: false }
        : (route as { pattern: string; custom_domain?: boolean }),
    );
    return [
      name,
      {
        runWorkerFirst: config.assets?.run_worker_first ?? null,
        workersDev: config.workers_dev ?? null,
        previewUrls: config.preview_urls ?? null,
        routes: routes.map((r) => r.pattern),
        customDomains: routes.filter((r) => r.custom_domain).map((r) => r.pattern),
      },
    ];
  }),
);

/** The accounts schema, applied to the test database by test/setup.ts. */
const migrations = await readD1Migrations('./migrations');
/** The standings schema (owned by the game Worker), applied to the test STANDINGS database. */
const standingsMigrations = await readD1Migrations('../game/migrations');

export default defineConfig({
  // Test files took up to 3.6 s on a 2-CPU runner (under 1 s alone), close to the 5 s default.
  test: {
    setupFiles: ['./test/setup.ts'],
    testTimeout: 15_000,
    // A module cache per package (see packages/core/vitest.config.ts).
    fsModuleCachePath: 'node_modules/.vitest-cache',
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath },
      main: './test/entry.ts',
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          TEST_STANDINGS_MIGRATIONS: standingsMigrations,
          // Test-only session keys: the second one verifies older tokens (rotation).
          SESSION_KEYS:
            'k2:test-only-session-key-number-two-000 k1:test-only-session-key-number-one-000',
          // Cloudflare's public always-pass Turnstile test secret; siteverify is mocked.
          TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
          // Test-only draw key for the CanvasDO hosted here. Real keys are Workers secrets.
          ITEM_DRAW_KEY: 'test-only-item-draw-key',
          // The committed top-level value, overriding whatever .dev.vars says.
          ENVIRONMENT: committedEnvironments[''],
          // Test-only: lets the tests check that no committed environment is `dev`.
          COMMITTED_ENVIRONMENTS: committedEnvironments,
          // Test-only: lets the tests check each environment requires the secrets it uses.
          COMMITTED_SECRETS: committedSecrets,
          // Test-only: lets the tests check the hosts each environment serves.
          COMMITTED_ROUTES: committedRoutes,
        },
        durableObjects: {
          FANOUT: { className: 'FanoutDO', useSQLite: true },
          CANVAS: { className: 'CanvasDO', useSQLite: true },
        },
      },
    }),
  ],
});
