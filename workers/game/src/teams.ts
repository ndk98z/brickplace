import {
  type CellDiff,
  cellsOf,
  isFilled,
  type LogEntry,
  type RestoreEntry,
} from '@brickplace/core';
import { gunzip, gzip, sha256Hex, storedParts } from './checkpoints.ts';
import type { CreditRow, RowStore } from './journal.ts';

// Teams on the map (ADR 0020): who last wrote each live cell and which team it counted for,
// so the ranking can count the cells each team has standing, and moderation can later find a
// player's cells. Not a game rule, so it lives here and not in packages/core: the op entries
// and golden fixtures are unchanged. Kept out of the Worker entry (index.ts), which may export
// only handlers and Durable Object classes.
//
// How it stays consistent with the grid (ADR 0014):
// - every op_log row of player ops carries `who`: [player, team] per op, the team the op
//   counted for (0: none), so a replay of the log tail rebuilds exactly what the live canvas
//   did, whatever the cap or the player's team is by then;
// - the per-cell writer ids and the season totals are checkpointed beside the grid, at the
//   same seq, and made current in the same transaction as the grid checkpoint, so a trimmed
//   log never has to be read again;
// - writer ids are rows of `writers`, written in the transaction of the first op that used
//   them and never deleted during a season.

/** Largest team id a canvas accepts: D1 row ids, far below 2^31. */
export const MAX_TEAM = 2_147_483_647;
/**
 * KV key (MODERATION namespace, written from the private ops repo) holding how many cells one
 * account may place per UTC day that count toward its team: a whole number. An abuse
 * threshold, so never in this repo. Missing, malformed or not read yet: no placement counts
 * toward any team (fail closed, ADR 0020). `pnpm dev` writes a value into local KV.
 */
export const TEAM_CAP_KEY = 'team-daily-cells';
export const DAY_MS = 24 * 60 * 60 * 1000;
/** Standings go to D1 (STANDINGS) at most this often while they change (ms). */
export const PUBLISH_MS = 60_000;
/** How long a canvas keeps the cap before reading KV again (ms). */
const CAP_TTL_MS = 5 * 60 * 1000;
/**
 * A KV read of the cap that has not answered by then counts as failed (ms): a hung read would
 * otherwise stay "under way" for good, and the cap would never be read again.
 */
export const CAP_READ_TIMEOUT_MS = 5_000;
export const TEAM_CHECKPOINT_FORMAT = 1;
const PART_BYTES = 1 << 20;
/** Writer ids kept in memory by name; a bound, not a tuning knob (SQLite has them all). */
const MAX_CACHED_WRITERS = 10_000;
/** Statements per D1 batch when publishing standings. */
const PUBLISH_BATCH = 50;

/** Who wrote an op: the player and the team it counted for (0: none). */
export type Who = readonly [player: string, team: number];

export interface TeamStats {
  /** Cells on the map now whose last writer counted for the team. */
  readonly cells: number;
  /** Cells placed for the team this season. */
  readonly built: number;
  /** Cells the team's hammers emptied this season. */
  readonly cleared: number;
  /** Shield layers the team placed this season. */
  readonly shields: number;
}

type Stats = { cells: number; built: number; cleared: number; shields: number };

interface TeamCheckpointMeta {
  readonly seq: number;
  readonly format: number;
  readonly gen: number;
  readonly parts: number;
  readonly sha256: string;
}

/** A team id as the gateway sends it; anything else counts for no team. */
export function validTeam(team: unknown): number {
  return typeof team === 'number' && Number.isSafeInteger(team) && team > 0 && team <= MAX_TEAM
    ? team
    : 0;
}

export function createTeamTables(sql: SqlStorage): void {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS writers (id INTEGER PRIMARY KEY, player TEXT NOT NULL, ' +
      'team INTEGER NOT NULL, UNIQUE (player, team))',
  );
  // Cells counted toward a team today, per player: the daily contribution cap.
  sql.exec(
    'CREATE TABLE IF NOT EXISTS team_credit (player TEXT PRIMARY KEY, day INTEGER NOT NULL, ' +
      'cells INTEGER NOT NULL)',
  );
  sql.exec(
    'CREATE TABLE IF NOT EXISTS team_checkpoint_parts (gen INTEGER NOT NULL, ' +
      'part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (gen, part))',
  );
  // Rows logged before teams existed have none: their ops count for nobody.
  const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('op_log')");
  if (!columns.toArray().some((c) => c.name === 'who')) {
    sql.exec('ALTER TABLE op_log ADD COLUMN who TEXT');
  }
}

/**
 * The `who` column of a log row of player ops: one [player, team] per entry, or null when
 * absent. A damaged value (not JSON, not a list of one item per entry, an item that is neither
 * a pair nor null) counts for nobody where it is damaged, and calls `unreadable` once, so the
 * caller can log it (`who_unreadable`, with the row's seq and never the value: it holds ids).
 * Not for a restore row, whose `who` has a shape of its own (parseRestoreWho).
 */
export function parseWho(value: unknown, entries: number, unreadable?: () => void): (Who | null)[] {
  const out: (Who | null)[] = new Array(entries).fill(null);
  if (value === null || value === undefined) return out;
  // A damaged value counts for nobody, as in parseRestoreWho: never a throw, whose message
  // would quote the ids in it, and never a canvas that cannot replay its log.
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : null;
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    unreadable?.();
    return out;
  }
  let damaged = parsed.length !== entries;
  for (let i = 0; i < entries; i++) {
    const item = parsed[i] as unknown;
    if (Array.isArray(item) && typeof item[0] === 'string') {
      out[i] = [item[0], validTeam(item[1])];
    } else if (item !== null) {
      damaged = true;
    }
  }
  if (damaged) unreadable?.();
  return out;
}

/**
 * Who wrote each cell a restore row sets (ADR 0024): the (player, team) pairs, and for each
 * listed cell, in the entry's order, the 1-based pair that wrote it in the replay the restore
 * comes from, or 0 for nobody (an empty cell, or one written before teams existed).
 */
export interface RestoreWho {
  readonly pairs: readonly Who[];
  readonly of: readonly number[];
}

/**
 * The `who` column of a restore row, stored as `[{"pairs": [...], "of": [...]}]` (one item, as
 * the row has one entry; parseWho reads that item as "no who"). Null when absent or malformed:
 * the restored cells then count for nobody.
 */
export function parseRestoreWho(value: unknown, cells: number): RestoreWho | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const item = Array.isArray(parsed) ? (parsed[0] as unknown) : null;
  if (typeof item !== 'object' || item === null) return null;
  const { pairs, of } = item as { pairs?: unknown; of?: unknown };
  if (!Array.isArray(pairs) || !Array.isArray(of) || of.length !== cells) return null;
  const who: Who[] = [];
  for (const pair of pairs as unknown[]) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') return null;
    who.push([pair[0], validTeam(pair[1])]);
  }
  const refs = (of as unknown[]).map((n) =>
    Number.isInteger(n) && (n as number) >= 0 && (n as number) <= who.length ? (n as number) : 0,
  );
  return { pairs: who, of: refs };
}

/** The `who` column a restore row stores for `restore`. */
export function restoreWhoColumn(restore: RestoreWho): string {
  return JSON.stringify([{ pairs: restore.pairs, of: restore.of }]);
}

/** The cells a placement fills, or none for other entries. */
function placedCells(entry: LogEntry, size: number): number[] {
  if (entry.kind === 'single') return [entry.y * size + entry.x];
  if (entry.kind !== 'brick') return [];
  return cellsOf(entry.shape, entry.rotation).map(
    ([dx, dy]) => (entry.y + dy) * size + entry.x + dx,
  );
}

/**
 * The last writer of every cell and the counters per team, updated per op (never by a scan,
 * except once at start-up from the checkpoint). Ops must be fed in log order, each right after
 * the core accepted it, with the diffs it returned.
 */
export class TeamLedger {
  /** Writer id per cell; 0: nobody known (empty, or written before teams existed). */
  private readonly cells: Uint32Array;
  /**
   * Team by writer id (id 0 is nobody), grown by doubling. Player names stay in SQLite: a
   * season may see hundreds of thousands of players, and only the team is needed per op.
   */
  private teams = new Int32Array(1024);
  /** Writer ids in use: the next new one. */
  private writers = 1;
  /** Recently used writer ids by `[player, team]` JSON, bounded; SQLite has them all. */
  private readonly ids = new Map<string, number>();
  private readonly stats = new Map<number, Stats>();
  /** Teams whose stats changed since they last went to D1. */
  private readonly dirty = new Set<number>();
  /** Writers made since the last save; stored in the transaction of the ops that use them. */
  private fresh: { id: number; player: string; team: number }[] = [];
  /** Today's counted cells per player, read on first use. */
  private readonly credit = new Map<string, { day: number; cells: number; changed: boolean }>();
  /**
   * Where the credit rows are read and written: the canvas's player state (journal.ts, ADR
   * 0042) once it hands it over (useCredits), the `team_credit` table until then.
   */
  private credits: RowStore<CreditRow> | null = null;
  private cap: { value: number | null; at: number } | null = null;
  /** The KV read under way, so a burst of ops starts one. */
  private capRead: Promise<void> | null = null;
  private publishedAt = Number.NEGATIVE_INFINITY;

  private constructor(
    private readonly sql: SqlStorage,
    readonly size: number,
  ) {
    this.cells = new Uint32Array(size * size);
    // Integers only: 8 bytes a writer, whatever the names.
    const rows = sql.exec<{ id: number; team: number }>('SELECT id, team FROM writers ORDER BY id');
    for (const { id, team } of rows) {
      // Ids are written in transactions, so a gap cannot happen; if one ever did, the ids
      // after it still map to their teams and the canvas still starts.
      if (id < this.writers) continue;
      if (id > this.writers) console.error(`CanvasDO: writers table has a gap before ${id}`);
      while (this.writers < id) this.addWriter(0);
      this.addWriter(team);
    }
  }

  /**
   * The ledger as of log seq `seq`: the team checkpoint stored with the grid checkpoint at that
   * seq, or empty when there is none (a new canvas, or one older than teams: its cells count
   * for nobody). Then the caller replays the log rows after `seq` through `record`. A team
   * checkpoint that does not read back is logged and dropped: the map must start whatever
   * happened to the ranking's data, and the next checkpoint replaces it.
   */
  static async restore(sql: SqlStorage, size: number, seq: number): Promise<TeamLedger> {
    const meta = readMeta(sql);
    let body: Uint8Array | null = null;
    if (meta && meta.seq === seq) {
      try {
        body = await readParts(sql, meta);
      } catch (error) {
        console.error('CanvasDO: team checkpoint unreadable; starting empty', error);
      }
    } else if (meta) {
      // Both are made current in one transaction, so this is a bug, not an outage. The map
      // must keep running; the ranking loses what the checkpoint held.
      console.error(`CanvasDO: team checkpoint at seq ${meta.seq}, grid at ${seq}; starting empty`);
    } else if (seq > 0) {
      console.warn(`CanvasDO: no team checkpoint at seq ${seq}; earlier cells count for nobody`);
    }
    return TeamLedger.fromBody(sql, size, body);
  }

  /**
   * The ledger from a team checkpoint body (checked against its SHA-256 by the caller), or empty
   * for null. The body may come from the grid checkpoint's R2 copy when the canvas recovers from
   * one: its writer ids are rows of this canvas's `writers`, which never lose a row in a season.
   */
  static fromBody(sql: SqlStorage, size: number, body: Uint8Array | null): TeamLedger {
    let ledger = new TeamLedger(sql, size);
    if (body) {
      try {
        ledger.decode(body);
      } catch (error) {
        console.error('CanvasDO: team checkpoint unreadable; starting empty', error);
        // A half-decoded ledger would hold partial stats.
        ledger = new TeamLedger(sql, size);
      }
    }
    // Recounted, like the core's counters: cheap once, and never out of step with the cells.
    for (const writer of ledger.cells) {
      const team = ledger.teams[writer]!;
      if (team !== 0) ledger.statsOf(team).cells++;
    }
    // D1 may hold older numbers than a restore gives: send every team again.
    for (const team of ledger.stats.keys()) ledger.dirty.add(team);
    return ledger;
  }

  /** The stats of one team (all zero when it has none). */
  standing(team: number): TeamStats {
    return { ...(this.stats.get(team) ?? { cells: 0, built: 0, cleared: 0, shields: 0 }) };
  }

  /** Every team with any stats, by id. */
  all(): Map<number, TeamStats> {
    return new Map([...this.stats].map(([team, s]) => [team, { ...s }]));
  }

  /**
   * The writer id of every cell in the team checkpoint stored for log seq `seq`, or null when
   * there is none at that seq (or it does not read back). For a rollback that starts from the
   * grid checkpoint (ADR 0024); the live ledger is not touched.
   */
  static async checkpointCells(
    sql: SqlStorage,
    size: number,
    seq: number,
  ): Promise<Uint32Array | null> {
    const meta = readMeta(sql);
    if (!meta || meta.seq !== seq) return null;
    let body: Uint8Array;
    try {
      body = await readParts(sql, meta);
    } catch (error) {
      console.error('CanvasDO: team checkpoint unreadable for a rollback', error);
      return null;
    }
    return TeamLedger.cellsOf(body, size);
  }

  /**
   * The writer id of every cell in a team checkpoint body, or null when it does not read (a
   * rollback then cannot start from the grid state stored with it).
   */
  static cellsOf(body: Uint8Array, size: number): Uint32Array | null {
    try {
      const input = new Reader(body);
      if (input.u32() !== TEAM_CHECKPOINT_FORMAT || input.u32() !== size) return null;
      const writers = input.u32();
      const count = input.u32();
      for (let n = 0; n < count; n++) {
        input.u32();
        input.varint();
        input.varint();
        input.varint();
      }
      const cells = new Uint32Array(size * size);
      let i = 0;
      while (i < cells.length) {
        const value = input.varint();
        const run = input.varint();
        if (value >= writers || run < 1 || i + run > cells.length) return null;
        cells.fill(value, i, i + run);
        i += run;
      }
      return cells;
    } catch (error) {
      console.error('CanvasDO: team checkpoint unreadable for a rollback', error);
      return null;
    }
  }

  /** Who last wrote a live cell, or null when nobody is known. */
  writerAt(index: number): Who | null {
    return this.whoOf(this.cells[index] ?? 0);
  }

  /** The writer id of a cell (0: nobody known). */
  writerIdAt(index: number): number {
    return this.cells[index] ?? 0;
  }

  /** The (player, team) pair of a writer id, or null for 0 or an unknown id. */
  whoOf(id: number): Who | null {
    if (id === 0) return null;
    const unsaved = this.fresh.find((w) => w.id === id);
    if (unsaved) return [unsaved.player, unsaved.team];
    const row = this.sql
      .exec<{ player: string; team: number }>('SELECT player, team FROM writers WHERE id = ?', id)
      .toArray()[0];
    return row ? [row.player, row.team] : null;
  }

  /**
   * Reads the daily cap from KV when the value is a few minutes old, one read at a time. Ops
   * never wait for it: they call this without awaiting and use whatever value is there, so a
   * slow or failing KV cannot hold up the map. Until a value has arrived, and whenever KV has
   * none (or a malformed one), nothing counts (fail closed). A failed read keeps the last
   * value until the next try, and so does one that has not answered within `timeoutMs`: a hung
   * KV must not keep the read "under way" for good. Nothing in the canvas awaits this; it
   * returns the read under way for tests to wait on.
   */
  refreshCap(
    kv: KVNamespace | undefined,
    now: number,
    timeoutMs: number = CAP_READ_TIMEOUT_MS,
  ): Promise<void> {
    if (this.capRead) return this.capRead;
    if (this.cap && now - this.cap.at < CAP_TTL_MS) return Promise.resolve();
    this.capRead = this.readCap(kv, now, timeoutMs).finally(() => {
      this.capRead = null;
    });
    return this.capRead;
  }

  private async readCap(
    kv: KVNamespace | undefined,
    now: number,
    timeoutMs: number,
  ): Promise<void> {
    let text: string | null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
      });
      text = kv ? await Promise.race([kv.get(TEAM_CAP_KEY), timeout]) : null;
    } catch (error) {
      console.error('team cap unreadable', error);
      this.cap = { value: this.cap?.value ?? null, at: now };
      return;
    } finally {
      clearTimeout(timer);
    }
    const trimmed = text?.trim() ?? '';
    const value = /^\d{1,9}$/.test(trimmed) ? Number(trimmed) : null;
    if (value === null) {
      console.error(
        text === null
          ? `${TEAM_CAP_KEY} is not set: no cell counts toward a team`
          : `${TEAM_CAP_KEY} is not a whole number`,
      );
    }
    this.cap = { value, at: now };
  }

  /**
   * Records an op the core just accepted for `player`, who plays for `team` (0: none), and
   * returns what the log row stores for it. A placement counts for the team only within the
   * player's daily cap (by the op's logical day); past it, or without a cap, the cells are
   * the player's but count for no team. Hammers and shields always count for the team: they
   * add no cells to it.
   */
  accept(
    player: string,
    team: number | undefined,
    entry: LogEntry,
    diffs: readonly CellDiff[],
    at: number,
  ): Who {
    let counted = validTeam(team);
    const placed = placedCells(entry, this.size).length;
    if (counted !== 0 && placed > 0 && !this.spend(player, placed, at)) counted = 0;
    const who: Who = [player, counted];
    this.record(entry, diffs, who);
    return who;
  }

  /**
   * The writer id of a (player, team) pair, or 0 when the pair never wrote here (or `who` is
   * null). Reads only: a rollback's replay uses it without giving out new ids.
   */
  idOf(who: Who | null): number {
    if (!who) return 0;
    const [player, team] = who;
    return (
      this.ids.get(JSON.stringify(who)) ??
      this.fresh.find((w) => w.player === player && w.team === team)?.id ??
      this.sql
        .exec<{ id: number }>('SELECT id FROM writers WHERE player = ? AND team = ?', player, team)
        .toArray()[0]?.id ??
      0
    );
  }

  /**
   * Applies a restore (ADR 0024): each listed cell gets the writer it has in the replay the
   * restore comes from (`who`), or nobody when it is empty or `who` names none. Cells standing
   * move between teams; the season totals (built, cleared, shields) are history and stay.
   */
  restore(entry: RestoreEntry, who: RestoreWho | null): void {
    entry.cells.forEach((item, k) => {
      const ref = who?.of[k] ?? 0;
      const pair = ref > 0 ? who?.pairs[ref - 1] : undefined;
      this.set(item[0], isFilled(item[1]) && pair ? this.writerFor(pair) : 0);
    });
  }

  /** Applies one accepted log entry: live through `accept`, and on replay with its `who`. */
  record(entry: LogEntry, diffs: readonly CellDiff[], who: Who | null): void {
    // Growth changes no cell; a restore goes through `restore`, with its own `who`.
    if (entry.kind === 'open' || entry.kind === 'restore') return;
    const writer = who ? this.writerFor(who) : 0;
    const team = this.teams[writer]!;
    switch (entry.kind) {
      case 'brick':
      case 'single': {
        // A placement only fills empty cells, so each held no writer.
        const placed = placedCells(entry, this.size);
        for (const index of placed) this.set(index, writer);
        if (team !== 0) this.bump(team, 'built', placed.length);
        return;
      }
      case 'hammer': {
        const index = entry.y * this.size + entry.x;
        // The cell's last diff: earlier ones may be shield layers expiring first.
        let last: CellDiff | undefined;
        for (const d of diffs) if (d.index === index) last = d;
        // A hammer on a shielded cell breaks a layer and leaves the cell (and its writer).
        if (last && !isFilled(last.cell)) {
          this.set(index, 0);
          if (team !== 0) this.bump(team, 'cleared', 1);
        }
        return;
      }
      case 'shield':
        if (team !== 0) this.bump(team, 'shields', 1);
        return;
    }
  }

  /** Writes new writer ids and today's counts; run inside the transaction of the ops. */
  save(): void {
    for (const { id, player, team } of this.fresh) {
      this.sql.exec('INSERT INTO writers (id, player, team) VALUES (?, ?, ?)', id, player, team);
    }
    this.fresh = [];
    for (const [player, entry] of this.credit) {
      if (!entry.changed) continue;
      if (this.credits) {
        this.credits.put(player, { day: entry.day, cells: entry.cells });
      } else {
        this.sql.exec(
          'INSERT INTO team_credit (player, day, cells) VALUES (?, ?, ?) ' +
            'ON CONFLICT (player) DO UPDATE SET day = excluded.day, cells = excluded.cells',
          player,
          entry.day,
          entry.cells,
        );
      }
      entry.changed = false;
    }
    // Bounded memory: the rows are stored and read back on next use.
    if (this.credit.size > 10_000) this.credit.clear();
  }

  /** Reads and writes the credit rows through `store` from now on (ADR 0042). */
  useCredits(store: RowStore<CreditRow>): void {
    this.credits = store;
  }

  /** True when there is something to save (only replay can leave writers unsaved). */
  get unsaved(): boolean {
    return this.fresh.length > 0;
  }

  /** The checkpoint body: taken synchronously, at the same seq as the grid's. */
  encode(): Uint8Array {
    const out = new Bytes();
    out.u32(TEAM_CHECKPOINT_FORMAT);
    out.u32(this.size);
    out.u32(this.writers);
    const teams = [...this.stats.keys()].sort((a, b) => a - b);
    out.u32(teams.length);
    for (const team of teams) {
      const s = this.stats.get(team)!;
      out.u32(team);
      out.varint(s.built);
      out.varint(s.cleared);
      out.varint(s.shields);
    }
    // Run lengths of writer ids along rows: most of a map is empty or one writer per brick.
    const { cells } = this;
    let i = 0;
    while (i < cells.length) {
      const value = cells[i]!;
      let run = 1;
      while (i + run < cells.length && cells[i + run] === value) run++;
      out.varint(value);
      out.varint(run);
      i += run;
    }
    return out.bytes();
  }

  private decode(body: Uint8Array): void {
    const input = new Reader(body);
    if (input.u32() !== TEAM_CHECKPOINT_FORMAT) throw new Error('team checkpoint: unknown format');
    if (input.u32() !== this.size) throw new Error('team checkpoint: map size differs');
    const writers = input.u32();
    if (writers > this.writers) throw new Error('team checkpoint: writers missing');
    const count = input.u32();
    for (let n = 0; n < count; n++) {
      const team = input.u32();
      const s = this.statsOf(team);
      s.built = input.varint();
      s.cleared = input.varint();
      s.shields = input.varint();
    }
    let i = 0;
    while (i < this.cells.length) {
      const value = input.varint();
      const run = input.varint();
      if (value >= writers || run < 1 || i + run > this.cells.length) {
        throw new Error('team checkpoint: bad cell run');
      }
      this.cells.fill(value, i, i + run);
      i += run;
    }
    if (!input.done) throw new Error('team checkpoint: trailing bytes');
  }

  /**
   * Stores a team checkpoint for `seq` beside the current one and checks it reads back. It
   * becomes current only through the returned commit, which the grid checkpoint runs in the
   * transaction that makes the grid's current, so the two always share a seq.
   */
  async stage(seq: number, body: Uint8Array, save: (fn: () => void) => void): Promise<() => void> {
    const current = readMeta(this.sql);
    const compressed = await gzip(body);
    const meta: TeamCheckpointMeta = {
      seq,
      format: TEAM_CHECKPOINT_FORMAT,
      gen: (current?.gen ?? 0) + 1,
      parts: Math.max(1, Math.ceil(compressed.byteLength / PART_BYTES)),
      sha256: await sha256Hex(body),
    };
    save(() => {
      this.sql.exec('DELETE FROM team_checkpoint_parts WHERE gen <> ?', current?.gen ?? -1);
      for (let part = 0; part < meta.parts; part++) {
        const chunk = compressed.slice(part * PART_BYTES, (part + 1) * PART_BYTES);
        this.sql.exec(
          'INSERT INTO team_checkpoint_parts (gen, part, data) VALUES (?, ?, ?)',
          meta.gen,
          part,
          chunk.buffer,
        );
      }
    });
    await readParts(this.sql, meta);
    return () => {
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('team_checkpoint', ?) " +
          'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        JSON.stringify(meta),
      );
      this.sql.exec('DELETE FROM team_checkpoint_parts WHERE gen <> ?', meta.gen);
    };
  }

  /** When standings should next go to D1, or null when nothing changed. */
  publishDueAt(): number | null {
    return this.dirty.size > 0 ? this.publishedAt + PUBLISH_MS : null;
  }

  /**
   * Sends the changed teams' stats to D1 (absolute values, so a retry or a restart cannot
   * count twice). Teams that change meanwhile stay marked; a failure marks them all again.
   */
  async publish(db: D1Database, canvas: string, now: number): Promise<void> {
    const teams = [...this.dirty];
    if (teams.length === 0) return;
    const rows = teams.map((team) => [team, this.standing(team)] as const);
    this.dirty.clear();
    this.publishedAt = now;
    try {
      for (let i = 0; i < rows.length; i += PUBLISH_BATCH) {
        await db.batch(
          rows
            .slice(i, i + PUBLISH_BATCH)
            .map(([team, s]) =>
              db
                .prepare(
                  'INSERT INTO team_standings (canvas, team_id, cells, built, cleared, shields, ' +
                    'updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (canvas, team_id) DO ' +
                    'UPDATE SET cells = excluded.cells, built = excluded.built, cleared = ' +
                    'excluded.cleared, shields = excluded.shields, updated_at = excluded.updated_at',
                )
                .bind(canvas, team, s.cells, s.built, s.cleared, s.shields, now),
            ),
        );
      }
    } catch (error) {
      for (const team of teams) this.dirty.add(team);
      throw error;
    }
  }

  /** The id of a (player, team) pair: from the cache, the unsaved ones, SQLite, or a new one. */
  private writerFor(who: Who): number {
    const [player, team] = who;
    const key = JSON.stringify(who);
    let id = this.ids.get(key);
    if (id !== undefined) {
      // Most recently used last, so the oldest goes first below.
      this.ids.delete(key);
    } else {
      id =
        this.fresh.find((w) => w.player === player && w.team === team)?.id ??
        this.sql
          .exec<{ id: number }>(
            'SELECT id FROM writers WHERE player = ? AND team = ?',
            player,
            team,
          )
          .toArray()[0]?.id;
      if (id === undefined) {
        id = this.addWriter(team);
        this.fresh.push({ id, player, team });
      }
    }
    this.ids.set(key, id);
    if (this.ids.size > MAX_CACHED_WRITERS) {
      this.ids.delete(this.ids.keys().next().value!);
    }
    return id;
  }

  /** Takes the next writer id for `team`. */
  private addWriter(team: number): number {
    if (this.writers === this.teams.length) {
      const grown = new Int32Array(this.teams.length * 2);
      grown.set(this.teams);
      this.teams = grown;
    }
    this.teams[this.writers] = team;
    return this.writers++;
  }

  private set(index: number, writer: number): void {
    const old = this.cells[index]!;
    if (old === writer) return;
    const before = this.teams[old]!;
    const after = this.teams[writer]!;
    if (before !== 0) this.bump(before, 'cells', -1);
    if (after !== 0) this.bump(after, 'cells', 1);
    this.cells[index] = writer;
  }

  private bump(team: number, field: keyof Stats, by: number): void {
    this.statsOf(team)[field] += by;
    this.dirty.add(team);
  }

  private statsOf(team: number): Stats {
    let s = this.stats.get(team);
    if (!s) {
      s = { cells: 0, built: 0, cleared: 0, shields: 0 };
      this.stats.set(team, s);
    }
    return s;
  }

  /** Counts `cells` against the player's cap for the op's day; false when they do not fit. */
  private spend(player: string, cells: number, at: number): boolean {
    const cap = this.cap?.value ?? null;
    if (cap === null) return false;
    const day = Math.floor(at / DAY_MS);
    let entry = this.credit.get(player);
    if (!entry) {
      const row = this.credits
        ? this.credits.get(player)
        : this.sql
            .exec<{ day: number; cells: number }>(
              'SELECT day, cells FROM team_credit WHERE player = ?',
              player,
            )
            .toArray()[0];
      entry = { day: row?.day ?? day, cells: row?.cells ?? 0, changed: false };
      this.credit.set(player, entry);
    }
    // A new day starts from zero; an op logged with an earlier time than the last one (the
    // clock never goes back in the log, but be safe) counts against the newer day.
    if (day > entry.day) {
      entry.day = day;
      entry.cells = 0;
    }
    if (entry.cells + cells > cap) return false;
    entry.cells += cells;
    entry.changed = true;
    return true;
  }
}

function readMeta(sql: SqlStorage): TeamCheckpointMeta | null {
  const row = sql
    .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'team_checkpoint'")
    .toArray()[0];
  return row ? (JSON.parse(row.value) as TeamCheckpointMeta) : null;
}

/**
 * The stored team checkpoint for log seq `seq` as written (gzip bytes) with the SHA-256 of its
 * body, for the grid checkpoint's R2 copy; null when none is stored at that seq. Synchronous.
 */
export function storedTeamCheckpoint(
  sql: SqlStorage,
  seq: number,
): { readonly compressed: Uint8Array; readonly sha256: string } | null {
  const meta = readMeta(sql);
  if (!meta || meta.seq !== seq) return null;
  return { compressed: storedParts(sql, 'team_checkpoint_parts', meta), sha256: meta.sha256 };
}

async function readParts(sql: SqlStorage, meta: TeamCheckpointMeta): Promise<Uint8Array> {
  const body = await gunzip(storedParts(sql, 'team_checkpoint_parts', meta));
  if ((await sha256Hex(body)) !== meta.sha256) {
    throw new Error(`team checkpoint at seq ${meta.seq}: checksum mismatch`);
  }
  return body;
}

/** A growing little-endian byte buffer with unsigned LEB128 varints. */
class Bytes {
  private buffer = new Uint8Array(1 << 16);
  private length = 0;

  private room(n: number): void {
    if (this.length + n <= this.buffer.length) return;
    const next = new Uint8Array(Math.max(this.buffer.length * 2, this.length + n));
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  u32(value: number): void {
    this.room(4);
    new DataView(this.buffer.buffer).setUint32(this.length, value, true);
    this.length += 4;
  }

  varint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`varint ${value}`);
    this.room(8);
    let v = value;
    while (v >= 0x80) {
      this.buffer[this.length++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buffer[this.length++] = v;
  }

  /** A view of what was written: no copy of a body that can reach a few MiB. */
  bytes(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

class Reader {
  private at = 0;
  private readonly view: DataView;

  constructor(private readonly body: Uint8Array) {
    this.view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  }

  get done(): boolean {
    return this.at === this.body.length;
  }

  u32(): number {
    if (this.at + 4 > this.body.length) throw new Error('team checkpoint: truncated');
    const value = this.view.getUint32(this.at, true);
    this.at += 4;
    return value;
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (let n = 0; n < 8; n++) {
      if (this.at >= this.body.length) throw new Error('team checkpoint: truncated');
      const byte = this.body[this.at++]!;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 0x80;
    }
    throw new Error('team checkpoint: varint too long');
  }
}
