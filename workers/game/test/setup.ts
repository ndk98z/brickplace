import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { alarmDeferral } from '../src/alarms.ts';
import { ALARM_DEFERRAL } from './alarms.ts';

// Applies the standings schema (migrations/) before the tests.
const testEnv = env as unknown as {
  STANDINGS: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
await applyD1Migrations(testEnv.STANDINGS, testEnv.TEST_MIGRATIONS);

// No real alarm fires during a run: every tick here is the test's own (see src/alarms.ts).
alarmDeferral.ms = ALARM_DEFERRAL;
