import {
  CHECKPOINT_FORMAT,
  decodeCheckpoint,
  gridHash,
  type State,
  verifyCheckpoint,
} from '@brickplace/core';

// Grid checkpoints in the canvas's own SQLite (ADR 0014). Only the latest verified one is
// kept: the op log after it (and R2 for everything before) is the history. Kept out of the
// Worker entry (index.ts), which may export only handlers and Durable Object classes.

/** Rows stay well under the 2 MB SQLite row limit. */
export const PART_BYTES = 1 << 20;

/** What the canvas stores about its latest checkpoint, as JSON in `meta`. */
export interface CheckpointMeta {
  /** Log seq the checkpoint reflects: replay continues at seq + 1. */
  readonly seq: number;
  readonly format: number;
  /** gridHash of the state, checked again after decoding. */
  readonly hash: string;
  /** SHA-256 (hex) of the uncompressed checkpoint, checked before decoding. */
  readonly sha256: string;
  /** Which rows of checkpoint_parts hold it: a new one is written beside the old. */
  readonly gen: number;
  readonly parts: number;
  /** Wall-clock time it was written (ms): checkpoints are taken by time of activity. */
  readonly writtenAt: number;
  /**
   * The state's logical clock (ms), so its R2 copies can say which rollbacks may start from
   * them without being read (ADR 0024). Absent on checkpoints stored before the copies.
   */
  readonly clock?: number;
}

export function createCheckpointTable(sql: SqlStorage): void {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS checkpoint_parts (gen INTEGER NOT NULL, part INTEGER NOT NULL, ' +
      'data BLOB NOT NULL, PRIMARY KEY (gen, part))',
  );
}

export function readCheckpointMeta(sql: SqlStorage): CheckpointMeta | null {
  const row = sql
    .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'checkpoint'")
    .toArray()[0];
  return row ? (JSON.parse(row.value) as CheckpointMeta) : null;
}

/** A checkpoint ready to store: encoded and compressed, with what identifies it. */
export interface PreparedCheckpoint {
  readonly seq: number;
  readonly hash: string;
  readonly sha256: string;
  readonly writtenAt: number;
  readonly clock?: number;
  readonly compressed: Uint8Array;
}

/**
 * Compresses a checkpoint encoded at `seq`. `hash` (and `clock`) are taken in the same
 * synchronous step as the encoding: by the time this resolves the grid may have moved on.
 */
export async function prepareCheckpoint(
  hash: string,
  encoded: Uint8Array,
  seq: number,
  writtenAt: number,
  clock?: number,
): Promise<PreparedCheckpoint> {
  return {
    seq,
    hash,
    writtenAt,
    ...(clock !== undefined ? { clock } : {}),
    sha256: await sha256Hex(encoded),
    compressed: await gzip(encoded),
  };
}

/**
 * Stores a new checkpoint beside the current one, reads it back and decodes it, and only then
 * makes it current and drops the old one. A checkpoint that does not survive the round trip
 * is deleted and the old one stays: the log before the current checkpoint may already be
 * trimmed, so it must never be replaced by one that cannot be restored. `alsoCommit` runs in
 * the transaction that makes it current: what is checkpointed beside the grid (the team
 * ledger, ADR 0020) becomes current at the same seq, or not at all.
 */
export async function storeCheckpoint(
  sql: SqlStorage,
  prepared: PreparedCheckpoint,
  save: (body: () => void) => void,
  partBytes: number = PART_BYTES,
  alsoCommit?: () => void,
): Promise<CheckpointMeta> {
  const current = readCheckpointMeta(sql);
  const { compressed } = prepared;
  const meta: CheckpointMeta = {
    seq: prepared.seq,
    format: CHECKPOINT_FORMAT,
    hash: prepared.hash,
    sha256: prepared.sha256,
    gen: (current?.gen ?? 0) + 1,
    parts: Math.max(1, Math.ceil(compressed.byteLength / partBytes)),
    writtenAt: prepared.writtenAt,
    ...(prepared.clock !== undefined ? { clock: prepared.clock } : {}),
  };
  save(() => {
    // Leftovers of an attempt that never became current.
    sql.exec('DELETE FROM checkpoint_parts WHERE gen <> ?', current?.gen ?? -1);
    for (let part = 0; part < meta.parts; part++) {
      const chunk = compressed.slice(part * partBytes, (part + 1) * partBytes);
      sql.exec(
        'INSERT INTO checkpoint_parts (gen, part, data) VALUES (?, ?, ?)',
        meta.gen,
        part,
        chunk.buffer,
      );
    }
  });
  try {
    // Every check a restore makes except building the counters, which costs about 100 ms at
    // 2048² and cannot fail on a grid that passes the checks.
    const encoded = await readEncoded(sql, meta);
    if (verifyCheckpoint(encoded) !== meta.hash) {
      throw new Error(`checkpoint at seq ${meta.seq}: grid hash mismatch`);
    }
  } catch (error) {
    save(() => sql.exec('DELETE FROM checkpoint_parts WHERE gen = ?', meta.gen));
    throw error;
  }
  save(() => {
    sql.exec(
      "INSERT INTO meta (key, value) VALUES ('checkpoint', ?) " +
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      JSON.stringify(meta),
    );
    sql.exec('DELETE FROM checkpoint_parts WHERE gen <> ?', meta.gen);
    alsoCommit?.();
  });
  return meta;
}

/**
 * The stored checkpoint as a state, or null when there is none. Throws when it does not check
 * out: once the log before it is trimmed there is nothing else to rebuild from, so starting
 * from a damaged checkpoint must never happen quietly.
 */
export async function loadCheckpoint(
  sql: SqlStorage,
): Promise<{ meta: CheckpointMeta; state: State } | null> {
  const meta = readCheckpointMeta(sql);
  if (!meta) return null;
  return { meta, state: await readCheckpoint(sql, meta) };
}

async function readCheckpoint(sql: SqlStorage, meta: CheckpointMeta): Promise<State> {
  const state = decodeCheckpoint(await readEncoded(sql, meta));
  if (gridHash(state) !== meta.hash) {
    throw new Error(`checkpoint at seq ${meta.seq}: grid hash mismatch`);
  }
  return state;
}

/** The stored checkpoint's bytes, reassembled, decompressed and checked against its SHA-256. */
async function readEncoded(sql: SqlStorage, meta: CheckpointMeta): Promise<Uint8Array> {
  const encoded = await gunzip(storedParts(sql, 'checkpoint_parts', meta));
  if ((await sha256Hex(encoded)) !== meta.sha256) {
    throw new Error(`checkpoint at seq ${meta.seq}: checksum mismatch`);
  }
  return encoded;
}

/**
 * The gzip bytes of a stored checkpoint (grid or team: `table` names its parts), reassembled
 * as written. Synchronous, so a caller takes them in the same step as the meta that names them.
 */
export function storedParts(
  sql: SqlStorage,
  table: 'checkpoint_parts' | 'team_checkpoint_parts',
  meta: { readonly seq: number; readonly gen: number; readonly parts: number },
): Uint8Array {
  const parts = sql
    .exec<{ part: number; data: ArrayBuffer }>(
      `SELECT part, data FROM ${table} WHERE gen = ? ORDER BY part`,
      meta.gen,
    )
    .toArray();
  if (parts.length !== meta.parts || parts.some((p, i) => p.part !== i)) {
    throw new Error(
      `${table === 'checkpoint_parts' ? 'checkpoint' : 'team checkpoint'} at seq ${meta.seq}: parts missing`,
    );
  }
  const compressed = new Uint8Array(parts.reduce((n, p) => n + p.data.byteLength, 0));
  let at = 0;
  for (const { data } of parts) {
    compressed.set(new Uint8Array(data), at);
    at += data.byteLength;
  }
  return compressed;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream('gzip'));
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream('gzip'));
}

async function pipe(bytes: Uint8Array, through: CompressionStream | DecompressionStream) {
  const stream = new Blob([bytes]).stream().pipeThrough(through);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
