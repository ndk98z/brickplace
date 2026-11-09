// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module. A copy of the game script's ops.ts (scripts do not
// share runtime code); keep the two alike.

/** A field of an ops event: plain values only, never a player id, a nickname or a secret. */
export type OpsField = string | number | boolean | null;

/**
 * Logs one operational event as an object with a stable `event` name, which Workers Logs
 * indexes as fields and Logpush carries as JSON. At error level, Workers Issues also records
 * it. docs/ops/alerts.md lists every name and how to alert on it; names never change.
 */
export function opsEvent(
  level: 'error' | 'warn' | 'info',
  event: string,
  fields: Readonly<Record<string, OpsField>>,
): void {
  const line = { event, ...fields };
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Logs an event at most once per `intervalMs` per name, so a signal that holds for a while
 * cannot flood the logs; the next event it lets through says how many it held back
 * (`suppressed`). Per object and in memory.
 */
export class OpsSampler {
  private readonly last = new Map<string, { at: number; suppressed: number }>();

  constructor(
    readonly intervalMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Logs the event unless one of the same name went out less than `intervalMs` ago. */
  emit(
    level: 'error' | 'warn' | 'info',
    event: string,
    fields: Readonly<Record<string, OpsField>>,
  ): boolean {
    const at = this.now();
    const seen = this.last.get(event);
    if (seen && at - seen.at < this.intervalMs) {
      seen.suppressed++;
      return false;
    }
    opsEvent(level, event, { ...fields, suppressed: seen?.suppressed ?? 0 });
    this.last.set(event, { at, suppressed: 0 });
    return true;
  }
}

/**
 * The FanoutDO limits the events watch. The runtime accepts at most 32,768 hibernatable
 * WebSockets per object; a warning from 80% leaves room to split FanoutDOs (per-tile
 * subscriptions, PROGRESS.md) before joins start failing.
 */
export const MAX_SOCKETS = 32_768;
export const SOCKETS_WARN = Math.floor(MAX_SOCKETS * 0.8);
/** Sockets are counted (an array of all of them) at most this often, on joins. */
export const SOCKET_COUNT_MS = 10_000;
