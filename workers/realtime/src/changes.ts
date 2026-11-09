// What a shard's mirror changed lately (ADR 0040): per step (an op's reply, a tick, a resync),
// the cells it touched, so a page that reconnects holding the map at some seq gets only the
// cells changed since, not the whole map. Kept out of the Worker entry (index.ts): workerd
// accepts only handlers and Durable Object classes as exports of the main module.

/** Cells the list keeps at most (4 bytes each: 1 MiB); older steps are dropped first. */
export const RESUME_CELLS = 1 << 18;
/** Steps the list keeps at most: ten minutes of ticks, so empty steps cannot pile up. */
export const RESUME_STEPS = 2400;
/** Most cells one resume sends (768 KiB of records); past it the page gets the whole map. */
export const RESUME_MAX_CELLS = 1 << 17;

interface Step {
  /** The mirror's seq after the step; it covers the seqs after the previous step's. */
  readonly to: number;
  /** The cells it touched, ascending, without repeats. */
  readonly cells: Uint32Array;
  /**
   * True when `cells` holds every cell any seq of the step touched, a cell changed and changed
   * back included; false for a resync, which only knows the cells that differ at its end. A
   * page at a seq inside an inexact step cannot resume from it.
   */
  readonly exact: boolean;
}

/** Where a page at some seq resumes from: the start of its step, and the steps after it. */
export interface ResumePoint {
  /** The seq the cells are changes after (at or below the page's). */
  readonly from: number;
  /** The index of the first step to send. */
  readonly first: number;
}

export class ChangeLog {
  private readonly steps: Step[] = [];
  private count = 0;

  constructor(
    /** The list holds every cell changed after this seq. */
    private start: number,
    private readonly maxCells = RESUME_CELLS,
    private readonly maxSteps = RESUME_STEPS,
  ) {}

  /** The seq the list starts after: a page at an older seq cannot resume from it. */
  get from(): number {
    return this.start;
  }

  /**
   * The mirror reached `to`, touching `cells` (any order, repeats allowed). `exact`: they are
   * every cell touched on the way (see Step.exact).
   */
  record(to: number, cells: Uint32Array, exact = true): void {
    const last = this.steps.at(-1)?.to ?? this.start;
    if (to <= last) return;
    // An exact step without cells changes nothing a page could miss; an inexact one still
    // marks the seqs a page cannot resume from.
    if (cells.length === 0 && exact) return;
    const step = { to, cells: sortedUnique(cells), exact };
    this.steps.push(step);
    this.count += step.cells.length;
    while (
      this.steps.length > 0 &&
      (this.count > this.maxCells || this.steps.length > this.maxSteps)
    ) {
      const dropped = this.steps.shift()!;
      this.count -= dropped.cells.length;
      this.start = dropped.to;
    }
  }

  /**
   * The mirror jumped to `seq` without saying which cells changed (a resync with too many):
   * the list starts afresh there.
   */
  reset(seq: number): void {
    this.steps.length = 0;
    this.count = 0;
    this.start = seq;
  }

  /**
   * Where a page holding every change up to `since` resumes from: the start of the step that
   * holds `since`, so pages within one step share the answer. Null when the list does not
   * reach `since`, or `since` falls inside an inexact step. Cheap: no cell is read.
   */
  locate(since: number): ResumePoint | null {
    if (!Number.isSafeInteger(since) || since < this.start) return null;
    // Steps are in seq order: the first one ending after `since`.
    let lo = 0;
    let hi = this.steps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.steps[mid]!.to > since) hi = mid;
      else lo = mid + 1;
    }
    const from = lo === 0 ? this.start : this.steps[lo - 1]!.to;
    if (lo < this.steps.length && from < since && !this.steps[lo]!.exact) return null;
    return { from, first: lo };
  }

  /**
   * The cells the steps from `point` on touched, ascending, each once; null when their lists
   * hold more than `maxCells` in all (counted before merging, so the merge is bounded too).
   */
  cells(point: ResumePoint, maxCells = RESUME_MAX_CELLS): Uint32Array | null {
    let total = 0;
    for (let i = point.first; i < this.steps.length; i++) total += this.steps[i]!.cells.length;
    if (total > maxCells) return null;
    const all = new Uint32Array(total);
    let at = 0;
    for (let i = point.first; i < this.steps.length; i++) {
      all.set(this.steps[i]!.cells, at);
      at += this.steps[i]!.cells.length;
    }
    return sortedUnique(all);
  }
}

/** The values of `cells` ascending, each once (a sorted copy). */
function sortedUnique(cells: Uint32Array): Uint32Array {
  const sorted = Uint32Array.from(cells).sort();
  let kept = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] === sorted[i - 1]) continue;
    sorted[kept++] = sorted[i]!;
  }
  return sorted.subarray(0, kept);
}
