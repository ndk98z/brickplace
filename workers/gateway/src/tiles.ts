// Where pages read the map without a socket (ADR 0009, 0018): the public TILES bucket that
// CanvasDO publishes (ADR 0014). Deployed, the bucket has its own domain (TILES_ORIGIN) and no
// Worker stands in front of it. Local dev has no public bucket domain, so the gateway serves
// the local bucket read-only under DEV_TILES_PATH, in dev only.

import type { Context } from './http.ts';
import type { Env } from './index.ts';

/**
 * A canvas's key prefix in the bucket: CanvasDO derives it from its name (`c/{name}`). Each
 * season is a canvas of its own (ADR 0021); names are lower-case letters, digits and `-`, so
 * they need no escaping.
 */
export function canvasPrefix(canvas: string): string {
  return `c/${canvas}`;
}

/** The dev-only route over the local TILES bucket. */
export const DEV_TILES_PATH = '/api/dev/tiles/';

/**
 * The canvas's base URL in the tiles bucket for the client, or null when there is none:
 * TILES_ORIGIN when it is a valid https origin, else in dev the local route (a path on the
 * page's own site). Without one, pages keep a socket to watch, as before.
 */
export function tilesUrl(ctx: Context, canvas: string): string | null {
  const origin = httpsOrigin(ctx.env.TILES_ORIGIN);
  if (origin) return `${origin}/${canvasPrefix(canvas)}`;
  return ctx.dev && ctx.env.DEV_TILES ? `${DEV_TILES_PATH}${canvasPrefix(canvas)}` : null;
}

function httpsOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The only keys the client reads, as cdnKeys in @brickplace/protocol/cdn writes them: the
 * manifest, a tile version, a diff segment, an overview, the keyframe index, a keyframe tile
 * (ADR 0021) and a keyframe overview. Nothing else in the bucket is served, and nothing is
 * listed.
 */
const READABLE =
  /^c\/[A-Za-z0-9%._-]+\/(manifest\.json|tiles\/\d+-\d+\/\d+\.bin\.gz|diffs\/\d+-\d+\.bin\.gz|overview\/\d+\.bin\.gz|keyframes\.json|keyframes\/\d+\/\d+-\d+\/\d+\.bin\.gz|keyframes\/\d+\/overview\/\d+\.bin\.gz)$/;

/**
 * GET or HEAD of one object of the local TILES bucket, with the headers it was stored with
 * (the same Cache-Control the CDN would send). Dev only: anywhere else it does not exist.
 */
export async function devTiles(ctx: Context, env: Env, path: string): Promise<Response> {
  const bucket = env.DEV_TILES;
  if (!ctx.dev || !bucket) return notFound();
  const method = ctx.request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('read only', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const key = path.slice(DEV_TILES_PATH.length);
  if (!READABLE.test(key) || key.split('/').includes('..')) return notFound();
  const head = method === 'HEAD';
  const object = head ? await bucket.head(key) : await bucket.get(key);
  if (!object) return notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Content-Length', String(object.size));
  const body = head ? null : (object as R2ObjectBody).body;
  return new Response(body, { headers });
}

function notFound(): Response {
  return new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
