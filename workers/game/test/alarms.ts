import { runInDurableObject } from 'cloudflare:test';
import type { CanvasDO } from '../src/index.ts';

/**
 * How far test/setup.ts pushes CanvasDO's real alarms (src/alarms.ts): longer than any run, so
 * an alarm only ever fires when a test runs it with runDurableObjectAlarm.
 */
export const ALARM_DEFERRAL = 60 * 60 * 1000;

/** The time the canvas asked its alarm for (wall clock, ms), or null when none is pending. */
export async function pendingAlarm(stub: DurableObjectStub<CanvasDO>): Promise<number | null> {
  const stored = await runInDurableObject(stub, (_, state) => state.storage.getAlarm());
  return stored === null ? null : stored - ALARM_DEFERRAL;
}
