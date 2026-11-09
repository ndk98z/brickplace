import {
  applyEntry,
  type CoreConfig,
  createState,
  gridHash,
  type LogEntry,
  passTime,
  type State,
} from '@brickplace/core';
import { gunzip, gzip, sha256Hex } from './checkpoints.ts';
import {
  cutOverview,
  cutTiles,
  type KeyframeWriter,
  type TileMark,
  writeChangedTiles,
  writeFrameOverview,
} from './keyframes.ts';
import { LOG_FORMAT } from './oplog.ts';
import { type Removal, removed } from './season.ts';
import { parseRestoreWho, parseWho, restoreWhoColumn, type Who } from './teams.ts';

// The sealed season archive (ADR 0021), written once player ids may no longer be kept (ADR
// 0008: 90 days after the end), or earlier on an admin's request:
// - an anonymised copy of the whole op log under `archive/{prefix}/` in the private OPLOG
//   bucket, moderation removals applied, player ids replaced by per-season pseudonyms whose
//   key is thrown away once the archive is sealed; `archive/` is what the owner bucket-locks;
// - `archive/{prefix}/season.json`, written last: its presence means the archive is complete;
// - for raw segments that carry player data (op_log rows carry `who`, [player, team] per op,
//   since ADR 0020), a stripped copy (players pseudonymised, teams kept as in the archive,
//   see ARCHIVE_TEAM_MIN_PLAYERS, nothing removed)
//   under `{prefix}/oplog-stripped/`, after which the raw segments are deleted (ADR 0014's
//   retention);
// - with removals, the keyframes are cut again from the archive's own replay, under a new
//   revision, so the public timelapse never shows what moderators removed.
// The canvas then strips what it keeps itself (ADR 0020's "Stripping player ids"): the hold,
// dedupe and team-credit rows go, writer names become their ids, and any op_log row left gets
// the same pseudonyms (stripCanvas below).
// Kept out of the Worker entry (index.ts), which may export only handlers and DO classes.

export const ARCHIVE_FORMAT = 1;
/**
 * Raw segments read per call of SealJob.step (one maintenance pass, about every 10 s), so one
 * alarm never replays a whole season. Each segment is read twice (verify, then copy), so a busy
 * week of about 10k segments seals in about two hours; a restart in between starts over
 * (progress is not stored, a follow-up).
 */
export const SEAL_SEGMENTS_PER_STEP = 25;
/**
 * A team stays beside the pseudonyms of the archive (and of the stripped copy) only when at
 * least this many distinct players made ops for it that the archive keeps; any other team is
 * written as 0, no team. A pseudonym that played for a team of one or a few would otherwise
 * point back to an account through the team's members in the accounts database (owner
 * decision, 2026-10-25, ADR 0021). The same rule for every team, the owner's included.
 */
export const ARCHIVE_TEAM_MIN_PLAYERS = 10;
/** Columns of an op_log row the archive keeps; any other is dropped. */
const ROW_COLUMNS = new Set(['seq', 'ops', 'at']);
/** Fields of a log entry that identify a player or a connection. */
const ID_FIELDS = ['player', 'client', 'opId'] as const;

const pad = (n: number) => String(n).padStart(12, '0');

export const archiveKeys = {
  segment: (prefix: string, from: number, to: number) =>
    `archive/${prefix}/oplog/${pad(from)}-${pad(to)}.ndjson.gz`,
  season: (prefix: string) => `archive/${prefix}/season.json`,
  stripped: (prefix: string, from: number, to: number) =>
    `${prefix}/oplog-stripped/${pad(from)}-${pad(to)}.ndjson.gz`,
} as const;

/** What season.json says about the archive. */
export interface SeasonArchive {
  readonly format: number;
  readonly prefix: string;
  readonly endsAt: number | null;
  readonly finalSeq: number;
  /** gridHash of the live map at finalSeq. */
  readonly gridHash: string;
  /**
   * gridHash of a replay of the archive itself; equals gridHash when nothing was removed, and
   * when every removal is a rollback (ADR 0024: the live map already left those ops out).
   */
  readonly archiveGridHash: string;
  /** Players named by their pseudonym. */
  readonly removals: readonly Removal[];
  /** Player ops left out by the removals. */
  readonly removedOps: number;
  /**
   * Restore rows (ADR 0024) left out: their rollbacks' removals stand for them. Each is
   * archived as `{seq, at, ops: [], restored: cells}` and, unlike a row whose ops were all
   * removed, takes no time.
   */
  readonly restoresLeftOut: number;
  /** How player ids appear: `pseudonym-v1` (HMAC, key discarded) or `none` in the log. */
  readonly players: 'pseudonym-v1' | 'none';
  /**
   * Teams beside the pseudonyms: those with at least `minPlayers` distinct players among the
   * ops the archive keeps are `kept`; the `dropped` others are written as team 0.
   */
  readonly teams: { readonly minPlayers: number; readonly kept: number; readonly dropped: number };
  readonly segments: readonly { key: string; from: number; to: number; sha256: string }[];
  readonly sealedAt: number;
}

interface RawRow {
  readonly seq: number;
  readonly at: number;
  readonly ops: string;
  readonly [column: string]: unknown;
}

type Entry = Record<string, unknown> & LogEntry;

const keepTeam = (id: number) => id;

/** Every entry without its id fields. */
function stripEntries(entries: readonly Entry[]): LogEntry[] {
  return entries.map((entry) => {
    const copy: Record<string, unknown> = { ...entry };
    for (const field of ID_FIELDS) delete copy[field];
    return copy as unknown as LogEntry;
  });
}

/** True when the row carries anything that can name a player: `who`, or any unknown column. */
function carriesIds(row: RawRow, entries: readonly Entry[]): boolean {
  return (
    Object.entries(row).some(([column, value]) => !ROW_COLUMNS.has(column) && value !== null) ||
    entries.some((entry) => ID_FIELDS.some((field) => field in entry))
  );
}

/**
 * Stable per-season names for players: HMAC-SHA-256 under the seal key, 16 hex digits. The key
 * lives in meta only while sealing, so once it is deleted no one can link a name to an account.
 */
export class Pseudonyms {
  private readonly names = new Map<string, string>();
  private hmac: CryptoKey | null = null;

  constructor(private readonly key: string) {}

  async of(player: string): Promise<string> {
    const known = this.names.get(player);
    if (known) return known;
    this.hmac ??= await crypto.subtle.importKey(
      'raw',
      hexBytes(this.key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        this.hmac,
        new TextEncoder().encode(`bp-archive-v1:${player}`),
      ),
    );
    const name = Array.from(mac.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
    this.names.set(player, name);
    return name;
  }

  /**
   * A `who` list with each player replaced by its name and each team passed through `team`
   * (by default kept as it is; the seal drops small teams, see ARCHIVE_TEAM_MIN_PLAYERS).
   */
  async who(
    whos: readonly (Who | null)[],
    team: (id: number) => number = keepTeam,
  ): Promise<(Who | null)[]> {
    return Promise.all(
      whos.map(async (w) => (w ? ([await this.of(w[0]), team(w[1])] as Who) : null)),
    );
  }

  /**
   * A row's `who` column renamed: per op for rows of ops, per pair for a restore row (ADR
   * 0024). Null when the row has none.
   */
  async column(
    row: { readonly ops: string; readonly who?: unknown },
    team: (id: number) => number = keepTeam,
  ): Promise<string | null> {
    const entries = JSON.parse(row.ops) as LogEntry[];
    const first = entries[0];
    if (first?.kind === 'restore') {
      const restore = parseRestoreWho(row.who, first.cells.length);
      if (!restore) return null;
      const pairs = await Promise.all(
        restore.pairs.map(async ([player, id]) => [await this.of(player), team(id)] as Who),
      );
      return restoreWhoColumn({ pairs, of: restore.of });
    }
    const who = await this.who(parseWho(row.who, entries.length), team);
    return who.some((w) => w !== null) ? JSON.stringify(who) : null;
  }
}

export interface SealInput {
  readonly oplog: R2Bucket;
  /** The public bucket, for rewriting keyframes when removals apply; null to skip. */
  readonly tiles: R2Bucket | null;
  readonly keyframes: KeyframeWriter | null;
  readonly sql: SqlStorage;
  readonly prefix: string;
  /** The rules the log starts from (the stored config's core part). */
  readonly core: CoreConfig;
  readonly endsAt: number | null;
  readonly finalSeq: number;
  /** gridHash of the live map at finalSeq. */
  readonly finalHash: string;
  readonly removals: readonly Removal[];
  /**
   * Every removal comes from a rollback (ADR 0024): the archive's replay must then reach the
   * live final map, since the live map already left those ops out.
   */
  readonly rollbacksOnly?: boolean;
  /** 32 random bytes (hex), kept in meta while sealing so a restart names players the same. */
  readonly pseudonymKey: string;
  readonly save: (body: () => void) => void;
  /** Raw segments per step; SEAL_SEGMENTS_PER_STEP unless a test lowers it. */
  readonly segmentsPerStep?: number;
  /** Told the seq of a row of player ops whose `who` cannot be read (its ops name nobody). */
  readonly unreadableWho?: (seq: number) => void;
}

/**
 * One sealing run, in two passes over the raw segments, a few segments per step:
 * 1. verify, writing nothing: replay every op of the raw log and require the live final map.
 *    A damaged or tampered log stops the seal here, before anything reaches `archive/`, which
 *    is locked: an object written there could never be replaced;
 * 2. copy: replay again with the removals and write the archive, each raw segment checked to
 *    be the very bytes pass 1 verified.
 * The replays live in memory; a canvas that restarts mid-way starts the job again, and every
 * object it already wrote is found with the same checksum and kept.
 */
export class SealJob {
  /** Pass 1's replay of every op; dropped once it has matched the final map. */
  private verifying: State | null;
  /** Raw segments verified so far, and the SHA-256 of each one's bytes. */
  private checked = 0;
  private readonly digests = new Map<string, string>();
  private verified = false;
  /**
   * Pass 1: distinct players per team among the ops the archive keeps, each set stopping at
   * ARCHIVE_TEAM_MIN_PLAYERS (so memory stays a few ids per team). Turned into `keptTeams`
   * once the log is verified, before pass 2 writes any `who`.
   */
  private teamPlayers: Map<number, Set<string>> | null = new Map();
  private keptTeams: ReadonlySet<number> = new Set();
  private droppedTeams = 0;
  /** A team as the archive writes it: itself when kept, else 0 (no team). */
  private readonly teamOf = (id: number): number => (this.keptTeams.has(id) ? id : 0);
  /**
   * Pass 2: the archive's own replay, what the copy, removals left out, rebuilds. Made only
   * once pass 1 has dropped its own (see `replay`): a whole map each, never two at once.
   */
  private state: State | null = null;
  private raw: { key: string; from: number; to: number }[] | null = null;
  private next = 0;
  private removedOps = 0;
  private restoresLeftOut = 0;
  private sawIds = false;
  private readonly segments: { key: string; from: number; to: number; sha256: string }[] = [];
  private readonly strippedRaw: string[] = [];
  private readonly names: Pseudonyms;
  /** Keyframe rewrite: frame seqs to cut, the new tiles per frame, marks so far. */
  private readonly rewrite: {
    revision: number;
    frames: Set<number>;
    tiles: Map<number, number[]>;
    marks: Map<number, TileMark>;
    written: string[];
    /** Frames whose overview was written under the new revision. */
    overviews: Set<number>;
  } | null;

  constructor(private readonly input: SealInput) {
    this.names = new Pseudonyms(input.pseudonymKey);
    const { keyframes, tiles, removals } = input;
    this.verifying = createState(input.core);
    this.rewrite =
      keyframes && tiles && removals.length > 0 && keyframes.frames().length > 0
        ? {
            revision: keyframes.revision + 1,
            frames: new Set(keyframes.frames().map((f) => f.seq)),
            tiles: new Map(),
            marks: new Map(),
            written: [],
            overviews: new Set(),
          }
        : null;
  }

  /**
   * Works through up to SEAL_SEGMENTS_PER_STEP raw segments, verifying first, then copying;
   * true once every segment is copied. Throws, having written nothing to `archive/`, when the
   * raw log does not rebuild the final map.
   */
  async step(): Promise<boolean> {
    this.raw ??= await this.listRaw();
    const raw = this.raw;
    let budget = this.input.segmentsPerStep ?? SEAL_SEGMENTS_PER_STEP;
    while (!this.verified) {
      if (this.checked >= raw.length) {
        // The raw log must rebuild the live map exactly before any archive object is written.
        if (gridHash(this.verifying!) !== this.input.finalHash) {
          throw new Error('the archive replay does not reach the final map; not sealing');
        }
        this.verified = true;
        this.verifying = null;
        const counted = this.teamPlayers!;
        this.keptTeams = new Set(
          [...counted]
            .filter(([, players]) => players.size >= ARCHIVE_TEAM_MIN_PLAYERS)
            .map(([team]) => team),
        );
        this.droppedTeams = counted.size - this.keptTeams.size;
        this.teamPlayers = null;
        break;
      }
      if (budget-- <= 0) return false;
      await this.check(raw[this.checked++]!);
    }
    for (; this.next < raw.length && budget > 0; this.next++, budget--) {
      await this.copy(raw[this.next]!);
    }
    return this.next >= raw.length;
  }

  /** Pass 2's replay, made on first use: pass 1 has finished and dropped its own by then. */
  private replay(): State {
    if (this.verifying) throw new Error('the copy started before the log was verified');
    this.state ??= createState(this.input.core);
    return this.state;
  }

  /**
   * Records the keyframe rewrite, writes season.json, then deletes raw segments that a
   * stripped copy replaced. Returns what season.json says.
   */
  async finish(now: number): Promise<SeasonArchive> {
    const { input } = this;
    const archiveGridHash = gridHash(this.replay());
    // Pass 1 checked the log; without removals (and so without restores) the copy's own
    // replay must agree with it.
    if (
      input.removals.length === 0 &&
      this.restoresLeftOut === 0 &&
      archiveGridHash !== input.finalHash
    ) {
      throw new Error('the archive copy does not reach the final map; not sealing');
    }
    // With rollbacks only it should too (ADR 0024). Said loudly, but the archive is still
    // "the log without the removals", so the seal goes on: player ids must not outlive it.
    if (input.rollbacksOnly && archiveGridHash !== input.finalHash) {
      console.error('CanvasDO: the archive without rolled-back ops differs from the final map');
    }
    const { keyframes } = input;
    if (this.rewrite && keyframes) {
      keyframes.adoptRewrite(
        this.rewrite.revision,
        this.rewrite.tiles,
        this.rewrite.marks,
        this.rewrite.written,
        now,
        input.save,
        this.rewrite.overviews,
      );
      await keyframes.writeIndex(input.save);
    }
    const archive: SeasonArchive = {
      format: ARCHIVE_FORMAT,
      prefix: input.prefix,
      endsAt: input.endsAt,
      finalSeq: input.finalSeq,
      gridHash: input.finalHash,
      archiveGridHash,
      removals: await Promise.all(
        input.removals.map(async (r) =>
          r.player === undefined ? r : { ...r, player: await this.names.of(r.player) },
        ),
      ),
      removedOps: this.removedOps,
      restoresLeftOut: this.restoresLeftOut,
      players: this.sawIds ? 'pseudonym-v1' : 'none',
      teams: {
        minPlayers: ARCHIVE_TEAM_MIN_PLAYERS,
        kept: this.keptTeams.size,
        dropped: this.droppedTeams,
      },
      segments: this.segments,
      sealedAt: now,
    };
    const body = new TextEncoder().encode(JSON.stringify(archive));
    // Written only if absent, which R2 checks itself: a retry after season.json went out keeps
    // the first one (its sealedAt may differ).
    await putIfAbsent(input.oplog, archiveKeys.season(input.prefix), body, {
      httpMetadata: { contentType: 'application/json' },
    });
    if (this.strippedRaw.length > 0) await input.oplog.delete(this.strippedRaw);
    return archive;
  }

  /** The raw segments of the canvas, checked to cover seqs 1..finalSeq without a gap. */
  private async listRaw(): Promise<{ key: string; from: number; to: number }[]> {
    const { oplog, prefix, finalSeq } = this.input;
    const found: { key: string; from: number; to: number }[] = [];
    let cursor: string | undefined;
    do {
      const page = await oplog.list({ prefix: `${prefix}/oplog/`, cursor });
      for (const object of page.objects) {
        const match = /\/(\d{12})-(\d{12})\.ndjson\.gz$/.exec(object.key);
        if (match) found.push({ key: object.key, from: Number(match[1]), to: Number(match[2]) });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    found.sort((a, b) => a.from - b.from);
    let expected = 1;
    for (const segment of found) {
      if (segment.from !== expected) {
        throw new Error(`raw op log has a gap before ${segment.key}`);
      }
      expected = segment.to + 1;
    }
    if (expected - 1 !== finalSeq) {
      throw new Error(`raw op log reaches seq ${expected - 1}, not the final ${finalSeq}`);
    }
    return found;
  }

  /** A raw segment's rows and the SHA-256 of its stored bytes. */
  private async rawRows(segment: {
    key: string;
    from: number;
    to: number;
  }): Promise<{ lines: string[]; digest: string }> {
    const object = await this.input.oplog.get(segment.key);
    if (!object) throw new Error(`raw segment ${segment.key} vanished`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    const text = new TextDecoder().decode(await gunzip(bytes));
    const [headerLine, ...lines] = text.trimEnd().split('\n');
    const header = JSON.parse(headerLine ?? '{}') as {
      format?: number;
      from?: number;
      to?: number;
    };
    if (header.format !== LOG_FORMAT || header.from !== segment.from || header.to !== segment.to) {
      throw new Error(`raw segment ${segment.key} has an unexpected header`);
    }
    return { lines, digest: await sha256Hex(bytes) };
  }

  /**
   * Pass 1: replays every op of a raw segment, writing nothing, and counts each team's players
   * among the ops the removals leave in.
   */
  private async check(segment: { key: string; from: number; to: number }): Promise<void> {
    const { lines, digest } = await this.rawRows(segment);
    this.digests.set(segment.key, digest);
    for (const line of lines) {
      const row = JSON.parse(line) as RawRow;
      const entries = JSON.parse(row.ops) as Entry[];
      for (const op of stripEntries(entries)) {
        applyEntry(this.verifying!, op, row.at);
      }
      // A restore row's pairs are writers of earlier rows, already counted there.
      if (entries[0]?.kind !== 'restore') {
        this.countTeams(row.seq, entries, parseWho(row.who, entries.length));
      }
    }
  }

  private countTeams(seq: number, entries: readonly Entry[], who: readonly (Who | null)[]): void {
    const counted = this.teamPlayers!;
    for (const [i, w] of who.entries()) {
      if (!w || w[1] === 0) continue;
      if (removed(this.input.removals, seq, entries[i]!, w[0])) continue;
      let players = counted.get(w[1]);
      if (!players) {
        players = new Set();
        counted.set(w[1], players);
      }
      if (players.size < ARCHIVE_TEAM_MIN_PLAYERS) players.add(w[0]);
    }
  }

  private async copy(segment: { key: string; from: number; to: number }): Promise<void> {
    const { prefix, removals } = this.input;
    const { lines, digest } = await this.rawRows(segment);
    // The bytes pass 1 verified, not a segment changed since.
    if (this.digests.get(segment.key) !== digest) {
      throw new Error(`raw segment ${segment.key} changed after it was verified; not sealing`);
    }
    const archived: string[] = [];
    const stripped: string[] = [];
    let ids = false;
    for (const line of lines) {
      const row = JSON.parse(line) as RawRow;
      const entries = JSON.parse(row.ops) as Entry[];
      const ops = stripEntries(entries);
      // A restore row's `who` has its own shape, renamed by names.column below.
      const raw =
        entries[0]?.kind === 'restore'
          ? []
          : parseWho(row.who, entries.length, () => this.input.unreadableWho?.(row.seq));
      // [player, team] per op (ADR 0020): players get their pseudonym, teams stay when large
      // enough to hide them (ARCHIVE_TEAM_MIN_PLAYERS), else become 0.
      const who = await this.names.who(raw, this.teamOf);
      const hasWho = who.some((w) => w !== null);
      if (carriesIds(row, entries)) ids = true;
      // The stripped copy keeps the raw row's shape (`who` as a JSON string), only renamed;
      // a restore row's own `who` (ADR 0024) too.
      stripped.push(
        JSON.stringify({
          seq: row.seq,
          ops: JSON.stringify(ops),
          at: row.at,
          who: await this.names.column(row, this.teamOf),
        }),
      );
      const first = entries[0];
      if (first?.kind === 'restore') {
        // Its rollback's removal leaves the same ops out here; the row takes no time.
        this.restoresLeftOut += 1;
        archived.push(
          JSON.stringify({ seq: row.seq, at: row.at, ops: [], restored: first.cells.length }),
        );
        if (this.rewrite?.frames.has(row.seq)) await this.cutFrame(row.seq);
        continue;
      }
      // A row of player ops moved the live clock, whatever the removals leave of it.
      if (first && first.kind !== 'open') passTime(this.replay(), row.at);
      const kept: object[] = [];
      const keptWho: (Who | null)[] = [];
      for (const [i, entry] of entries.entries()) {
        if (removed(removals, row.seq, entry, raw[i]?.[0] ?? null)) {
          this.removedOps += 1;
          continue;
        }
        const op = ops[i]!;
        applyEntry(this.replay(), op, row.at);
        const player = entry.player;
        kept.push(typeof player === 'string' ? { ...op, p: await this.names.of(player) } : op);
        keptWho.push(who[i] ?? null);
      }
      archived.push(
        JSON.stringify({
          seq: row.seq,
          at: row.at,
          ops: kept,
          ...(hasWho ? { who: keptWho } : {}),
        }),
      );
      if (this.rewrite?.frames.has(row.seq)) await this.cutFrame(row.seq);
    }
    if (ids) this.sawIds = true;
    const head = JSON.stringify({
      format: ARCHIVE_FORMAT,
      prefix,
      from: segment.from,
      to: segment.to,
      anonymised: true,
    });
    const key = archiveKeys.segment(prefix, segment.from, segment.to);
    const sha256 = await this.putOnce(key, [head, ...archived]);
    this.segments.push({ key, from: segment.from, to: segment.to, sha256 });
    if (ids) {
      const plainHead = JSON.stringify({ format: LOG_FORMAT, from: segment.from, to: segment.to });
      await this.putOnce(archiveKeys.stripped(prefix, segment.from, segment.to), [
        plainHead,
        ...stripped,
      ]);
      this.strippedRaw.push(segment.key);
    }
  }

  /**
   * Writes an NDJSON object unless one with the same content is there; one with other content
   * stops the seal (never overwritten: the prefix may be locked). Returns the body's SHA-256.
   */
  private async putOnce(key: string, lines: readonly string[]): Promise<string> {
    const { oplog } = this.input;
    const body = new TextEncoder().encode(`${lines.join('\n')}\n`);
    const sha256 = await sha256Hex(body);
    const written = await putIfAbsent(oplog, key, await gzip(body), {
      httpMetadata: { contentType: 'application/gzip' },
      customMetadata: { sha256 },
    });
    if (!written) {
      const existing = await oplog.head(key);
      if (existing?.customMetadata?.sha256 !== sha256) {
        throw new Error(`${key} exists with other content; not sealing`);
      }
    }
    return sha256;
  }

  /** Cuts a keyframe of the archive's replay at `seq`, under the rewrite's revision. */
  private async cutFrame(seq: number): Promise<void> {
    const rewrite = this.rewrite!;
    const { tiles, prefix } = this.input;
    // Not entered as garbage: a seal can run for hours, longer than GARBAGE_GRACE, and the
    // canvas's collection would delete these before the new index names them. A seal that
    // restarts writes the same keys with the same bytes; one abandoned for good leaves them
    // behind (a few tiles per frame, never listed).
    // Both from the replay as it is now, before any await.
    const encoded = cutTiles(this.replay(), seq);
    const overview = cutOverview(this.replay(), seq);
    const result = await writeChangedTiles(
      tiles!,
      prefix,
      rewrite.revision,
      seq,
      encoded,
      rewrite.marks,
      () => {},
    );
    rewrite.tiles.set(seq, result.tiles);
    rewrite.marks = result.marks;
    rewrite.written.push(...result.written);
    rewrite.written.push(
      await writeFrameOverview(tiles!, prefix, rewrite.revision, seq, overview, () => {}),
    );
    rewrite.overviews.add(seq);
  }
}

/**
 * Puts an object only if its key is free, a condition R2 checks itself (If-None-Match: *), so
 * no race or bug here can replace an archive object. True when it was written.
 */
export async function putIfAbsent(
  bucket: R2Bucket,
  key: string,
  body: Uint8Array,
  options: R2PutOptions,
): Promise<boolean> {
  const put = await bucket.put(key, body, {
    ...options,
    onlyIf: new Headers({ 'If-None-Match': '*' }),
  });
  return put !== null;
}

/** True once season.json is in OPLOG: the archive is complete, whatever happened after. */
export async function archiveComplete(oplog: R2Bucket, prefix: string): Promise<boolean> {
  return (await oplog.head(archiveKeys.season(prefix))) !== null;
}

/**
 * Deletes every raw segment that has a stripped copy: what a seal does last, done again when
 * it stopped between season.json and the purge. Deleting a key already gone is a no-op.
 */
export async function deleteStrippedRaw(oplog: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await oplog.list({ prefix: `${prefix}/oplog-stripped/`, cursor });
    const raw = page.objects.map((o) => o.key.replace('/oplog-stripped/', '/oplog/'));
    if (raw.length > 0) await oplog.delete(raw);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** 32 random bytes as hex: a pseudonym key for one sealing, deleted when it is done. */
export function newPseudonymKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return bytes;
}

/**
 * Tables holding player ids in the canvas's SQLite that nothing needs once a season is over,
 * emptied when the archive is sealed (ADR 0008): holds, dedupe keys and the daily team credit
 * (ADR 0020). Later per-player tables add their names here; a table that must keep its rows
 * (like `writers`) is rewritten in purgePlayerData instead.
 */
export const PLAYER_TABLES: readonly string[] = [
  'inventory',
  'accepted_ops',
  'team_credit',
  // The profile's season numbers (ADR 0031).
  'player_season',
  // The journal of the four above (ADR 0042): dedupe keys and their rows by player.
  'state_journal',
];

function tableExists(sql: SqlStorage, table: string): boolean {
  return (
    sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
        table,
      )
      .one().n > 0
  );
}

/**
 * The `who` of every op_log row still in SQLite, with each player renamed (teams kept): rows
 * left when the canvas had no OPLOG to ship them to, or not yet trimmed. Async (the names are
 * HMACs); purgePlayerData writes them.
 */
export async function renamedLogTail(
  sql: SqlStorage,
  names: Pseudonyms,
): Promise<{ seq: number; who: string }[]> {
  if (!tableExists(sql, 'op_log')) return [];
  const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('op_log')");
  if (!columns.toArray().some((c) => c.name === 'who')) return [];
  const rows = sql
    .exec<{ seq: number; ops: string; who: string }>(
      'SELECT seq, ops, who FROM op_log WHERE who IS NOT NULL',
    )
    .toArray();
  const out: { seq: number; who: string }[] = [];
  for (const row of rows) {
    const entries = JSON.parse(row.ops) as LogEntry[];
    // Per op, or per pair for a restore row (ADR 0024).
    const who =
      entries[0]?.kind === 'restore'
        ? ((await names.column(row)) ?? '[]')
        : JSON.stringify(await names.who(parseWho(row.who, entries.length)));
    out.push({ seq: row.seq, who });
  }
  return out;
}

/**
 * Removes every player id the canvas keeps, in the caller's transaction (ADR 0008, ADR 0020's
 * "Stripping player ids"): empties PLAYER_TABLES; renames each writer to its own id (`#id`),
 * which stays unique per (player, team) so the ledger keeps its ids, counts and the per-cell
 * writer ids of its checkpoint, none of which names a player; and writes the renamed `who` of
 * the op_log rows left (renamedLogTail).
 */
export function purgePlayerData(
  sql: SqlStorage,
  tail: readonly { seq: number; who: string }[] = [],
  tables: readonly string[] = PLAYER_TABLES,
): void {
  for (const table of tables) {
    if (tableExists(sql, table)) sql.exec(`DELETE FROM "${table}"`);
  }
  if (tableExists(sql, 'writers')) sql.exec("UPDATE writers SET player = '#' || id");
  for (const { seq, who } of tail) sql.exec('UPDATE op_log SET who = ? WHERE seq = ?', who, seq);
}
