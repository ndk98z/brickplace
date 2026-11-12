import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { fillInstance, instanceFrom, missingOperator } from './src/instance.ts';

export default defineConfig(({ mode }) => ({
  // Preact's automatic JSX runtime, without a framework plugin.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  plugins: [
    {
      // The operator, contact and source links in the static pages (ADR 0037), from the same
      // VITE_* settings the scripts read. Before Vite's own `%VITE_*%` pass.
      name: 'brickplace-instance',
      transformIndexHtml: {
        order: 'pre',
        handler: (html: string) => {
          const env = loadEnv(mode, process.cwd());
          const instance = instanceFrom(env);
          const missing = missingOperator(instance);
          if (env.VITE_REQUIRE_OPERATOR === '1' && missing.length > 0) {
            throw new Error(`missing or invalid operator settings: ${missing.join(', ')}`);
          }
          return fillInstance(html, instance);
        },
      },
    },
  ],
  // The game; the season timelapse (ADR 0021) with its own small bundle; and static pages
  // (contributors with a small script, legal pages with none).
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        timelapse: 'timelapse.html',
        contributors: 'contributors.html',
        terms: 'terms.html',
        privacy: 'privacy.html',
        trademarks: 'trademarks.html',
      },
    },
  },
  server: {
    // `pnpm --filter @brickplace/client dev` serves the client with hot reload while
    // `pnpm dev` (wrangler on :8787) runs the Workers behind /ws.
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': 'http://localhost:8787',
      '/auth': 'http://localhost:8787',
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Map-store and ghost tests replay core ops over whole tiles (under 1 s alone); under
    // `pnpm verify` on a GitHub runner they have passed the 5 s default (9.1 s seen).
    testTimeout: 30_000,
    // A module cache per package (see packages/core/vitest.config.ts).
    fsModuleCachePath: 'node_modules/.vitest-cache',
  },
}));
