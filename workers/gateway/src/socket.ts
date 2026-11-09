// Who a game socket plays as (ADR 0015, 0017). Only the gateway decides: the headers it
// sets replace anything the client sent.

import { type Context, foreignOrigin } from './http.ts';
import { current, readSession, SESSION_TTL_MS } from './session.ts';
import { randomToken } from './token.ts';

/**
 * The same names as in @brickplace/realtime/player, repeated so the gateway does not bundle
 * FanoutDO; the gateway tests check they agree.
 */
export const PLAYER_HEADER = 'X-BrickPlace-Player';
export const CLIENT_HEADER = 'X-BrickPlace-Client';
export const WATCH_HEADER = 'X-BrickPlace-Watch';
export const UNTIL_HEADER = 'X-BrickPlace-Until';
export const TEAM_HEADER = 'X-BrickPlace-Team';
/** The season's canvas the socket plays on (ADR 0021). */
export const CANVAS_HEADER = 'X-BrickPlace-Canvas';
/** The key FanoutDO counts socket opens under per address (ADR 0026). */
export const ADDRESS_HEADER = 'X-BrickPlace-Address';
/** The key FanoutDO counts socket opens under per IPv6 network, a /48 (ADR 0026). */
export const NETWORK_HEADER = 'X-BrickPlace-Network';
/** The trust score in the session token (ADR 0026). */
export const TRUST_HEADER = 'X-BrickPlace-Trust';
/** The shard's share of the players-at-once cap (ADR 0039); absent: no cap. */
export const CAP_HEADER = 'X-BrickPlace-Cap';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The eight groups of an IPv6 address, normalised (lower case, no leading zeros), or null. */
function ipv6Groups(ip: string): string[] | null {
  if (!/^[0-9a-fA-F:]+$/.test(ip) || !ip.includes(':')) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right];
  if (groups.some((g) => g.length === 0 || g.length > 4)) return null;
  return groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''));
}

/**
 * The key an address is limited by (ADR 0026): an IPv4 address as is, an IPv6 address by its
 * /64 (one subscriber's prefix; the rest of the address changes freely). Null for anything
 * else. FanoutDO keeps it in memory only and never logs or stores it.
 */
export function addressKey(ip: string | null): string | null {
  if (!ip || ip.length > 64) return null;
  if (IPV4.test(ip)) return ip;
  const groups = ipv6Groups(ip);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : null;
}

/**
 * The wider key an IPv6 address is also limited by (ADR 0026): its /48, since one subscriber
 * is often given a /48 and could open sockets from a new /64 each time. Null for IPv4 and
 * anything else. Memory only, like addressKey.
 */
export function networkKey(ip: string | null): string | null {
  if (!ip || ip.length > 64 || IPV4.test(ip)) return null;
  const groups = ipv6Groups(ip);
  return groups ? `${groups.slice(0, 3).join(':')}::/48` : null;
}

/** The FanoutDO name of a canvas's shard, as @brickplace/realtime/player's fanoutName says. */
export function fanoutName(canvas: string, shard = 0): string {
  return canvas === 'canvas' ? `fanout-${shard}` : `${canvas}:fanout-${shard}`;
}

/** As @brickplace/realtime/player's MAX_FANOUT_SHARDS. */
export const MAX_FANOUT_SHARDS = 64;

/** As @brickplace/realtime/player's shardCount: the FANOUT_SHARDS var, 1 to 64, default 1. */
export function shardCount(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_FANOUT_SHARDS ? n : 1;
}

/** As @brickplace/realtime/player's shardOf: FNV-1a of the player (or connection) id. */
export function shardOf(key: string, shards: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % shards;
}

/** The FanoutDO a socket with this identity goes to (ADR 0028). */
export function fanoutFor(canvas: string, identity: SocketIdentity, shards: number): string {
  const key = 'player' in identity ? identity.player : identity.client;
  return fanoutName(canvas, shardOf(key, shards));
}

/** Dev ids and connection ids: what the client may choose. */
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Either who plays and from which page, or a socket that only watches. */
export type SocketIdentity =
  | {
      readonly player: string;
      readonly client: string;
      /** When the session token expires (ms): FanoutDO stops the socket playing then. */
      readonly until?: number;
      /** The team in the session token (ADR 0020): the socket's ops count for it. */
      readonly team?: number;
      /** The trust score in the session token (ADR 0026): it limits hammers and shields. */
      readonly trust?: number;
      /** A staging bot (ADR 0034): FanoutDO gets no address key, so no per-address limit. */
      readonly bot?: true;
    }
  | { readonly watch: true; readonly client: string };

/** A staging bot's number (ADR 0034): it plays as `bot-<n>`. */
const BOT_ID = /^(0|[1-9]\d{0,5})$/;
/** As token.ts's MIN_SECRET_LENGTH: a shorter BOT_KEY is a placeholder and opens nothing. */
const MIN_BOT_KEY_LENGTH = 32;

/**
 * True when the request carries `Authorization: Bearer <BOT_KEY>` on staging (ADR 0034).
 * Any other environment ignores the key, even one set there by mistake. Compared as SHA-256
 * digests, byte by byte without an early exit, so the time taken says nothing about the key.
 */
async function botKeyed(ctx: Context): Promise<boolean> {
  const key = ctx.env.BOT_KEY;
  if (ctx.env.ENVIRONMENT !== 'staging' || !key || key.length < MIN_BOT_KEY_LENGTH) return false;
  const sent = /^Bearer (.+)$/.exec(ctx.request.headers.get('Authorization') ?? '')?.[1];
  if (!sent) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(sent)),
    crypto.subtle.digest('SHA-256', encoder.encode(key)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * Signed in with a current token and a nickname: plays as the account. In dev without that,
 * `?player=` plays under a dev id (`dev-` keeps it apart from account ids). On staging,
 * `?bot=` with the bot key plays as a bot (ADR 0034). Anyone else watches. `?client=` is the
 * page's connection id for the op dedupe key; a socket without one gets a fresh id. Returns an
 * error status for malformed ids or a foreign Origin.
 */
export async function socketIdentity(ctx: Context): Promise<SocketIdentity | number> {
  // A page on another site must not open a socket that plays with our visitor's cookie.
  if (foreignOrigin(ctx)) return 403;
  const params = ctx.url.searchParams;
  const requestedClient = params.get('client');
  if (requestedClient !== null && !CLIENT_ID.test(requestedClient)) return 400;
  const client = requestedClient ?? randomToken(16);
  const session = await readSession(ctx);
  if (session && current(ctx, session) && session.n === 1) {
    const team = session.t;
    const trust = session.r;
    return {
      player: session.u,
      client,
      until: session.e,
      ...(typeof team === 'number' && team > 0 ? { team } : {}),
      ...(Number.isInteger(trust) && trust! >= 0 && trust! <= 100 ? { trust } : {}),
    };
  }
  if (ctx.dev) {
    const requested = params.get('player');
    if (requested !== null) {
      return CLIENT_ID.test(requested) ? { player: `dev-${requested}`, client } : 400;
    }
  }
  const bot = params.get('bot');
  if (bot !== null && (await botKeyed(ctx))) {
    // A session's lifetime: FanoutDO closes it (4401) after that, and the reconnect checks
    // the key again, so deleting BOT_KEY stops every bot within the hour.
    const until = ctx.now + SESSION_TTL_MS;
    return BOT_ID.test(bot) ? { player: `bot-${bot}`, client, until, bot: true } : 400;
  }
  return { watch: true, client };
}

/**
 * The upgrade request as FanoutDO receives it: only the gateway's identity headers, the
 * canvas the gateway chose and, for a player, the shard's share of the cap (null: no cap).
 */
export function withIdentity(
  request: Request,
  identity: SocketIdentity,
  canvas: string,
  share: number | null = null,
): Request {
  const headers = new Headers(request.headers);
  headers.delete(CAP_HEADER);
  headers.delete(PLAYER_HEADER);
  headers.delete(CLIENT_HEADER);
  headers.delete(WATCH_HEADER);
  headers.delete(UNTIL_HEADER);
  headers.delete(TEAM_HEADER);
  headers.delete(ADDRESS_HEADER);
  headers.delete(NETWORK_HEADER);
  headers.delete(TRUST_HEADER);
  headers.set(CANVAS_HEADER, canvas);
  // The session cookie and a bot key have done their job here; FanoutDO never needs them.
  headers.delete('Cookie');
  headers.delete('Authorization');
  headers.set(CLIENT_HEADER, identity.client);
  // Set by Cloudflare's edge for every request; a client cannot choose it.
  // A staging bot gets no address key (ADR 0034): many bots run from one machine.
  const ip = 'bot' in identity ? null : request.headers.get('CF-Connecting-IP');
  const address = addressKey(ip);
  if (address) headers.set(ADDRESS_HEADER, address);
  const network = networkKey(ip);
  if (network) headers.set(NETWORK_HEADER, network);
  if ('player' in identity) {
    headers.set(PLAYER_HEADER, identity.player);
    if (identity.until !== undefined) headers.set(UNTIL_HEADER, String(identity.until));
    if (identity.team !== undefined) headers.set(TEAM_HEADER, String(identity.team));
    if (identity.trust !== undefined) headers.set(TRUST_HEADER, String(identity.trust));
    if (share !== null) headers.set(CAP_HEADER, String(share));
  } else {
    headers.set(WATCH_HEADER, '1');
  }
  return new Request(request, { headers });
}
