import type {
  CancelResult,
  ConfigScheduleResult,
  ConfigScope,
  ConfigState,
  ConfigVersion,
} from '@brickplace/game';
import type { Env } from './index.ts';

// What the admin area asks of the game, behind interfaces (ADR 0022), so the routes do not
// care which Durable Object answers: config versions (CanvasDO.scheduleConfig and friends),
// the read-only switch and season ends (CanvasDO.setSchedule, ADR 0021), and the season
// registry (D1 `seasons` in the accounts database, seasons.ts).

/** The Stage 0 canvas, current while no season has started (ADR 0021). */
export const STAGE0_CANVAS = 'canvas';

/**
 * The canvas the admin area acts on at `now`: the season whose start passed last, as the
 * gateway resolves it (ADR 0021), else the Stage 0 canvas. Read from D1 every time, never
 * guessed: if the registry cannot be read this throws and the request answers 503.
 */
export async function currentCanvas(env: Env, now: number): Promise<string> {
  const row = await env.ACCOUNTS.prepare(
    'SELECT canvas FROM seasons WHERE starts_at <= ? ORDER BY starts_at DESC LIMIT 1',
  )
    .bind(now)
    .first<{ canvas: string }>();
  return row?.canvas ?? STAGE0_CANVAS;
}

export function canvasStub(env: Env, canvas: string) {
  return env.CANVAS.get(env.CANVAS.idFromName(canvas));
}

/** The canvas's admin config versions (CanvasDO.scheduleConfig and friends). */
export interface CanvasConfigPort {
  readonly canvas: string;
  state(): Promise<ConfigState>;
  schedule(version: ConfigVersion): Promise<ConfigScheduleResult>;
  cancel(scope: ConfigScope, version: number): Promise<CancelResult>;
}

export function canvasConfig(env: Env, canvas: string): CanvasConfigPort {
  const stub = () => canvasStub(env, canvas);
  // RPC types widen tuples (drop rates) to arrays; the values are the canvas's own.
  return {
    canvas,
    state: () => stub().configState() as Promise<unknown> as Promise<ConfigState>,
    schedule: (version) =>
      stub().scheduleConfig(version) as Promise<unknown> as Promise<ConfigScheduleResult>,
    cancel: (scope, version) => stub().cancelConfig(scope, version),
  };
}

export interface ReadOnlyStatus {
  readonly canvas: string;
  readonly readOnly: boolean;
  /** The note the canvas keeps while paused (at most READ_ONLY_NOTE characters). */
  readonly note: string | null;
}

export type SwitchResult =
  | { readonly ok: true; readonly status: ReadOnlyStatus }
  | {
      readonly ok: false;
      readonly reason: 'refused' | 'unreachable';
      readonly detail?: string;
    };

/**
 * Emergency read-only: the canvas refuses every op and discard with `read_only` while it is
 * on, and keeps serving the map. Distinct from the end of a season, which is final.
 */
export interface ReadOnlySwitch {
  readonly canvas: string;
  status(): Promise<ReadOnlyStatus>;
  set(readOnly: boolean, reason: string): Promise<SwitchResult>;
}

/** The canvas keeps a short note (season.ts MAX_READ_ONLY_NOTE); the audit row keeps all. */
export const READ_ONLY_NOTE = 64;

/** The read-only switch of `canvas`: CanvasDO.setSchedule({readOnly}) (ADR 0021). */
export function readOnlySwitch(env: Env, canvas: string): ReadOnlySwitch {
  const stub = () => canvasStub(env, canvas);
  const view = (readOnly: string | null): ReadOnlyStatus => ({
    canvas,
    readOnly: readOnly !== null,
    note: readOnly,
  });
  return {
    canvas,
    status: async () => view((await stub().seasonStatus()).readOnly),
    set: async (readOnly, reason) => {
      const note = readOnly ? reason.slice(0, READ_ONLY_NOTE) || 'paused by an admin' : null;
      try {
        const result = await stub().setSchedule({ readOnly: note });
        if (!result.ok) return { ok: false, reason: 'refused', detail: result.reason };
        return { ok: true, status: view(result.season.readOnly) };
      } catch (error) {
        console.error('admin: could not reach the canvas for read-only', error);
        return { ok: false, reason: 'unreachable' };
      }
    },
  };
}

export type SeasonState = 'scheduled' | 'running' | 'ended';

export interface SeasonView {
  /** The season's canvas name, which also names it in the API. */
  readonly canvas: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly state: SeasonState;
}

export interface SeasonInput {
  readonly canvas: string;
  readonly startsAt: number;
  readonly endsAt: number;
}

export type SeasonFailure =
  /** Taken name or start, an invalid time, a closed canvas: nothing changed. */
  | 'refused'
  | 'not_found'
  /** The second write failed and the first was undone: nothing changed. */
  | 'undone'
  /**
   * The second write failed and the first could not be undone, or the canvas could not be
   * reached once a change was sent to it: D1 and the canvas differ, or may.
   */
  | 'inconsistent'
  /** The canvas could not be reached before anything was written: nothing changed. */
  | 'unreachable';

export type SeasonResult =
  | {
      readonly ok: true;
      readonly season: SeasonView;
      /** How it came to stand when that took a repair on the way (kept in the audit row). */
      readonly note?: string;
    }
  | { readonly ok: false; readonly reason: SeasonFailure; readonly detail?: string };

/** Create, schedule and end seasons (ADR 0010: one week each; ADR 0021: one canvas each). */
export interface SeasonRegistry {
  /** Newest first. */
  list(): Promise<readonly SeasonView[]>;
  create(input: SeasonInput): Promise<SeasonResult>;
  reschedule(canvas: string, times: Partial<Omit<SeasonInput, 'canvas'>>): Promise<SeasonResult>;
  /** Ends a running season now: its canvas closes for good and is archived. */
  end(canvas: string): Promise<SeasonResult>;
  /** Ends the Stage 0 canvas now: the repair when it missed the first season's start. */
  endStage0(): Promise<SeasonResult>;
}
