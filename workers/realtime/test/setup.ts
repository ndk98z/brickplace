import { alarmDeferral } from '@brickplace/game/alarms';
import { pushTiming } from '@brickplace/game/push';
import { flushTiming, relayLimits } from '../src/pacing.ts';
import { watchdogTiming } from '../src/watchdog.ts';

// The CanvasDOs these tests host set no real alarm within a run (game's src/alarms.ts): one
// firing on a loaded machine would run maintenance no test asked for.
alarmDeferral.ms = 60 * 60 * 1000;

// No diff tick leaves a CanvasDO on a timer here: tests push ticks with CanvasDO.pushTicks()
// where they want them, so frame order never depends on timing (ADR 0028). For the same
// reason the shards' tick watchdog stays off unless a test turns it on.
pushTiming.ms = Number.POSITIVE_INFINITY;
// Many shards follow one canvas within a second here.
pushTiming.followsPerSecond = Number.POSITIVE_INFINITY;
watchdogTiming.ms = Number.POSITIVE_INFINITY;
watchdogTiming.stallMs = Number.POSITIVE_INFINITY;
// Every change reaches the sockets at once, as before ADR 0041, so frames follow ops in order;
// test/pacing.test.ts turns the pacing on.
flushTiming.ms = 0;
// No canvas call times out on a loaded runner's clock; test/pacing.test.ts sets one where it
// checks the timeout.
relayLimits.timeoutMs = Number.POSITIVE_INFINITY;
