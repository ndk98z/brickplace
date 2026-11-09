// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module.

/**
 * How many accepted ops the canvas remembers by (player, client, opId) to answer retries
 * (ADR 0017 added the client, the sending page's connection id).
 * Kept durable, not only in memory, because the usual reason for an `unavailable` ack is a
 * CanvasDO restart (game deploy), which wipes memory before the retry arrives: since ADR 0042
 * in the journal rows of the writes that accepted them (journal.ts), read back at start;
 * `accepted_ops` below keeps the keys from before, read but no longer written. Bounded by
 * a global count rather than time or per player: a retry comes seconds after the failure,
 * and 100k ops is about 100 s at the ~1,000 ops/s ceiling of one DO (ADR 0003) and hours at
 * Stage 0 traffic, for a table of a few MB. Rejected ops are not remembered: they changed
 * nothing, so evaluating a retry again still applies the op at most once. One flooding
 * player could push others' keys out early; the per-player cooldown (PROGRESS.md) caps that.
 */
export const DEDUPE_WINDOW = 100_000;

/**
 * Creates `accepted_ops`, oldest first by n and trimmed to DEDUPE_WINDOW rows. A canvas from
 * before ADR 0017 kept (player, opId) in `recent_ops`, unique on those two; its rows move
 * over with the empty client that FanoutDOs of that time sent, so a retry that spans the
 * deploy is still recognised, and the old table goes in the same transaction.
 */
export function createDedupeTable(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const { sql } = storage;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS accepted_ops (n INTEGER PRIMARY KEY, player TEXT NOT NULL, ' +
        "client TEXT NOT NULL DEFAULT '', op_id INTEGER NOT NULL, UNIQUE (player, client, op_id))",
    );
    const old = sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recent_ops'")
      .toArray();
    if (old.length === 0) return;
    // Fresh ids, appended in the old order: after a rollback and a second roll-forward the
    // old table restarts its n at 1, and reusing those would collide with rows kept here.
    sql.exec(
      'INSERT OR IGNORE INTO accepted_ops (player, client, op_id) ' +
        "SELECT player, '', op_id FROM recent_ops ORDER BY n",
    );
    sql.exec('DROP TABLE recent_ops');
  });
}
