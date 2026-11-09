import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { alarmDeferral } from '@brickplace/game/alarms';

// Applies the admin schema (migrations/) and the gateway's accounts schema (for the season
// registry) before the tests; already applied ones are skipped.
const testEnv = env as unknown as {
  ADMIN_DB: D1Database;
  ACCOUNTS: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  TEST_ACCOUNTS_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
await applyD1Migrations(testEnv.ADMIN_DB, testEnv.TEST_MIGRATIONS);
await applyD1Migrations(testEnv.ACCOUNTS, testEnv.TEST_ACCOUNTS_MIGRATIONS);

// The CanvasDOs these tests host set no real alarm within a run (game's src/alarms.ts): one
// firing on a loaded machine would run maintenance no test asked for.
alarmDeferral.ms = 60 * 60 * 1000;
