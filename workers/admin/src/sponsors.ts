import { acting, type Ctx, type Route, withReason } from './acting.ts';
import { audit } from './audit.ts';
import { json, readBody, text } from './http.ts';
import type { Role } from './identity.ts';
import { STAGE0_CANVAS } from './ports.ts';

// Sponsors and site links (ADR 0038): rows in the accounts database that the gateway serves at
// GET /api/sponsors, and logos in the private SPONSOR_LOGOS bucket that it serves under
// /api/sponsor-logos/. Owners change them; anyone with a role reads them. Each sponsor belongs
// to one season's canvas and shows inside a window within that season's times; one per canvas
// may be featured. Each change is one D1 batch, with audit rows before and after it
// (`acting`). The page part is ui/sponsors.ts.

/** At most this many sponsors per canvas: the screen shows 5 at a time (ADR 0006). */
export const MAX_PER_CANVAS = 50;
export const MAX_NAME = 40;
export const MAX_URL = 500;
/** Logo limits (ADR 0038). */
export const MAX_LOGO_BYTES = 256 * 1024;
export const LOGO_MIN_SIDE = 64;
export const LOGO_MAX_SIDE = 2048;
/** `logos/<sha256>.<png|webp>`, the only keys this Worker writes or reads. */
export const LOGO_KEY = /^logos\/[0-9a-f]{64}\.(png|webp)$/;
export const LINK_KEYS = { sponsorInfo: 'sponsor_info', kofi: 'kofi' } as const;

const LOGO_TYPES = { png: 'image/png', webp: 'image/webp' } as const;
type LogoKind = keyof typeof LOGO_TYPES;

export interface SponsorRow {
  readonly id: number;
  readonly canvas: string;
  readonly name: string;
  readonly href: string;
  readonly logo: string | null;
  readonly showsFrom: number;
  readonly showsUntil: number;
  readonly featured: boolean;
  readonly hidden: boolean;
  readonly position: number;
  readonly updatedAt: number;
}

type Row = {
  id: number;
  canvas: string;
  name: string;
  href: string;
  logo: string | null;
  shows_from: number;
  shows_until: number;
  featured: number;
  hidden: number;
  position: number;
  updated_at: number;
};

function toView(r: Row): SponsorRow {
  return {
    id: r.id,
    canvas: r.canvas,
    name: r.name,
    href: r.href,
    logo: r.logo,
    showsFrom: r.shows_from,
    showsUntil: r.shows_until,
    featured: r.featured === 1,
    hidden: r.hidden === 1,
    position: r.position,
    updatedAt: r.updated_at,
  };
}

export function sponsorRoutes(read: readonly Role[], write: readonly Role[]): Route[] {
  return [
    { method: 'GET', path: /^\/api\/sponsors$/, roles: read, handler: list },
    { method: 'POST', path: /^\/api\/sponsors$/, roles: write, handler: save },
    { method: 'POST', path: /^\/api\/sponsors\/logo$/, roles: write, handler: uploadLogo },
    {
      method: 'GET',
      path: /^\/api\/sponsors\/(logos\/[0-9a-f]{64}\.(?:png|webp))$/,
      roles: read,
      handler: serveLogo,
    },
    {
      method: 'POST',
      path: /^\/api\/sponsors\/(\d{1,15})\/delete$/,
      roles: write,
      handler: remove,
    },
    { method: 'POST', path: /^\/api\/sponsors\/(\d{1,15})\/move$/, roles: write, handler: move },
    { method: 'POST', path: /^\/api\/site-links$/, roles: write, handler: setLinks },
  ];
}

// ---- Reads ------------------------------------------------------------------------------------

async function all(db: D1Database): Promise<SponsorRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM sponsors ORDER BY canvas, position, id')
    .all<Row>();
  return results.map(toView);
}

async function links(db: D1Database): Promise<{ sponsorInfo: string | null; kofi: string | null }> {
  const { results } = await db.prepare('SELECT key, url FROM site_links').all<{
    key: string;
    url: string;
  }>();
  const of = (key: string) => results.find((r) => r.key === key)?.url ?? null;
  return { sponsorInfo: of(LINK_KEYS.sponsorInfo), kofi: of(LINK_KEYS.kofi) };
}

/** GET /api/sponsors: every sponsor of every canvas, and the site links. */
async function list(ctx: Ctx): Promise<Response> {
  const [sponsors, siteLinks] = await Promise.all([all(ctx.env.ACCOUNTS), links(ctx.env.ACCOUNTS)]);
  return json({ sponsors, links: siteLinks, logoRules: logoRules() });
}

function logoRules() {
  return {
    types: Object.values(LOGO_TYPES),
    maxBytes: MAX_LOGO_BYTES,
    minSide: LOGO_MIN_SIDE,
    maxSide: LOGO_MAX_SIDE,
  };
}

// ---- Checks -----------------------------------------------------------------------------------

/** An https URL of at most MAX_URL characters, with no user name or password; else null. */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

/** The times a sponsor of `canvas` may show in: its season's, or any for Stage 0. */
async function seasonWindow(
  db: D1Database,
  canvas: string,
): Promise<{ startsAt: number; endsAt: number } | null | 'none'> {
  if (canvas === STAGE0_CANVAS) return 'none';
  const row = await db
    .prepare('SELECT starts_at, ends_at FROM seasons WHERE canvas = ?')
    .bind(canvas)
    .first<{ starts_at: number; ends_at: number }>();
  return row ? { startsAt: row.starts_at, endsAt: row.ends_at } : null;
}

const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

interface Input {
  readonly canvas: string;
  readonly name: string;
  readonly href: string;
  readonly logo: string | null;
  readonly showsFrom: number;
  readonly showsUntil: number;
  readonly featured: boolean;
  readonly hidden: boolean;
}

/** The body as a sponsor, or what is wrong with it. */
export function parseSponsor(body: Record<string, unknown>): Input | string {
  const { canvas, showsFrom, showsUntil, featured, hidden } = body;
  if (typeof canvas !== 'string' || canvas.length < 1 || canvas.length > 32) return 'canvas';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > MAX_NAME) return 'name: 1 to 40 characters';
  const href = httpsUrl(body.href);
  if (!href) return 'href: an https link';
  const logo = body.logo ?? null;
  if (logo !== null && (typeof logo !== 'string' || !LOGO_KEY.test(logo))) return 'logo';
  if (!isTime(showsFrom) || !isTime(showsUntil) || showsUntil <= showsFrom) {
    return 'showsFrom must come before showsUntil (ms)';
  }
  if (typeof featured !== 'boolean' || typeof hidden !== 'boolean') {
    return 'featured and hidden: true or false';
  }
  return { canvas, name, href, logo, showsFrom, showsUntil, featured, hidden };
}

// ---- Changes ----------------------------------------------------------------------------------

/**
 * POST /api/sponsors {id?, canvas, name, href, logo, showsFrom, showsUntil, featured, hidden,
 * reason}: adds a sponsor (no id) or replaces one. A featured one unfeatures the others of its
 * canvas in the same batch.
 */
async function save(ctx: Ctx): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const input = parseSponsor(body);
  if (typeof input === 'string') return json({ error: 'invalid', detail: input }, 400);
  const id = body.id ?? null;
  if (id !== null && !(Number.isSafeInteger(id) && (id as number) > 0)) {
    return json({ error: 'invalid', detail: 'id' }, 400);
  }
  const db = ctx.env.ACCOUNTS;
  const window = await seasonWindow(db, input.canvas);
  if (window === null)
    return json({ error: 'not_found', detail: 'no season has that canvas' }, 404);
  if (
    window !== 'none' &&
    (input.showsFrom < window.startsAt || input.showsUntil > window.endsAt)
  ) {
    return json({ error: 'invalid', detail: 'the dates must fall inside the season' }, 400);
  }
  if (input.logo !== null && !(await ctx.env.SPONSOR_LOGOS.head(input.logo))) {
    return json({ error: 'invalid', detail: 'logo not uploaded' }, 400);
  }
  const before = id === null ? null : await one(db, id as number);
  if (id !== null && !before) return json({ error: 'not_found' }, 404);
  // A new sponsor, or one moved to another canvas, counts against that canvas's limit.
  if (!before || before.canvas !== input.canvas) {
    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM sponsors WHERE canvas = ?')
      .bind(input.canvas)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_PER_CANVAS) {
      return json({ error: 'too_many', detail: `at most ${MAX_PER_CANVAS} per season` }, 409);
    }
  }
  // A new sponsor, or one moved to another canvas, goes last there.
  const position =
    before && before.canvas === input.canvas
      ? before.position
      : ((
          await db
            .prepare('SELECT MAX(position) AS p FROM sponsors WHERE canvas = ?')
            .bind(input.canvas)
            .first<{ p: number | null }>()
        )?.p ?? 0) + 1;
  const statements: D1PreparedStatement[] = [];
  if (input.featured) {
    statements.push(
      db
        .prepare(
          'UPDATE sponsors SET featured = 0, updated_at = ? WHERE canvas = ? AND featured = 1',
        )
        .bind(ctx.now, input.canvas),
    );
  }
  const values = [
    input.canvas,
    input.name,
    input.href,
    input.logo,
    input.showsFrom,
    input.showsUntil,
    input.featured ? 1 : 0,
    input.hidden ? 1 : 0,
    position,
  ];
  statements.push(
    before
      ? db
          .prepare(
            'UPDATE sponsors SET canvas = ?, name = ?, href = ?, logo = ?, shows_from = ?, ' +
              'shows_until = ?, featured = ?, hidden = ?, position = ?, updated_at = ? WHERE id = ? ' +
              'RETURNING id',
          )
          .bind(...values, ctx.now, before.id)
      : db
          .prepare(
            'INSERT INTO sponsors (canvas, name, href, logo, shows_from, shows_until, featured, ' +
              'hidden, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
              'RETURNING id',
          )
          .bind(...values, ctx.now, ctx.now),
  );
  const results = await batch<{ id: number }>(ctx, statements, {
    action: before ? 'sponsor.update' : 'sponsor.create',
    target: `${input.canvas}/${before ? before.id : 'new'}`,
    before: before ?? undefined,
    after: { ...input, position },
    reason,
  });
  const saved = results[input.featured ? 1 : 0]?.results[0]?.id ?? before?.id ?? null;
  return json({ sponsor: saved === null ? null : await one(db, saved) });
}

/**
 * Runs a change to the accounts database with the audit rows `acting` writes around it (the
 * audit log lives in another database, so they cannot share a batch).
 */
function batch<T = unknown>(
  ctx: Ctx,
  statements: D1PreparedStatement[],
  entry: { action: string; target: string; reason: string; before?: unknown; after?: unknown },
): Promise<D1Result<T>[]> {
  return acting(
    ctx,
    entry,
    () => ctx.env.ACCOUNTS.batch<T>(statements),
    () => ({ outcome: 'ok', after: entry.after }),
  );
}

async function one(db: D1Database, id: number): Promise<SponsorRow | null> {
  const row = await db.prepare('SELECT * FROM sponsors WHERE id = ?').bind(id).first<Row>();
  return row ? toView(row) : null;
}

/** POST /api/sponsors/:id/delete {reason}. The logo stays in the bucket (ADR 0038). */
async function remove(ctx: Ctx, match: RegExpExecArray): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const db = ctx.env.ACCOUNTS;
  const before = await one(db, Number(match[1]));
  if (!before) return json({ error: 'not_found' }, 404);
  await batch(ctx, [db.prepare('DELETE FROM sponsors WHERE id = ?').bind(before.id)], {
    action: 'sponsor.delete',
    target: `${before.canvas}/${before.id}`,
    before,
    reason: parsed.reason,
  });
  return json({ deleted: before.id });
}

/**
 * POST /api/sponsors/:id/move {by: -1 | 1, reason?}: swaps a sponsor with the one before or
 * after it on its canvas. The reason may be empty: an order change shows only in the order.
 */
async function move(ctx: Ctx, match: RegExpExecArray): Promise<Response> {
  const body = await readBody(ctx.request);
  const reason = body ? text(body.reason) : null;
  if (!body || reason === null || (body.by !== -1 && body.by !== 1)) {
    return json({ error: 'invalid', detail: 'by: -1 or 1' }, 400);
  }
  const db = ctx.env.ACCOUNTS;
  const self = await one(db, Number(match[1]));
  if (!self) return json({ error: 'not_found' }, 404);
  const other = await db
    .prepare(
      body.by < 0
        ? 'SELECT * FROM sponsors WHERE canvas = ? AND (position < ? OR (position = ? AND id < ?)) ' +
            'ORDER BY position DESC, id DESC LIMIT 1'
        : 'SELECT * FROM sponsors WHERE canvas = ? AND (position > ? OR (position = ? AND id > ?)) ' +
            'ORDER BY position, id LIMIT 1',
    )
    .bind(self.canvas, self.position, self.position, self.id)
    .first<Row>();
  if (!other) return json({ moved: false });
  // Equal positions (never written by this module, but cheap to survive) still swap.
  const [a, b] =
    other.position === self.position
      ? body.by < 0
        ? [self.position - 1, self.position]
        : [self.position + 1, self.position]
      : [other.position, self.position];
  await batch(
    ctx,
    [
      db
        .prepare('UPDATE sponsors SET position = ?, updated_at = ? WHERE id = ?')
        .bind(a, ctx.now, self.id),
      db
        .prepare('UPDATE sponsors SET position = ?, updated_at = ? WHERE id = ?')
        .bind(b, ctx.now, other.id),
    ],
    {
      action: 'sponsor.move',
      target: `${self.canvas}/${self.id}`,
      before: { position: self.position },
      after: { position: a, swappedWith: other.id },
      reason,
    },
  );
  return json({ moved: true });
}

/** POST /api/site-links {sponsorInfo, kofi, reason}: an https URL each, or null to clear it. */
async function setLinks(ctx: Ctx): Promise<Response> {
  const parsed = await withReason(ctx);
  if (parsed instanceof Response) return parsed;
  const { body, reason } = parsed;
  const db = ctx.env.ACCOUNTS;
  const before = await links(db);
  const statements: D1PreparedStatement[] = [];
  const after: Record<string, string | null> = {};
  for (const [field, key] of Object.entries(LINK_KEYS)) {
    const value = body[field];
    if (value === undefined) continue;
    if (value === null || value === '') {
      statements.push(db.prepare('DELETE FROM site_links WHERE key = ?').bind(key));
      after[field] = null;
      continue;
    }
    const url = httpsUrl(value);
    if (!url) return json({ error: 'invalid', detail: `${field}: an https link or null` }, 400);
    statements.push(
      db
        .prepare(
          'INSERT INTO site_links (key, url, updated_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT (key) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at',
        )
        .bind(key, url, ctx.now),
    );
    after[field] = url;
  }
  if (statements.length === 0) return json({ error: 'invalid', detail: 'nothing to set' }, 400);
  await batch(ctx, statements, { action: 'links.set', target: 'site', before, after, reason });
  return json({ links: await links(db) });
}

// ---- Logos ------------------------------------------------------------------------------------

/**
 * The kind and size of a PNG or WebP from its first bytes, or null for anything else. Reads
 * the PNG IHDR and the WebP VP8, VP8L or VP8X header; trusts nothing the browser said.
 */
export function logoInfo(bytes: Uint8Array): { kind: LogoKind; w: number; h: number } | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  const be32 = (at: number) =>
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
  const le24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
  if (bytes.length >= 24) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((b, i) => bytes[i] === b) && ascii(12, 16) === 'IHDR') {
      return { kind: 'png', w: be32(16), h: be32(20) };
    }
  }
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const chunk = ascii(12, 16);
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return {
        kind: 'webp',
        w: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
        h: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
      };
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const [b0, b1, b2, b3] = [bytes[21]!, bytes[22]!, bytes[23]!, bytes[24]!];
      return {
        kind: 'webp',
        w: 1 + (b0 | ((b1 & 0x3f) << 8)),
        h: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
      };
    }
    if (chunk === 'VP8X') return { kind: 'webp', w: 1 + le24(24), h: 1 + le24(27) };
  }
  return null;
}

/** Why a logo is refused, or null when it may be stored. */
export function logoProblem(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return 'empty file';
  if (bytes.length > MAX_LOGO_BYTES) return `larger than ${MAX_LOGO_BYTES / 1024} KB`;
  const info = logoInfo(bytes);
  if (!info) return 'not a PNG or WebP';
  const { w, h } = info;
  if (Math.min(w, h) < LOGO_MIN_SIDE || Math.max(w, h) > LOGO_MAX_SIDE) {
    return `each side must be ${LOGO_MIN_SIDE} to ${LOGO_MAX_SIDE} px (this one is ${w} × ${h})`;
  }
  if (animated(bytes, info.kind)) return 'an animated image: upload a still logo';
  return null;
}

/**
 * True for an animated logo: a WebP whose VP8X header sets the animation flag, or a PNG with
 * an `acTL` chunk (APNG) before its image data.
 */
export function animated(bytes: Uint8Array, kind: LogoKind): boolean {
  const ascii = (from: number) => String.fromCharCode(...bytes.subarray(from, from + 4));
  if (kind === 'webp') return ascii(12) === 'VP8X' && (bytes[20]! & 0x02) !== 0;
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length =
      ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
    const type = ascii(at + 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    at += 12 + length;
  }
  return false;
}

/** The request body as JSON, up to `max` characters; null when larger or not an object. */
async function readLargeBody(
  request: Request,
  max: number,
): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > max || !request.body) return null;
  // Counted as it streams, so a chunked body with no length is cut off at `max` too.
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  const raw = new TextDecoder().decode(bytes);
  try {
    const value = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function fromBase64(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * POST /api/sponsors/logo {data: base64}: checks the file and stores it under its SHA-256.
 * The same file uploaded twice is one object. Answers the key to save with a sponsor.
 */
async function uploadLogo(ctx: Ctx): Promise<Response> {
  // Base64 grows a file by a third; leave room for the JSON around it.
  const body = await readLargeBody(ctx.request, Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 1024);
  if (!body || typeof body.data !== 'string') {
    return json(
      { error: 'invalid', detail: `a PNG or WebP of at most ${MAX_LOGO_BYTES / 1024} KB` },
      400,
    );
  }
  const bytes = fromBase64(body.data);
  if (!bytes) return json({ error: 'invalid', detail: 'data: base64' }, 400);
  const problem = logoProblem(bytes);
  if (problem) return json({ error: 'invalid', detail: problem }, 400);
  const info = logoInfo(bytes)!;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = `logos/${hash}.${info.kind}`;
  if (!(await ctx.env.SPONSOR_LOGOS.head(key))) {
    await ctx.env.SPONSOR_LOGOS.put(key, bytes, {
      httpMetadata: { contentType: LOGO_TYPES[info.kind] },
    });
  }
  await audit(ctx.env.ADMIN_DB, ctx.admin, ctx.now, {
    action: 'sponsor.logo_upload',
    target: key,
    after: { bytes: bytes.length, width: info.w, height: info.h },
  });
  return json({ logo: key, width: info.w, height: info.h, bytes: bytes.length });
}

/** GET /api/sponsors/logos/<hash>.<ext>: a stored logo, for the admin page's previews. */
async function serveLogo(ctx: Ctx, match: RegExpExecArray): Promise<Response> {
  const key = match[1]!;
  const object = await ctx.env.SPONSOR_LOGOS.get(key);
  if (!object) return json({ error: 'not_found' }, 404);
  const kind = key.endsWith('.png') ? 'png' : 'webp';
  return new Response(object.body, {
    headers: {
      'Content-Type': LOGO_TYPES[kind],
      'Cache-Control': 'private, max-age=86400, immutable',
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
