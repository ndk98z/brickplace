// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module.

/**
 * Test hook, 0 outside tests: how much later than asked CanvasDO sets its real alarm (ms).
 *
 * The game's Worker tests drive every tick themselves, on logical times (`tick(now)`). A real
 * alarm firing on the wall clock in between ran maintenance a test did not expect (a
 * checkpoint at Date.now(), a trim, a segment) whenever a loaded machine made the test slower
 * than a segment interval. Their setup (test/setup.ts) pushes real alarms an hour out, so none
 * fires during a run; a test that wants the alarm runs it on purpose with
 * runDurableObjectAlarm, and reads its time back through test/alarms.ts. Memory keeps the
 * time asked for (`alarmAt`), so scheduling decisions are the same either way.
 */
export const alarmDeferral = { ms: 0 };
