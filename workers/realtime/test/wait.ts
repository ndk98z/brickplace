/**
 * How long a test waits for a frame, a hold or a condition it expects (ms). Usually a few ms;
 * 2 s ran out on a loaded GitHub runner. Waits for something that must NOT come pass their
 * own short time instead.
 */
export const WAIT_MS = 10_000;
