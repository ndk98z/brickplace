import type { Fetcher } from './cdn.ts';

// The browser's reads of the public tiles bucket for CdnFeed (ADR 0018). Kept apart from
// cdn.ts so the feed itself runs anywhere (the game Worker's tests run it against the real
// publisher).

async function gunzip(bytes: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function get(url: string, signal: AbortSignal): Promise<Response> {
  // Anonymous: the bucket is public and must never see the page's cookies.
  const response = await fetch(url, { credentials: 'omit', signal });
  if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
  return response;
}

/** Reads an object's text (the manifest). */
export const fetchText: Fetcher<string> = async (url, signal) => (await get(url, signal)).text();

/**
 * Reads a gzipped object (a tile or a segment): stored as gzip bytes without a
 * Content-Encoding header, so the browser does not decompress it on the way.
 */
export const fetchGzip: Fetcher<Uint8Array> = async (url, signal) =>
  gunzip(await (await get(url, signal)).arrayBuffer());
