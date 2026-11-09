import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index.ts';
import { Browser, envIn } from './support.ts';

// The dev-only route over the local tiles bucket (ADR 0018) and the tiles URL in /api/me.

const TILES = (env as unknown as { DEV_TILES: R2Bucket }).DEV_TILES;
const BASE = '/api/dev/tiles/c/canvas';
const IMMUTABLE = 'public, max-age=31536000, immutable';

function request(environment: Env['ENVIRONMENT'], path: string, init: RequestInit = {}) {
  const req = new Request(`https://brickplace.test${path}`, init);
  return worker.fetch(req as Parameters<typeof worker.fetch>[0], envIn(environment));
}

beforeAll(async () => {
  await TILES.put('c/canvas/manifest.json', '{"format":1}', {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=1' },
  });
  await TILES.put('c/canvas/tiles/3-4/17.bin.gz', new Uint8Array([1, 2, 3]), {
    httpMetadata: { contentType: 'application/octet-stream', cacheControl: IMMUTABLE },
  });
  await TILES.put('c/canvas/diffs/10-12.bin.gz', new Uint8Array([4, 5]), {
    httpMetadata: { contentType: 'application/octet-stream', cacheControl: IMMUTABLE },
  });
  // Something else in the bucket, which the route must never hand out.
  await TILES.put('c/canvas/private-notes.txt', 'not for the route');
});

describe('dev tiles route', () => {
  it('serves the manifest, tiles and segments with the headers they were stored with', async () => {
    const manifest = await request('dev', `${BASE}/manifest.json`);
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toBe('{"format":1}');
    expect(manifest.headers.get('Cache-Control')).toBe('public, max-age=1');
    expect(manifest.headers.get('Content-Type')).toBe('application/json');

    const tile = await request('dev', `${BASE}/tiles/3-4/17.bin.gz`);
    expect(tile.status).toBe(200);
    expect([...new Uint8Array(await tile.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(tile.headers.get('Cache-Control')).toBe(IMMUTABLE);
    // Gzip bytes as stored, never re-encoded on the way.
    expect(tile.headers.get('Content-Encoding')).toBeNull();
    expect(tile.headers.get('ETag')).toBeTruthy();

    const segment = await request('dev', `${BASE}/diffs/10-12.bin.gz`);
    expect([...new Uint8Array(await segment.arrayBuffer())]).toEqual([4, 5]);
  });

  it('serves the keyframe index and keyframe tiles for the timelapse (ADR 0021)', async () => {
    await TILES.put('c/canvas/keyframes.json', '{"format":1,"frames":[]}');
    await TILES.put('c/canvas/keyframes/0/2-3/40.bin.gz', new Uint8Array([7]));
    expect(await (await request('dev', `${BASE}/keyframes.json`)).text()).toContain('frames');
    const tile = await request('dev', `${BASE}/keyframes/0/2-3/40.bin.gz`);
    expect([...new Uint8Array(await tile.arrayBuffer())]).toEqual([7]);
    expect((await request('dev', `${BASE}/keyframes/0/2-3/`)).status).toBe(404);
  });

  it('serves the map overview and keyframe overviews (ADR 0009)', async () => {
    await TILES.put('c/canvas/overview/12.bin.gz', new Uint8Array([8]));
    await TILES.put('c/canvas/keyframes/0/overview/40.bin.gz', new Uint8Array([9]));
    const overview = await request('dev', `${BASE}/overview/12.bin.gz`);
    expect([...new Uint8Array(await overview.arrayBuffer())]).toEqual([8]);
    const frame = await request('dev', `${BASE}/keyframes/0/overview/40.bin.gz`);
    expect([...new Uint8Array(await frame.arrayBuffer())]).toEqual([9]);
    expect((await request('dev', `${BASE}/overview/`)).status).toBe(404);
  });

  it('answers HEAD without a body', async () => {
    const head = await request('dev', `${BASE}/tiles/3-4/17.bin.gz`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe('3');
    expect(await head.text()).toBe('');
  });

  it('is read only', async () => {
    for (const method of ['PUT', 'POST', 'DELETE']) {
      const response = await request('dev', `${BASE}/tiles/3-4/99.bin.gz`, {
        method,
        body: method === 'DELETE' ? null : 'x',
      });
      expect(response.status).toBe(405);
    }
    expect(await TILES.head('c/canvas/tiles/3-4/99.bin.gz')).toBeNull();
    expect(await TILES.head('c/canvas/tiles/3-4/17.bin.gz')).not.toBeNull();
  });

  it('serves only the keys the client reads, and lists nothing', async () => {
    for (const path of [
      '/api/dev/tiles/',
      `${BASE}/`,
      `${BASE}/tiles/`,
      `${BASE}/tiles/3-4/`,
      `${BASE}/private-notes.txt`,
      `${BASE}/tiles/3-4/17.bin`,
      `${BASE}/tiles/../private-notes.txt`,
      `${BASE}/tiles/3-4/17.bin.gz/`,
      `${BASE}/tiles/3-4/17.bin.gz%00`,
      '/api/dev/tiles/oplog/c/canvas/000000000001-000000000002.ndjson.gz',
    ]) {
      const response = await request('dev', path);
      expect(response.status, path).toBe(404);
    }
  });

  it('answers on any host in dev, where the host check (ADR 0019) does not apply', async () => {
    // Local dev on another host than PUBLIC_ORIGIN, e.g. the Vite proxy or a LAN address.
    const dev = envIn('dev', { PUBLIC_ORIGIN: 'https://brickplace.test' });
    const req = new Request(`http://localhost:8787${BASE}/manifest.json`);
    const response = await worker.fetch(req as Parameters<typeof worker.fetch>[0], dev);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"format":1}');
  });

  it('is refused off the site host outside dev, before any route', async () => {
    const req = new Request(`https://preview.brickplace.workers.dev${BASE}/manifest.json`);
    const response = await worker.fetch(
      req as Parameters<typeof worker.fetch>[0],
      envIn('staging'),
    );
    expect(response.status).toBe(421);
  });

  it('does not exist outside dev', async () => {
    for (const environment of ['staging', 'production'] as const) {
      const response = await request(environment, `${BASE}/manifest.json`);
      expect(response.status).toBe(404);
    }
    // A deploy without --env answers nothing under /api at all.
    expect((await request('locked', `${BASE}/manifest.json`)).status).toBe(501);
  });
});

describe('tiles URL in /api/me', () => {
  it('points dev pages at the dev route', async () => {
    const me = await new Browser(envIn('dev')).me();
    expect(me.config.tilesUrl).toBe(BASE);
  });

  it('points deployed pages at the bucket domain, and nowhere without one', async () => {
    const withOrigin = envIn('staging', { TILES_ORIGIN: 'https://tiles.brickplace.test/' });
    expect((await new Browser(withOrigin).me()).config.tilesUrl).toBe(
      'https://tiles.brickplace.test/c/canvas',
    );
    // No domain configured: the dev route is not offered outside dev.
    expect((await new Browser(envIn('production')).me()).config.tilesUrl).toBeNull();
    // Only https: a plain-http origin is ignored.
    const insecure = envIn('production', { TILES_ORIGIN: 'http://tiles.brickplace.test' });
    expect((await new Browser(insecure).me()).config.tilesUrl).toBeNull();
  });
});
