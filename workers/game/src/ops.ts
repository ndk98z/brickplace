// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module. The realtime script has a copy (its own ops.ts):
// scripts do not share runtime code.

/** A field of an ops event: plain values only, never a player id, a nickname or a secret. */
export type OpsField = string | number | boolean | null;

/**
 * Logs one operational event as an object with a stable `event` name, which Workers Logs
 * indexes as fields (`event = "archive_seal_stuck"`) and Logpush carries as JSON. At error
 * level, Workers Issues also records it. docs/ops/alerts.md lists every name and how to alert
 * on it; renaming one breaks the owner's saved queries and alerts, so names never change.
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
 * (a deep queue, slow ticks) cannot flood the logs; the next event it lets through says how
 * many it held back (`suppressed`). Per object and in memory: an eviction starts it over,
 * which only happens once the object has gone quiet.
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
 * An error's name and message, cut short: enough to tell failures apart in an alert. A
 * SyntaxError gives its name only: JSON.parse quotes the text it choked on, and a damaged raw
 * log row holds player ids (`who`), which no log line may carry.
 */
export function errorText(error: unknown): string {
  if (error instanceof SyntaxError) return `${error.name} (message withheld: it may quote data)`;
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * What to hand console.error for a caught error: the error itself (its stack helps), except a
 * SyntaxError, whose message may quote player ids (see errorText).
 */
export function loggableError(error: unknown): unknown {
  return error instanceof SyntaxError ? errorText(error) : error;
}
