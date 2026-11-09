import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { alarmDeferral } from '@brickplace/game/alarms';

// Applies the accounts schema (migrations/) and the standings schema (../game/migrations)
// before the tests; already applied ones are skipped.
const testEnv = env as unknown as {
  ACCOUNTS: D1Database;
  STANDINGS: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  TEST_STANDINGS_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
await applyD1Migrations(testEnv.ACCOUNTS, testEnv.TEST_MIGRATIONS);
await applyD1Migrations(testEnv.STANDINGS, testEnv.TEST_STANDINGS_MIGRATIONS);

// The CanvasDOs these tests host set no real alarm within a run (game's src/alarms.ts): one
// firing on a loaded machine would run maintenance no test asked for.
alarmDeferral.ms = 60 * 60 * 1000;
