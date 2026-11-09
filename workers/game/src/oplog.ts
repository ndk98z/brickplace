import { gunzip, gzip, sha256Hex } from './checkpoints.ts';

// Op-log segments in the private OPLOG bucket (ADR 0014): rows are copied to R2 before they are
// trimmed from SQLite, so the whole history stays replayable. Kept out of the Worker entry.

/** Most rows in one segment object, so a long R2 outage does not make one huge object. */
export const MAX_SEGMENT_ROWS = 20_000;
export const LOG_FORMAT = 1;

/** Zero-padded so a listing of the prefix comes back in log order. */
export function logKey(prefix: string, from: number, to: number): string {
  return `${logPrefix(prefix, from)}${String(to).padStart(12, '0')}.ndjson.gz`;
}

function logPrefix(prefix: string, from: number): string {
  return `${prefix}/oplog/${String(from).padStart(12, '0')}-`;
}

export function shippedTo(sql: SqlStorage): number {
  const row = sql
    .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'log_shipped_to'")
    .toArray()[0];
  return row ? Number(row.value) : 0;
}

/**
 * The segment body for log seqs from..to (inclusive): a header line, then every op_log row as
 * stored (all columns, so rows of any kind ship unchanged), one JSON object per line. A pure
 * function of the rows, so a retry produces the same bytes and the same checksum.
 */
export function segmentBody(sql: SqlStorage, from: number, to: number): Uint8Array {
  const rows = sql
    .exec<Record<string, SqlStorageValue>>(
      'SELECT * FROM op_log WHERE seq >= ? AND seq <= ? ORDER BY seq',
      from,
      to,
    )
    .toArray();
  if (rows.length !== to - from + 1 || rows.some((row, i) => row.seq !== from + i)) {
    throw new Error(`op log rows ${from}..${to} are not all present`);
  }
  const lines = [JSON.stringify({ format: LOG_FORMAT, from, to }), ...rows.map(lineOf)];
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

function lineOf(row: Record<string, SqlStorageValue>): string {
  return JSON.stringify(row, (_, value) => {
    if (value instanceof ArrayBuffer) throw new Error('op_log rows must not hold blobs');
    return value;
  });
}

/**
 * Ships every unshipped row up to `upTo` and returns the new shipped-to seq. Each segment is
 * written once under a key naming its range and recorded only after R2 has it. A retry after a
 * crash between the two finds the object by its start, checks it holds exactly these rows,
 * and records it instead of writing an overlapping one: objects are never overwritten.
 */
export async function shipLog(
  sql: SqlStorage,
  bucket: R2Bucket,
  prefix: string,
  upTo: number,
  write: (body: () => void) => void,
): Promise<number> {
  let done = shippedTo(sql);
  while (done < upTo) {
    const from = done + 1;
    const listed = await bucket.list({
      prefix: logPrefix(prefix, from),
      include: ['customMetadata'],
    });
    const existing = listed.objects[0];
    let to: number;
    if (existing) {
      to = Number(existing.customMetadata?.to);
      if (!Number.isInteger(to) || to < from || to > upTo) {
        throw new Error(`log segment ${existing.key} does not fit the log`);
      }
      const sha = await sha256Hex(segmentBody(sql, from, to));
      if (existing.customMetadata?.sha256 !== sha) {
        throw new Error(`log segment ${existing.key} differs from the log; not trimming`);
      }
    } else {
      to = Math.min(upTo, from + MAX_SEGMENT_ROWS - 1);
      const body = segmentBody(sql, from, to);
      const compressed = await gzip(body);
      await bucket.put(logKey(prefix, from, to), compressed, {
        // Gzip bytes as they are (no Content-Encoding), like the public objects.
        httpMetadata: { contentType: 'application/gzip' },
        customMetadata: {
          from: String(from),
          to: String(to),
          sha256: await sha256Hex(body),
        },
        sha256: await sha256Hex(compressed),
      });
    }
    write(() => {
      sql.exec(
        "INSERT INTO meta (key, value) VALUES ('log_shipped_to', ?) " +
          'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        String(to),
      );
    });
    done = to;
  }
  return done;
}

/** One raw log segment in R2: its key and the seqs it holds. */
export interface LogSegment {
  readonly key: string;
  readonly from: number;
  readonly to: number;
}

/** One op_log row as a segment line holds it (every column; these are the ones replay reads). */
export interface LogLine {
  readonly seq: number;
  readonly ops: string;
  readonly at: number;
  readonly who?: unknown;
}

/**
 * The canvas's raw R2 log segments that hold seqs after..upTo, in order, checked to cover them
 * without a gap: from the one holding `after + 1` (seq 1 for `after` 0) to the one holding
 * `upTo`. Segments wholly at or before `after` are left out.
 */
export async function listLogSegments(
  bucket: R2Bucket,
  prefix: string,
  after: number,
  upTo: number,
): Promise<LogSegment[]> {
  const found: LogSegment[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `${prefix}/oplog/`, cursor });
    for (const object of page.objects) {
      const match = /\/(\d{12})-(\d{12})\.ndjson\.gz$/.exec(object.key);
      if (match) found.push({ key: object.key, from: Number(match[1]), to: Number(match[2]) });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  found.sort((a, b) => a.from - b.from);
  let expected = after + 1;
  const needed: LogSegment[] = [];
  for (const segment of found) {
    if (expected > upTo) break;
    if (segment.to < expected) continue;
    if (segment.from > expected) throw new Error(`the R2 log has a gap before ${segment.key}`);
    needed.push(segment);
    expected = segment.to + 1;
  }
  if (expected <= upTo) throw new Error(`the R2 log reaches seq ${expected - 1}, not ${upTo}`);
  return needed;
}

/** The rows of one raw segment, its header checked against its key. */
export async function readLogSegment(bucket: R2Bucket, segment: LogSegment): Promise<LogLine[]> {
  const object = await bucket.get(segment.key);
  if (!object) throw new Error(`R2 log segment ${segment.key} vanished`);
  const text = new TextDecoder().decode(await gunzip(new Uint8Array(await object.arrayBuffer())));
  const [head, ...lines] = text.trimEnd().split('\n');
  const header = JSON.parse(head ?? '{}') as { format?: number; from?: number; to?: number };
  if (header.format !== LOG_FORMAT || header.from !== segment.from || header.to !== segment.to) {
    throw new Error(`R2 log segment ${segment.key} has an unexpected header`);
  }
  return lines.map((line) => JSON.parse(line) as LogLine);
}
