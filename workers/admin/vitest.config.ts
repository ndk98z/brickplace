import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { experimental_readRawConfig, unstable_readConfig } from 'wrangler';

const configPath = './wrangler.jsonc';

/**
 * ENVIRONMENT exactly as committed in wrangler.jsonc, for the top level ('') and every env
 * block. Read from the config file alone: the test runner would also merge a local
 * .dev.vars (ENVIRONMENT=dev after one `pnpm dev`), which must never decide a test.
 */
const envNames = [
  '',
  ...Object.keys(experimental_readRawConfig({ config: configPath }).rawConfig.env ?? {}),
];
const resolved = envNames.map(
  (name) => [name, unstable_readConfig({ config: configPath, env: name || undefined })] as const,
);
const committedEnvironments = Object.fromEntries(
  resolved.map(([name, config]) => [name, config.vars.ENVIRONMENT]),
);

/** Which public routes each committed environment opens (ADR 0022, 0029): every pattern. */
const committedRoutes = Object.fromEntries(
  resolved.map(([name, config]) => [
    name,
    {
      workersDev: config.workers_dev ?? null,
      previewUrls: config.preview_urls ?? null,
      routes: ((config.routes ?? []) as unknown[]).map((route) =>
        typeof route === 'string'
          ? route
          : `${(route as { pattern: string; custom_domain?: boolean }).pattern}${
              (route as { custom_domain?: boolean }).custom_domain ? ' (custom domain)' : ''
            }`,
      ),
    },
  ]),
);

/** The admin schema, applied to the test database by test/setup.ts. */
const migrations = await readD1Migrations('./migrations');
/** The gateway's accounts schema (the season registry lives there), for ACCOUNTS. */
const accountsMigrations = await readD1Migrations('../gateway/migrations');

export default defineConfig({
  // Map tests take up to 1.5 s alone; on a loaded GitHub runner other packages ran 5-9x
  // slower than alone, past the 5 s default.
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
          TEST_ACCOUNTS_MIGRATIONS: accountsMigrations,
          // Test-only draw key for the CanvasDO hosted here. Real keys are Workers secrets.
          ITEM_DRAW_KEY: 'test-only-item-draw-key',
          // The committed top-level value, overriding whatever .dev.vars says.
          ENVIRONMENT: committedEnvironments[''],
          // Test-only: lets the tests check that no committed environment is `dev`.
          COMMITTED_ENVIRONMENTS: committedEnvironments,
          // Test-only: lets the tests check that no environment opens a workers.dev address or
          // preview URLs, and staging's routes.
          COMMITTED_ROUTES: committedRoutes,
        },
        durableObjects: {
          CANVAS: { className: 'CanvasDO', useSQLite: true },
          FANOUT: { className: 'FanoutDO', useSQLite: true },
        },
      },
    }),
  ],
});
