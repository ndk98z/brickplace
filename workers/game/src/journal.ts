import { DEDUPE_WINDOW } from './dedupe.ts';

// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module.
//
// The canvas's per-player state (ADR 0042): holds, daily team credit, season numbers and the
// dedupe window. A write used to upsert each changed row and insert each dedupe key (and
// delete the oldest), about 8 rows written per accepted op. Now each write that changes any of
// them adds one row to `state_journal` (more only past JOURNAL_ROW_BYTES), in the same
// transaction as its ops: the dedupe keys it accepted and the end values of the rows it
// changed. The rows live in memory over their tables until a fold writes each changed one once
// (every STATE_FOLD_MS, at season close), and a start reads the journal back: keys into the
// window, rows after the fold onto the tables. Journal rows go once folded, or, when they hold
// dedupe keys, once those leave the window.

/** Least time between two folds of the journal into the tables (ms). */
export const STATE_FOLD_MS = 5 * 60 * 1000;

/**
 * Most bytes of rows in one journal row: SQLite in a Durable Object refuses a row over 2 MB,
 * and one hold read for every due player of a shard can change thousands of holds at once.
 */
export const JOURNAL_ROW_BYTES = 1_000_000;

/** The limits in use; tests lower them. */
export const journalLimits = { rowBytes: JOURNAL_ROW_BYTES };

export interface InventoryRow {
  readonly items: string;
  readonly draw_index: number;
  readonly since: number;
  readonly config_version: number;
  readonly revision: number;
}

export interface CreditRow {
  readonly day: number;
  readonly cells: number;
}

export interface SeasonRow {
  readonly bricks: number;
  readonly hammers: number;
  readonly shields: number;
  readonly days: number;
  readonly last_day: number;
}

interface Rows {
  inventory: InventoryRow;
  team_credit: CreditRow;
  player_season: SeasonRow;
}

export type StateTable = keyof Rows;

/** Each table's columns besides `player`, in the order the fold writes them. */
const COLUMNS: { readonly [T in StateTable]: readonly (keyof Rows[T] & string)[] } = {
  inventory: ['items', 'draw_index', 'since', 'config_version', 'revision'],
  team_credit: ['day', 'cells'],
  player_season: ['bricks', 'hammers', 'shields', 'days', 'last_day'],
};

/** One table's rows by player, as the code that owns the table reads and changes them. */
export interface RowStore<R> {
  get(player: string): R | undefined;
  put(player: string, row: R): void;
}

type AnyRow = Rows[StateTable];
type JournalRow = readonly [StateTable, string, AnyRow];

const FOLDED = 'state_folded';
const utf8 = new TextEncoder();

/**
 * Writes a canvas's unfolded player rows to their tables now, for code that reads or writes
 * those tables directly (tests stocking holds). `canvas` is the CanvasDO instance.
 */
export function foldNow(canvas: unknown, storage: DurableObjectStorage): void {
  const state = (canvas as { state?: PlayerState }).state;
  if (state) storage.transactionSync(() => state.fold());
}

/**
 * `k`: the dedupe keys a write accepted (JSON), `keys` their count; `r`: the rows it changed
 * (JSON `[table, player, row]` triples). Either may be null.
 */
export function createJournalTable(sql: SqlStorage): void {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS state_journal (n INTEGER PRIMARY KEY, keys INTEGER NOT NULL, ' +
      'k TEXT, r TEXT)',
  );
}

/**
 * The per-player state over its tables. Reads go to the rows changed since the last fold, then
 * to the table. Changes are staged by `put` and `accept` and journaled by `commit`, which the
 * canvas runs at the end of every write transaction (CanvasDO.write, which restarts the object
 * when a transaction fails, so memory never keeps what storage lost).
 */
export class PlayerState {
  /** Rows changed since the last fold, at their newest values. */
  private readonly unfolded = new Map<StateTable, Map<string, AnyRow>>();
  /** What the write under way changed, journaled by commit(). */
  private readonly stagedKeys = new Set<string>();
  private readonly stagedRows = new Map<string, JournalRow>();
  /** Dedupe keys in the window, and the journal rows holding them, oldest first. */
  private readonly keys = new Set<string>();
  private keyed: { readonly n: number; readonly keys: readonly string[] }[] = [];
  private keyCount = 0;
  /** Highest journal row, and the highest one whose rows the tables have. */
  private lastN: number;
  private foldedTo: number;
  /** `accepted_ops` holds keys from before ADR 0042: read until the window first moves. */
  private legacy: boolean;

  constructor(
    private readonly sql: SqlStorage,
    private readonly window = DEDUPE_WINDOW,
  ) {
    createJournalTable(sql);
    const folded = sql
      .exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', FOLDED)
      .toArray()[0];
    this.foldedTo = folded ? Number(folded.value) : 0;
    const last = sql.exec<{ m: number | null }>('SELECT MAX(n) AS m FROM state_journal').one().m;
    this.lastN = Math.max(this.foldedTo, last ?? 0);
    for (const row of sql.exec<{ n: number; k: string }>(
      'SELECT n, k FROM state_journal WHERE keys > 0 ORDER BY n',
    )) {
      this.remember(row.n, JSON.parse(row.k) as string[]);
    }
    for (const row of sql.exec<{ r: string }>(
      'SELECT r FROM state_journal WHERE n > ? AND r IS NOT NULL ORDER BY n',
      this.foldedTo,
    )) {
      for (const [table, player, r] of JSON.parse(row.r) as JournalRow[]) {
        this.set(table, player, r);
      }
    }
    // A hold the table has at a later revision was written by a game script that ignored this
    // journal (rolled back, then forward again): the table's is the newer one.
    const holds = this.unfolded.get('inventory');
    for (const [player, row] of holds ?? []) {
      const stored = sql
        .exec<{ revision: number }>('SELECT revision FROM inventory WHERE player = ?', player)
        .toArray()[0];
      if (stored && stored.revision >= (row as InventoryRow).revision) holds!.delete(player);
    }
    this.legacy = sql.exec('SELECT 1 FROM accepted_ops LIMIT 1').toArray().length > 0;
  }

  /** The store `table`'s owner reads and changes it through. */
  store<T extends StateTable>(table: T): RowStore<Rows[T]> {
    return {
      get: (player) => this.get(table, player),
      put: (player, row) => this.put(table, player, row),
    };
  }

  get<T extends StateTable>(table: T, player: string): Rows[T] | undefined {
    const changed = this.unfolded.get(table)?.get(player);
    if (changed) return changed as Rows[T];
    const columns = COLUMNS[table].join(', ');
    return this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT ${columns} FROM ${table} WHERE player = ?`,
        player,
      )
      .toArray()[0] as Rows[T] | undefined;
  }

  put<T extends StateTable>(table: T, player: string, row: Rows[T]): void {
    this.set(table, player, row);
    this.stagedRows.set(`${table}\u0000${player}`, [table, player, row]);
  }

  /**
   * True when a move was accepted within the window: `key` is CanvasDO's moveKey of the
   * (player, client, opId) given, which `accepted_ops` still holds from before ADR 0042.
   */
  accepted(key: string, player: string, client: string, opId: number): boolean {
    if (this.keys.has(key)) return true;
    return (
      this.legacy &&
      this.sql
        .exec(
          'SELECT 1 FROM accepted_ops WHERE player = ? AND client = ? AND op_id = ?',
          player,
          client,
          opId,
        )
        .toArray().length > 0
    );
  }

  /** Remembers an accepted move's key, with the write under way. */
  accept(key: string): void {
    if (!this.keys.has(key)) this.stagedKeys.add(key);
  }

  /** Something changed since the last fold, so a fold is owed. */
  get unfoldedRows(): boolean {
    return this.lastN > this.foldedTo || this.stagedRows.size > 0;
  }

  /**
   * Journals what the write under way staged, as one row (several when its rows pass
   * journalLimits.rowBytes), then drops the oldest keyed rows past the window (folding first
   * when their rows are not in the tables yet). Runs inside the write's transaction; does
   * nothing when nothing was staged.
   */
  commit(): void {
    const keys = [...this.stagedKeys];
    if (keys.length === 0 && this.stagedRows.size === 0) return;
    const chunks: string[][] = [];
    let chunk: string[] = [];
    let bytes = 0;
    for (const row of this.stagedRows.values()) {
      const text = JSON.stringify(row);
      // UTF-8 bytes, as SQLite counts them: player ids need not be ASCII.
      const size = utf8.encode(text).length + 1;
      if (chunk.length > 0 && bytes + size > journalLimits.rowBytes) {
        chunks.push(chunk);
        chunk = [];
        bytes = 0;
      }
      chunk.push(text);
      bytes += size;
    }
    if (chunk.length > 0 || chunks.length === 0) chunks.push(chunk);
    this.stagedKeys.clear();
    this.stagedRows.clear();
    let n = this.lastN;
    chunks.forEach((rows, i) => {
      n += 1;
      const k = i === 0 ? keys : [];
      this.sql.exec(
        'INSERT INTO state_journal (n, keys, k, r) VALUES (?, ?, ?, ?)',
        n,
        k.length,
        k.length > 0 ? JSON.stringify(k) : null,
        rows.length > 0 ? `[${rows.join(',')}]` : null,
      );
      if (k.length > 0) this.remember(n, k);
    });
    this.lastN = n;
    while (this.keyed.length > 1 && this.keyCount - this.keyed[0]!.keys.length >= this.window) {
      const oldest = this.keyed[0]!;
      if (oldest.n > this.foldedTo) this.fold();
      this.sql.exec('DELETE FROM state_journal WHERE n = ?', oldest.n);
      // The window has moved: keys from before ADR 0042 are older than it (unless a rolled-back
      // script wrote some since, which ADR 0042 counts as lost), and the old table goes.
      if (this.legacy) this.sql.exec('DELETE FROM accepted_ops');
      this.legacy = false;
      this.keyed.shift();
      for (const key of oldest.keys) this.keys.delete(key);
      this.keyCount -= oldest.keys.length;
    }
  }

  /**
   * Writes every row changed since the last fold to its table, once, and deletes the journal
   * rows that held only rows. Runs inside a write (CanvasDO.write); memory changes only once
   * every statement went through.
   */
  fold(): void {
    this.commit();
    if (this.lastN <= this.foldedTo) return;
    for (const [table, rows] of this.unfolded) {
      const columns = COLUMNS[table];
      const upsert =
        `INSERT INTO ${table} (player, ${columns.join(', ')}) ` +
        `VALUES (?, ${columns.map(() => '?').join(', ')}) ON CONFLICT (player) DO UPDATE SET ` +
        columns.map((c) => `${c} = excluded.${c}`).join(', ');
      for (const [player, row] of rows) {
        const values = columns.map((c) => (row as unknown as Record<string, SqlStorageValue>)[c]!);
        this.sql.exec(upsert, player, ...values);
      }
    }
    this.sql.exec(
      'DELETE FROM state_journal WHERE n > ? AND n <= ? AND keys = 0',
      this.foldedTo,
      this.lastN,
    );
    this.sql.exec(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      FOLDED,
      String(this.lastN),
    );
    this.unfolded.clear();
    this.foldedTo = this.lastN;
  }

  /**
   * The seal emptied the player tables, the journal among them (archive.ts PLAYER_TABLES):
   * drops the fold mark in its transaction. Call `forget` once that transaction went through.
   */
  resetStorage(): void {
    this.sql.exec('DELETE FROM meta WHERE key = ?', FOLDED);
  }

  /** Forgets everything after the seal's transaction emptied the tables (resetStorage). */
  forget(): void {
    this.unfolded.clear();
    this.stagedKeys.clear();
    this.stagedRows.clear();
    this.keys.clear();
    this.keyed = [];
    this.keyCount = 0;
    this.lastN = 0;
    this.foldedTo = 0;
    this.legacy = false;
  }

  /** Dedupe keys held in memory, for tests and the seal's check. */
  get keyTotal(): number {
    return this.keyCount;
  }

  private set(table: StateTable, player: string, row: AnyRow): void {
    let rows = this.unfolded.get(table);
    if (!rows) {
      rows = new Map();
      this.unfolded.set(table, rows);
    }
    rows.set(player, row);
  }

  private remember(n: number, keys: readonly string[]): void {
    this.keyed.push({ n, keys });
    for (const key of keys) this.keys.add(key);
    this.keyCount += keys.length;
  }
}
