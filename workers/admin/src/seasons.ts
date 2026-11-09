import type { Env } from './index.ts';
import {
  canvasStub,
  type SeasonInput,
  type SeasonRegistry,
  type SeasonResult,
  type SeasonView,
  STAGE0_CANVAS,
} from './ports.ts';

// The season registry (ADR 0021, 0022): rows in the accounts database's `seasons` table, which
// the gateway reads to route players, and the end each season's canvas enforces
// (CanvasDO.setSchedule). The two must agree, so every change writes both, in the order ADR
// 0021 gives, and undoes the first write when the second fails:
// - create: the row first, then the end on the new canvas; a refused end deletes the row;
// - schedule and end: the canvas first (it enforces the end), then the row; a failed row
//   write puts the canvas back while the season is still open.
// When the undo fails too the result says `inconsistent`, the audit log has it, and running
// the same action again repairs it (`end` copies the canvas's end into the row). An end sent to
// a canvas that could not be reached may or may not have landed: schedule puts the old end
// back; end keeps the row and answers `inconsistent`. Create, after a failed end call, clears
// the canvas's end (when unreachable) while its row still holds the name, removes the row, and
// sets the end again if the removal failed; then it reads both sides and answers from what
// they hold (`reconcile`), never from which calls failed. A canvas that cannot be read before
// anything is sent leaves both sides as they were: `unreachable`.
// Seasons never overlap and start at least MIN_START_LEAD_MS ahead, and after every create or
// schedule the Stage 0 canvas's end is set to the earliest registered start (alignStage0).
// This module is the only admin code that touches the accounts database, and only `seasons`.

/** The canvas names the table accepts (migration 0005's CHECK), minus the Stage 0 one. */
const CANVAS_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LIST_LIMIT = 100;
/**
 * A start (new, or moved) must lie at least this far ahead (ms). The Stage 0 canvas then takes
 * the start as its end without fail: its last logged op is older, and its clock may run a
 * little ahead of this Worker's. An end the canvas refused at the very start could no longer
 * be repaired once the start had passed. A margin, not a tuning knob.
 */
export const MIN_START_LEAD_MS = 5 * 60 * 1000;
/**
 * "End now" ends a canvas this long after the moment of the call (ms): ops still in flight
 * carry later times than the admin's request did, and the canvas refuses an end at or before
 * its last logged op. A margin, not a tuning knob.
 */
export const END_LEAD_MS = 10_000;
/** The guard every row write uses, so two admins cannot write overlapping seasons at once. */
const NO_OVERLAP =
  'NOT EXISTS (SELECT 1 FROM seasons WHERE canvas <> ? AND starts_at < ? AND ends_at > ?)';

type Row = { canvas: string; starts_at: number; ends_at: number };

function view(row: Row, now: number): SeasonView {
  const state = now < row.starts_at ? 'scheduled' : now < row.ends_at ? 'running' : 'ended';
  return { canvas: row.canvas, startsAt: row.starts_at, endsAt: row.ends_at, state };
}

const refused = (detail: string): SeasonResult => ({ ok: false, reason: 'refused', detail });
const UNREACHABLE: SeasonResult = {
  ok: false,
  reason: 'unreachable',
  detail: 'the canvas could not be reached; nothing changed',
};
const TOO_SOON = `a season must start at least ${MIN_START_LEAD_MS / 60_000} minutes from now`;

export function seasonRegistry(env: Env, now: number): SeasonRegistry {
  const db = env.ACCOUNTS;
  const read = (canvas: string) =>
    db
      .prepare('SELECT canvas, starts_at, ends_at FROM seasons WHERE canvas = ?')
      .bind(canvas)
      .first<Row>();

  /** Sets the canvas's end; a thrown call counts as a refusal named `unreachable`. */
  async function setEnd(canvas: string, endsAt: number | null): Promise<string | null> {
    try {
      const result = await canvasStub(env, canvas).setSchedule({ endsAt });
      return result.ok ? null : result.reason;
    } catch (error) {
      console.error(`admin: could not set the end of canvas ${canvas}`, error);
      return 'unreachable';
    }
  }

  /**
   * Ends `canvas` END_LEAD_MS after now, now read right before the call; once more with a
   * fresh time if the canvas found an op at or after the first one (`invalid`).
   */
  async function endSoon(canvas: string): Promise<{ endsAt: number; failed: string | null }> {
    let endsAt = Date.now() + END_LEAD_MS;
    let failed = await setEnd(canvas, endsAt);
    if (failed === 'invalid') {
      endsAt = Date.now() + END_LEAD_MS;
      failed = await setEnd(canvas, endsAt);
    }
    return { endsAt, failed };
  }

  /** The canvas's season status, or null when it cannot be reached (nothing was sent). */
  async function statusOf(canvas: string) {
    try {
      return await canvasStub(env, canvas).seasonStatus();
    } catch (error) {
      console.error(`admin: could not read canvas ${canvas}`, error);
      return null;
    }
  }

  /**
   * An end sent to a canvas that could not be reached: the call may have landed (the canvas
   * then closes) or not, so the result is unknown, and reported like the other two-sided
   * failures. Ending again reads the canvas's end and copies it into the row.
   */
  function endUnknown(what: string, registry?: number): SeasonResult {
    const row = registry === undefined ? '' : ` while the registry still says ${registry}`;
    return {
      ok: false,
      reason: 'inconsistent',
      detail: `${what} could not be reached after the end was sent: it may be ending${row}; end it again to repair`,
    };
  }

  /** Why [startsAt, endsAt) cannot be `canvas`'s time, or null. */
  async function clash(canvas: string, startsAt: number, endsAt: number): Promise<string | null> {
    if (endsAt <= startsAt) return 'the end must come after the start';
    const other = await db
      .prepare(
        'SELECT canvas FROM seasons WHERE canvas <> ? AND starts_at < ? AND ends_at > ? LIMIT 1',
      )
      .bind(canvas, endsAt, startsAt)
      .first<{ canvas: string }>();
    return other ? `it overlaps season ${other.canvas}` : null;
  }

  /**
   * ADR 0021: the Stage 0 canvas ends when the first season starts, or pages still open on it
   * keep playing the old map (and, ending too early, nobody can play until the season starts).
   * Run after every change of a start: it sets Stage 0's end to the earliest start registered,
   * and does nothing when they already agree. Null when they agree, else why not. Starts lie
   * at least MIN_START_LEAD_MS ahead, so while a season has not started Stage 0 is still open
   * and takes it.
   */
  async function alignStage0(): Promise<string | null> {
    const first = await db
      .prepare('SELECT MIN(starts_at) AS m FROM seasons')
      .first<{ m: number | null }>();
    if (first?.m === null || first?.m === undefined) return null;
    try {
      const status = await canvasStub(env, STAGE0_CANVAS).seasonStatus();
      if (status.endsAt === first.m) return null;
    } catch (error) {
      console.error('admin: could not read the Stage 0 canvas', error);
      return 'unreachable';
    }
    const failed = await setEnd(STAGE0_CANVAS, first.m);
    return failed ? `the Stage 0 canvas did not take the end ${first.m} (${failed})` : null;
  }

  /** A result that also says when Stage 0 could not be aligned (repair: schedule again). */
  async function withStage0(season: SeasonView): Promise<SeasonResult> {
    const stage0 = await alignStage0();
    if (!stage0) return { ok: true, season };
    return {
      ok: false,
      reason: 'inconsistent',
      detail: `season ${season.canvas} is saved, but ${stage0}; schedule it again to repair`,
    };
  }

  /**
   * The answer to a create whose end call failed (`failed`), from what both sides hold once
   * its cleanup is done: nothing on either side is `undone`; a row and the same end on its
   * canvas is the season as it stands (its note says how); anything else is `inconsistent`,
   * with the values read and a repair the admin can run. The two reads are not atomic: the
   * answer is what each side held when it was read.
   */
  async function reconcile(
    canvas: string,
    asked: { readonly startsAt: number; readonly endsAt: number },
    failed: string,
    sentAgain: boolean,
  ): Promise<SeasonResult> {
    let row: Row | null | undefined;
    try {
      row = await read(canvas);
    } catch (error) {
      console.error(`admin: could not read the season row of ${canvas}`, error);
      row = undefined;
    }
    const status = await statusOf(canvas);
    const end = status?.endsAt;
    if (row !== undefined && status) {
      if (row === null && end === null) {
        return {
          ok: false,
          reason: 'undone',
          detail: `the end call failed (${failed}); no row and no end on its canvas are left`,
        };
      }
      // Only an open canvas makes a season that stands: one closing, ended or sealed never
      // takes another op, whatever end it shows.
      if (row !== null && end === row.ends_at && status.phase === 'open') {
        const notes = [
          sentAgain
            ? `the end was sent again after the canvas ${failed === 'unreachable' ? 'could not be reached' : `refused it (${failed})`} and the row could not be removed`
            : null,
          row.starts_at !== asked.startsAt || row.ends_at !== asked.endsAt
            ? 'the row holds times another admin wrote'
            : null,
        ].filter((n) => n !== null);
        try {
          const result = await withStage0(view(row, now));
          return result.ok && notes.length > 0 ? { ...result, note: notes.join('; ') } : result;
        } catch (error) {
          console.error('admin: could not align Stage 0', error);
          return {
            ok: false,
            reason: 'inconsistent',
            detail: `season ${canvas} stands on both sides, but Stage 0 could not be aligned; schedule it again to repair Stage 0`,
          };
        }
      }
    }
    const rowText =
      row === undefined
        ? 'unreadable'
        : row === null
          ? 'absent'
          : `starts ${row.starts_at}, ends ${row.ends_at}`;
    const endText = !status
      ? 'unreadable'
      : `${end === null ? 'none' : end}${status.phase === 'open' ? '' : ` (${status.phase})`}`;
    // A repair the admin can run, chosen from what was read: no route reads a canvas's end,
    // so an unreadable canvas leaves the choice to the row.
    let repair: string;
    if (status && status.phase !== 'open') {
      repair =
        `its canvas is ${status.phase}: no end can be set; use another name` +
        (row === null
          ? ''
          : row
            ? ', and remove the row by hand'
            : ', and remove the row by hand if the season list shows one');
    } else if (row === undefined) {
      repair =
        'state unknown: list the seasons; create the season again if it is absent, otherwise schedule it with an end different from its current end';
    } else if (row === null) {
      repair = status
        ? 'create the season again to repair'
        : 'the canvas may hold an end; create the season again to repair';
    } else {
      repair = `schedule it with an end different from the row's current end ${row.ends_at} to repair`;
    }
    return {
      ok: false,
      reason: 'inconsistent',
      detail: `the end call failed (${failed}); row: ${rowText}; canvas end: ${endText}; ${repair}`,
    };
  }

  return {
    async list() {
      const { results } = await db
        .prepare('SELECT canvas, starts_at, ends_at FROM seasons ORDER BY starts_at DESC LIMIT ?')
        .bind(LIST_LIMIT)
        .all<Row>();
      return results.map((row) => view(row, now));
    },

    async create({ canvas, startsAt, endsAt }: SeasonInput) {
      if (!CANVAS_NAME.test(canvas) || canvas === STAGE0_CANVAS) {
        return refused('canvas: 1-32 lower-case letters, digits or -, not "canvas"');
      }
      if (startsAt < now + MIN_START_LEAD_MS) return refused(TOO_SOON);
      const clashes = await clash(canvas, startsAt, endsAt);
      if (clashes) return refused(clashes);
      try {
        // The overlap check again, in the insert itself: another admin may have written a
        // season since the check above.
        const written = await db
          .prepare(
            'INSERT INTO seasons (canvas, starts_at, ends_at, created_at) ' +
              `SELECT ?, ?, ?, ? WHERE ${NO_OVERLAP}`,
          )
          .bind(canvas, startsAt, endsAt, now, canvas, endsAt, startsAt)
          .run();
        if (written.meta.changes === 0) return refused('it overlaps another season');
      } catch (error) {
        if (/UNIQUE/.test(String(error))) return refused('that canvas or start is taken');
        throw error;
      }
      const failed = await setEnd(canvas, endsAt);
      if (failed) {
        // An unreachable canvas may have taken the end before the connection failed: clear it
        // again while the row still holds the name, so no other create of this canvas can
        // set its own end in between and lose it to this clearing. This assumes a lost call
        // reaches the canvas before the next one does, as schedule's undo does.
        if (failed === 'unreachable') await setEnd(canvas, null);
        let threw = false;
        try {
          // Only the row this call wrote: one another admin has rescheduled since stays.
          await db
            .prepare('DELETE FROM seasons WHERE canvas = ? AND starts_at = ? AND ends_at = ?')
            .bind(canvas, startsAt, endsAt)
            .run();
        } catch (error) {
          console.error('admin: could not undo a season row', error);
          threw = true;
        }
        // A row left in place would hold an end its canvas lacks, and the season would never
        // end: set the end again while the row holds the name.
        if (threw) await setEnd(canvas, endsAt);
        // The answer comes from what both sides hold now, not from which calls failed.
        return reconcile(canvas, { startsAt, endsAt }, failed, threw);
      }
      return withStage0(view({ canvas, starts_at: startsAt, ends_at: endsAt }, now));
    },

    async reschedule(canvas, times) {
      const row = await read(canvas);
      if (!row) return { ok: false, reason: 'not_found' };
      const startsAt = times.startsAt ?? row.starts_at;
      const endsAt = times.endsAt ?? row.ends_at;
      if (startsAt !== row.starts_at) {
        if (row.starts_at <= now) return refused('the season has started: its start is history');
        if (startsAt < now + MIN_START_LEAD_MS) return refused(TOO_SOON);
      }
      // Overlap covers a start another season already has.
      const clashes = await clash(canvas, startsAt, endsAt);
      if (clashes) return refused(clashes);
      const moved = endsAt !== row.ends_at;
      // Puts the canvas's end back after the row could not take the change.
      const undo = async (why: SeasonResult): Promise<SeasonResult> => {
        if (!moved) return why;
        const failed = await setEnd(canvas, row.ends_at);
        if (!failed) return why;
        return {
          ok: false,
          reason: 'inconsistent',
          detail: `the canvas may end at ${endsAt}, the registry still says ${row.ends_at}`,
        };
      };
      if (moved) {
        const failed = await setEnd(canvas, endsAt);
        // An unreachable canvas may have taken the new end before the connection failed: put
        // the old one back, as after a failed row write.
        if (failed === 'unreachable') {
          return undo({
            ok: false,
            reason: 'undone',
            detail: 'the canvas could not be reached; its end was set back',
          });
        }
        if (failed) return refused(`the canvas refused the end: ${failed}`);
      }
      try {
        const written = await db
          .prepare(
            `UPDATE seasons SET starts_at = ?, ends_at = ? WHERE canvas = ? AND ${NO_OVERLAP}`,
          )
          .bind(startsAt, endsAt, canvas, canvas, endsAt, startsAt)
          .run();
        if (written.meta.changes === 0) {
          // The row was deleted since it was read: there is no season to put an end back for.
          if ((await read(canvas)) === null) {
            if (!moved) return { ok: false, reason: 'not_found' };
            return {
              ok: false,
              reason: 'inconsistent',
              detail: `the row was removed meanwhile; the canvas may hold the end ${endsAt}; create the season again to repair`,
            };
          }
          // Another admin wrote an overlapping season since the check above.
          return undo(refused('it overlaps another season'));
        }
      } catch (error) {
        console.error('admin: could not write a season row', error);
        if (/UNIQUE/.test(String(error))) return undo(refused('another season starts then'));
        if (!moved) throw error;
        return undo({ ok: false, reason: 'undone', detail: 'the registry could not be written' });
      }
      return withStage0(view({ canvas, starts_at: startsAt, ends_at: endsAt }, now));
    },

    async end(canvas) {
      const row = await read(canvas);
      if (!row) return { ok: false, reason: 'not_found' };
      if (now < row.starts_at) return refused('the season has not started: reschedule it');
      // An end already in the past on the canvas stands (it may be closing): the row follows
      // it. That is also how an `inconsistent` end is repaired.
      const status = await statusOf(canvas);
      if (!status) return UNREACHABLE;
      let endsAt = status.endsAt;
      if (endsAt === null || endsAt > Date.now() + END_LEAD_MS) {
        const ended = await endSoon(canvas);
        if (ended.failed === 'unreachable') return endUnknown('the canvas', row.ends_at);
        if (ended.failed) return refused(`the canvas refused the end: ${ended.failed}`);
        endsAt = ended.endsAt;
      }
      if (endsAt !== row.ends_at) {
        try {
          await db
            .prepare('UPDATE seasons SET ends_at = ? WHERE canvas = ?')
            .bind(endsAt, canvas)
            .run();
        } catch (error) {
          // The canvas may already be closing: an end is not undone. Running `end` again
          // copies the canvas's end into the row.
          console.error('admin: could not write a season end', error);
          return {
            ok: false,
            reason: 'inconsistent',
            detail: `the canvas ends at ${endsAt}, the registry still says ${row.ends_at}; end it again to repair`,
          };
        }
      }
      return { ok: true, season: view({ ...row, ends_at: endsAt }, now) };
    },

    async endStage0() {
      // The repair for a Stage 0 canvas that did not take the first season's start in time:
      // once that start has passed, aligning can no longer set it (the end would lie before
      // ops Stage 0 has logged since). It ends Stage 0 now, like `end` for a season. An end
      // already due within END_LEAD_MS stands.
      const status = await statusOf(STAGE0_CANVAS);
      if (!status) return UNREACHABLE;
      let endsAt = status.endsAt;
      if (endsAt === null || endsAt > Date.now() + END_LEAD_MS) {
        const ended = await endSoon(STAGE0_CANVAS);
        if (ended.failed === 'unreachable') return endUnknown('the Stage 0 canvas');
        if (ended.failed) return refused(`the Stage 0 canvas refused the end: ${ended.failed}`);
        endsAt = ended.endsAt;
      }
      const season = { canvas: STAGE0_CANVAS, starts_at: 0, ends_at: endsAt };
      return { ok: true, season: view(season, now) };
    },
  };
}
