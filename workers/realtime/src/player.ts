// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module.

/**
 * Carries the player id from the gateway, which strips any copy sent by the client. FanoutDO
 * is reachable only through its binding, so the header is trusted here. The gateway repeats
 * the name (it must not bundle FanoutDO); the gateway tests check they agree.
 */
export const PLAYER_HEADER = 'X-BrickPlace-Player';

/**
 * The page's connection id (ADR 0017), checked by the gateway: part of the op dedupe key, so
 * two tabs of one account, or one tab after a reload, never share opIds. Chosen by the
 * client, but only within its own player, so it cannot touch anyone else's ops.
 */
export const CLIENT_HEADER = 'X-BrickPlace-Client';

/**
 * Set by the gateway, instead of a player, on a socket that only watches: signed out, or
 * signed in without a nickname yet. Such a socket gets the map and has its ops refused with
 * `signed_out`. A socket with neither header is refused, so a gateway bug cannot turn
 * players into watchers silently.
 */
export const WATCH_HEADER = 'X-BrickPlace-Watch';

/**
 * When the session token behind a player socket expires (ms since the epoch), set by the
 * gateway for account players. FanoutDO refuses the socket's ops after it and closes it.
 */
export const UNTIL_HEADER = 'X-BrickPlace-Until';

/**
 * The team the player is in, from the session token (ADR 0020), set by the gateway for
 * account players in a team. FanoutDO passes it with every op; CanvasDO counts the op for it.
 */
export const TEAM_HEADER = 'X-BrickPlace-Team';

/**
 * The account's trust score (0..100) from the session token (ADR 0026), set by the gateway
 * for account players whose token carries one. FanoutDO limits hammers and shields by it;
 * absent, the policy's `unscored` stands in.
 */
export const TRUST_HEADER = 'X-BrickPlace-Trust';

/**
 * The key socket opens are counted under per address (ADR 0026): the gateway's reduction of
 * the connecting IP (IPv4 as is, IPv6 by its /64). FanoutDO keeps it in memory only and never
 * logs or stores it.
 */
export const ADDRESS_HEADER = 'X-BrickPlace-Address';

/**
 * A wider key for IPv6 socket opens (ADR 0026): the connecting address's /48, set by the
 * gateway beside ADDRESS_HEADER. Absent for IPv4. Memory only, like the address key.
 */
export const NETWORK_HEADER = 'X-BrickPlace-Network';

/**
 * The canvas (season, ADR 0021) the socket plays on, set by the gateway from the season
 * registry. A FanoutDO serves one canvas: it pins the name on its first socket and refuses a
 * socket for another one. Absent: the Stage 0 canvas, `canvas`.
 */
export const CANVAS_HEADER = 'X-BrickPlace-Canvas';

/**
 * How long a session token lets a socket play (the gateway's SESSION_TTL_MS, ADR 0015),
 * repeated so realtime does not bundle the gateway; the gateway tests check they agree. A
 * kick (ADR 0023) refuses play to every token issued before it: those expire before the kick
 * time plus this.
 */
export const SESSION_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Close code of a socket kicked by moderation or account deletion (ADR 0023). The page
 * reconnects as it does after any close; sockets opened with its old token only watch, and
 * its next op is refused `signed_out`, which makes it renew (and learn of the ban, the reset
 * or the deletion).
 */
export const KICKED = 4403;

/**
 * Close code of a playing socket replaced by a newer playing socket of the same account
 * (ADR 0026: one playing socket per account). The page stops playing and watches through the
 * CDN until its player taps "Play here", then reconnects and takes over in turn.
 */
export const PLAYING_ELSEWHERE = 4409;

/**
 * Close code of a playing socket whose account must pass a fresh Turnstile before it moves
 * again (ADR 0026: bot signals crossed the policy's `challengeAt`). The op that met it is not
 * acked, so the page keeps it in flight; the page waits for the player to pass the challenge
 * (POST /api/challenge), then reconnects and resends it.
 */
export const CHALLENGE_REQUIRED = 4428;

/**
 * The shard's share of the players-at-once cap (ADR 0039), set by the gateway on a playing
 * socket: a whole number of playing sockets. Absent or malformed: no cap.
 */
export const CAP_HEADER = 'X-BrickPlace-Cap';

/**
 * Close code of a socket turned away because the shard holds its share of players (ADR
 * 0039). It got no grid. The page watches through the CDN and tries again once the map has
 * room.
 */
export const MAP_FULL = 4503;

/**
 * Close code of a playing socket that gave its place to a newcomer on a full shard after
 * IDLE_YIELD_MS without a move (ADR 0039). The page watches and rejoins only when its player
 * taps "Play again".
 */
export const GAVE_UP_PLACE = 4408;

/**
 * The tag every playing socket carries beside its player id, so the playing sockets can be
 * counted without reading attachments. No player id starts with `*`.
 */
export const PLAYING_TAG = '*playing';

/**
 * The players-at-once cap with no `player_cap` row (ADR 0039): the owner's choice for the
 * first months. The gateway repeats it (its tests check they agree); the admin area imports it.
 */
export const DEFAULT_PLAYER_CAP = 5_000;
/** Most a cap may be: 64 shards of the runtime's 32,768 sockets, rounded down. */
export const MAX_PLAYER_CAP = 2_000_000;

/** Hibernatable sockets the runtime accepts per object (ops.ts MAX_SOCKETS says the same). */
const MAX_SOCKETS_PER_SHARD = 32_768;

/**
 * The share in a CAP_HEADER value: a whole number, at most the sockets the runtime accepts
 * per object (a larger share could never be reached anyway); null when absent or malformed.
 */
export function capShareOf(value: string | null): number | null {
  if (value === null || !/^\d{1,7}$/.test(value)) return null;
  return Math.min(Number(value), MAX_SOCKETS_PER_SHARD);
}

/** The Stage 0 canvas, from before seasons; its FanoutDO keeps its old name. */
export const STAGE0_CANVAS = 'canvas';

/** What a canvas name may look like: it becomes an R2 prefix and a DO name. */
export const CANVAS_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * The FanoutDO name of shard `shard` of a canvas (ADR 0028). Shard 0 keeps the name the
 * canvas's only fanout had before shards. Every playing socket of an account must reach one
 * object, which closes the older one (ADR 0026) and holds the account's limits and signals:
 * playing sockets pick their shard by account (shardOf(player)), never by load or area.
 */
export function fanoutName(canvas: string, shard = 0): string {
  return canvas === STAGE0_CANVAS ? `fanout-${shard}` : `${canvas}:fanout-${shard}`;
}

/** Most shards a canvas may have (the canvas pushes to at most 256 followers). */
export const MAX_FANOUT_SHARDS = 64;

/**
 * The number of shards from the `FANOUT_SHARDS` var of the gateway and the admin Worker: a
 * whole number from 1 to MAX_FANOUT_SHARDS; anything else (or nothing) means 1.
 */
export function shardCount(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_FANOUT_SHARDS ? n : 1;
}

/**
 * The shard a socket goes to: by player, so all of a player's sockets share one shard (holds
 * reach every socket of the player there), or by connection id for a watcher. FNV-1a, so the
 * gateway and the admin Worker agree without sharing state.
 */
export function shardOf(key: string, shards: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % shards;
}
