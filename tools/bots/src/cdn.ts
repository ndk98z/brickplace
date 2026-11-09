import { cdnKeys, parseManifest } from '@brickplace/protocol/cdn';

// A page about to play loads the whole map from the CDN first (3 s at most), then opens its
// socket with `since` the manifest's seq, so FanoutDO answers with the changes since then
// instead of the whole map (ADR 0009, 0040). Bots do the same before their first socket. Each
// bot reads the manifest, as each page does; the tiles and segments it lists never change
// under their keys, so a run fetches each of them once and every bot waits for the same fetch
// (the CDN would serve a page from cache; an r2.dev address has no cache and a rate limit).
// The bots keep no copy of what they load: their map comes from the Eye.

/** Reads a URL's body; throws on a status other than 2xx. */
export type FetchBody = (url: string, signal: AbortSignal) => Promise<Uint8Array>;

const fetchBody: FetchBody = async (url, signal) => {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

/** How long a page waits for the map from the CDN before it asks the socket for it (ms). */
export const CDN_WAIT_MS = 3000;

export interface CdnStats {
  /** Manifests read, one per bot that loaded the map. */
  manifests: number;
  /** Tiles and segments fetched: each once per run. */
  objects: number;
  /** Bytes of both, as they came over the wire. */
  bytes: number;
  /** Bots that loaded the whole map and resumed from its seq. */
  loaded: number;
  /** Bots that gave up (an error, or past CDN_WAIT_MS) and asked the socket for the map. */
  fallbacks: number;
  /** Why, by message. */
  errors: Record<string, number>;
}

export function cdnStats(): CdnStats {
  return { manifests: 0, objects: 0, bytes: 0, loaded: 0, fallbacks: 0, errors: {} };
}

export class Cdn {
  /** Tiles and segments by URL: fetched once, shared by every bot. */
  private readonly objects = new Map<string, Promise<void>>();

  constructor(
    /** The canvas's base URL, as /api/me's `tilesUrl` names it (absolute). */
    private readonly base: string,
    readonly stats: CdnStats = cdnStats(),
    private readonly fetch: FetchBody = fetchBody,
    private readonly waitMs = CDN_WAIT_MS,
  ) {}

  /**
   * The seq a page holds once it has loaded the map from the CDN, to resume its socket from;
   * null when it could not within the wait (the socket then brings the whole map). Never
   * rejects.
   */
  async heldSeq(): Promise<number | null> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('timeout')), this.waitMs);
    try {
      return await this.load(abort.signal);
    } catch (error) {
      this.stats.fallbacks++;
      const reason = abort.signal.aborted ? 'timeout' : (error as Error).message;
      this.stats.errors[reason] = (this.stats.errors[reason] ?? 0) + 1;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async load(signal: AbortSignal): Promise<number> {
    const text = new TextDecoder().decode(await this.fetch(cdnKeys.manifest(this.base), signal));
    this.stats.manifests++;
    const manifest = parseManifest(text);
    const across = Math.ceil(manifest.size / manifest.tileSize);
    // Every tile at its listed version (0: never written, so empty and not fetched), then every
    // segment past the oldest of them: what a page applies to reach the manifest's seq.
    const urls: string[] = [];
    let oldest = Number.POSITIVE_INFINITY;
    manifest.tiles.forEach((version, i) => {
      oldest = Math.min(oldest, version);
      if (version > 0) {
        urls.push(cdnKeys.tile(this.base, i % across, Math.floor(i / across), version));
      }
    });
    for (const [from, to] of manifest.segments) {
      if (to > oldest) urls.push(cdnKeys.segment(this.base, from, to));
    }
    await Promise.all(urls.map((url) => this.object(url, signal)));
    this.stats.loaded++;
    return manifest.seq;
  }

  /** One immutable object, fetched by the first bot that wants it; a failed fetch is retried. */
  private object(url: string, signal: AbortSignal): Promise<void> {
    let pending = this.objects.get(url);
    if (!pending) {
      // Not tied to one bot's wait: a bot that gives up must not cancel the others' fetch.
      pending = this.fetch(url, new AbortController().signal).then((body) => {
        this.stats.objects++;
        this.stats.bytes += body.length;
      });
      this.objects.set(url, pending);
      pending.catch(() => this.objects.delete(url));
    }
    return Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
  }
}

/**
 * The canvas's CDN base from an /api/me answer, made absolute against the gateway (in dev it
 * is a path on the gateway's own site); null when the answer names none.
 */
export function tilesOf(me: unknown, meUrl: string): string | null {
  const config = (me as { config?: unknown } | null)?.config as { tilesUrl?: unknown } | undefined;
  const value = config?.tilesUrl;
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, meUrl);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString().replace(/\/$/, '')
      : null;
  } catch {
    return null;
  }
}
