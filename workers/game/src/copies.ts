import { decodeCheckpoint, gridHash, type State } from '@brickplace/core';
import { gunzip, readCheckpointMeta, sha256Hex, storedParts } from './checkpoints.ts';
import { storedTeamCheckpoint } from './teams.ts';

// Copies of the grid checkpoint in the private OPLOG bucket (ADR 0014's disaster-recovery
// copy, ADR 0024's bound on a rollback's replay). The canvas keeps one checkpoint in SQLite;
// about once an hour of activity it copies that checkpoint, with the team checkpoint stored
// beside it at the same seq, to `c/{canvas}/checkpoints/{seq}.ckpt`. A copy is the stored
// gzip bytes as they are (no re-encoding): the grid's, then the team's, in one object, with
// their lengths and checksums in its metadata. One put is atomic in R2, and a reader checks
// both checksums and the grid hash, so a copy is either whole or refused.
//
// What a copy holds: the grid (cells, shields, layer times, the clock: no player), and the team
// checkpoint (writer ids per cell and per-team counters: integers that name a player only
// through this canvas's own `writers` table). They are deleted when the season is sealed
// (ADR 0021), with the other objects that outlive the season's player ids. Kept out of the
// Worker entry (index.ts).

export const COPY_FORMAT = 1;
/** A copy is taken at most this often (wall clock, ms), and only of a newer checkpoint. */
export const COPY_MS = 60 * 60 * 1000;
/** The newest copies kept, whatever their day: two days of a busy canvas at one an hour. */
export const KEEP_RECENT = 48;
/** Older ones keep the newest copy of each UTC day, for this many days (a season is a week). */
export const KEEP_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Most keys one R2 delete takes. */
export const DELETE_BATCH = 1000;
/**
 * A recovery that replays R2 log segments (index.ts) stores a checkpoint after this many of
 * them, or after RECOVERY_CHECKPOINT_MS of replay, so a start cut short by its time limit
 * resumes from there instead of starting over.
 */
export const RECOVERY_SEGMENTS = 16;
export const RECOVERY_CHECKPOINT_MS = 10_000;

/** What the canvas remembers of its latest copy (meta `checkpoint_copy`). */
export interface CopyRecord {
  readonly seq: number;
  /** Tick time it was written (ms). */
  readonly writtenAt: number;
}

/** A copy as an R2 listing shows it. */
export interface CopyInfo {
  readonly key: string;
  readonly seq: number;
  readonly writtenAt: number;
  /** The state's logical clock; absent for a checkpoint stored before copies existed. */
  readonly clock?: number;
  /** The copy format its metadata names (COPY_FORMAT for one this code can read). */
  readonly format?: string;
}

/** A copy read back and checked: the grid's encoded bytes and the team checkpoint body. */
export interface LoadedCopy {
  readonly seq: number;
  /** The grid checkpoint as encoded, its SHA-256 and grid hash checked. */
  readonly encoded: Uint8Array;
  /** The first state decoded from it (the check of its grid hash). */
  readonly state: State;
  /** The team checkpoint body, checked against its SHA-256; null when the copy has none. */
  readonly team: Uint8Array | null;
}

/** Zero-padded so a listing comes back in log order. */
export function copyKey(prefix: string, seq: number): string {
  return `${copyPrefix(prefix)}${String(seq).padStart(12, '0')}.ckpt`;
}

function copyPrefix(prefix: string): string {
  return `${prefix}/checkpoints/`;
}

export function readCopyRecord(sql: SqlStorage): CopyRecord | null {
  const row = sql
    .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'checkpoint_copy'")
    .toArray()[0];
  return row ? (JSON.parse(row.value) as CopyRecord) : null;
}

/**
 * Copies the stored checkpoint (grid and team, read in one synchronous step so they share a
 * seq) to R2, records it, and deletes the copies retention no longer keeps. The checkpoint was
 * read back and checked when it was stored; R2 checks the upload against its SHA-256.
 */
export async function copyCheckpoint(
  sql: SqlStorage,
  bucket: R2Bucket,
  prefix: string,
  now: number,
  save: (body: () => void) => void,
): Promise<CopyRecord> {
  const meta = readCheckpointMeta(sql);
  if (!meta) throw new Error('no checkpoint to copy');
  const grid = storedParts(sql, 'checkpoint_parts', meta);
  const team = storedTeamCheckpoint(sql, meta.seq);
  const body = new Uint8Array(grid.byteLength + (team?.compressed.byteLength ?? 0));
  body.set(grid, 0);
  if (team) body.set(team.compressed, grid.byteLength);
  await bucket.put(copyKey(prefix, meta.seq), body, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: {
      format: String(COPY_FORMAT),
      seq: String(meta.seq),
      writtenAt: String(now),
      ...(meta.clock !== undefined ? { clock: String(meta.clock) } : {}),
      checkpointFormat: String(meta.format),
      hash: meta.hash,
      gridBytes: String(grid.byteLength),
      gridSha256: meta.sha256,
      teamBytes: String(team?.compressed.byteLength ?? 0),
      ...(team ? { teamSha256: team.sha256 } : {}),
    },
    sha256: await sha256Hex(body),
  });
  const record: CopyRecord = { seq: meta.seq, writtenAt: now };
  save(() =>
    sql.exec(
      "INSERT INTO meta (key, value) VALUES ('checkpoint_copy', ?) " +
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      JSON.stringify(record),
    ),
  );
  // The copy is made either way; a failed cleanup is retried with the next copy.
  try {
    const stale = staleCopies(await listCopies(bucket, prefix));
    // R2 deletes at most 1,000 keys a call.
    for (let i = 0; i < stale.length; i += DELETE_BATCH) {
      await bucket.delete(stale.slice(i, i + DELETE_BATCH));
    }
  } catch (error) {
    console.error('CanvasDO: deleting old checkpoint copies failed', error);
  }
  return record;
}

/** Every copy of the canvas, newest (highest seq) first. */
export async function listCopies(bucket: R2Bucket, prefix: string): Promise<CopyInfo[]> {
  const found: CopyInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: copyPrefix(prefix),
      include: ['customMetadata'],
      cursor,
    });
    for (const object of page.objects) {
      const match = /\/(\d{12})\.ckpt$/.exec(object.key);
      if (!match) continue;
      const meta = object.customMetadata ?? {};
      const clock = Number(meta.clock);
      found.push({
        key: object.key,
        seq: Number(match[1]),
        writtenAt: Number(meta.writtenAt) || 0,
        ...(meta.clock !== undefined && Number.isSafeInteger(clock) ? { clock } : {}),
        ...(meta.format !== undefined ? { format: meta.format } : {}),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return found.sort((a, b) => b.seq - a.seq);
}

/**
 * The keys retention drops: it keeps the KEEP_RECENT newest copies, and of the older ones the
 * newest of each UTC day (by write time) that has none kept yet, back to KEEP_DAYS days before
 * the newest copy's day. At most KEEP_RECENT + KEEP_DAYS copies. `copies` newest first.
 */
export function staleCopies(copies: readonly CopyInfo[]): string[] {
  const dayOf = (copy: CopyInfo) => Math.floor(copy.writtenAt / DAY_MS);
  const newest = copies[0] ? dayOf(copies[0]) : 0;
  const stale: string[] = [];
  const days = new Set<number>();
  copies.forEach((copy, i) => {
    const day = dayOf(copy);
    if (i < KEEP_RECENT || (!days.has(day) && day > newest - KEEP_DAYS)) {
      days.add(day);
      return;
    }
    stale.push(copy.key);
  });
  return stale;
}

/** Deletes every copy (the seal: ADR 0021). Deleting a key already gone is a no-op. */
export async function deleteCopies(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: copyPrefix(prefix), cursor });
    const keys = page.objects.map((o) => o.key);
    if (keys.length > 0) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/**
 * Reads one copy back and checks it: its metadata against its key and length, both parts
 * against their SHA-256, the decoded grid against its hash and map size. Throws on any
 * mismatch, so a damaged or half-written object is never taken for a checkpoint.
 */
export async function loadCopy(
  bucket: R2Bucket,
  copy: CopyInfo,
  size: number,
): Promise<LoadedCopy> {
  const object = await bucket.get(copy.key);
  if (!object) throw new Error(`checkpoint copy ${copy.key} vanished`);
  const meta = object.customMetadata ?? {};
  const body = new Uint8Array(await object.arrayBuffer());
  const gridBytes = Number(meta.gridBytes);
  const teamBytes = Number(meta.teamBytes);
  if (
    meta.format !== String(COPY_FORMAT) ||
    meta.seq !== String(copy.seq) ||
    !Number.isSafeInteger(gridBytes) ||
    !Number.isSafeInteger(teamBytes) ||
    gridBytes < 1 ||
    teamBytes < 0 ||
    body.byteLength !== gridBytes + teamBytes
  ) {
    throw new Error(`checkpoint copy ${copy.key} does not match its metadata`);
  }
  const encoded = await gunzip(body.subarray(0, gridBytes));
  if ((await sha256Hex(encoded)) !== meta.gridSha256) {
    throw new Error(`checkpoint copy ${copy.key}: checksum mismatch`);
  }
  const state = decodeCheckpoint(encoded);
  if (gridHash(state) !== meta.hash) {
    throw new Error(`checkpoint copy ${copy.key}: grid hash mismatch`);
  }
  if (state.config.size !== size) {
    throw new Error(`checkpoint copy ${copy.key}: map size differs`);
  }
  // The listing's clock picks copies for rollbacks: it must be the state's.
  if (copy.clock !== undefined && copy.clock !== state.clock) {
    throw new Error(`checkpoint copy ${copy.key}: clock differs from its metadata`);
  }
  let team: Uint8Array | null = null;
  if (teamBytes > 0) {
    team = await gunzip(body.subarray(gridBytes));
    if ((await sha256Hex(team)) !== meta.teamSha256) {
      throw new Error(`checkpoint copy ${copy.key}: team checksum mismatch`);
    }
  }
  return { seq: copy.seq, encoded, state, team };
}

/**
 * Copies a start's recovery downloads at most (each 1-2 MB, gunzipped, decoded and hashed): many
 * unusable copies must not eat the start's 30 s; past them it replays the R2 log instead.
 */
export const RECOVERY_COPY_ATTEMPTS = 4;

/**
 * The newest copy that passes `usable` (from its listing, before it is read), reads back and
 * passes `accept` (once read), trying older ones when one does not (each refusal logged); null
 * when none does, or after `attempts` downloads. A copy whose listed format is not COPY_FORMAT
 * is passed over without a download: loadCopy would refuse it anyway.
 */
export async function newestCopy(
  bucket: R2Bucket,
  prefix: string,
  size: number,
  usable: (copy: CopyInfo) => boolean,
  accept: (copy: LoadedCopy) => boolean = () => true,
  attempts = Number.POSITIVE_INFINITY,
): Promise<LoadedCopy | null> {
  let tried = 0;
  for (const copy of await listCopies(bucket, prefix)) {
    if (!usable(copy)) continue;
    if (copy.format !== String(COPY_FORMAT)) {
      console.warn(`CanvasDO: checkpoint copy ${copy.key} has format ${copy.format}; skipped`);
      continue;
    }
    if (tried >= attempts) {
      console.error(`CanvasDO: ${tried} checkpoint copies tried; giving up on older ones`);
      return null;
    }
    tried++;
    let loaded: LoadedCopy;
    try {
      loaded = await loadCopy(bucket, copy, size);
    } catch (error) {
      console.error(`CanvasDO: checkpoint copy ${copy.key} unusable; trying an older one`, error);
      continue;
    }
    if (accept(loaded)) return loaded;
    console.warn(`CanvasDO: checkpoint copy ${copy.key} does not fit; trying an older one`);
  }
  return null;
}
