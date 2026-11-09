// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module.
//
// Abuse limits and bot signals for FanoutDO (ADR 0026). Every number that tunes them is an
// abuse threshold, which must not be in this public repository (ADR 0002): they come from KV
// (`abuse-policy` in the MODERATION namespace, written from the private ops repo) and tests
// inject their own. Without a readable policy every limit here is off (see parsePolicy).
// State is memory only and bounded: an eviction (a deploy, an idle hibernation) forgets
// windows and suspicion, which at worst gives a player fresh windows. Pure: the clock comes in
// as `now`, so tests drive it.

/** KV key (MODERATION namespace) of the policy below, as JSON. */
export const POLICY_KEY = 'abuse-policy';

/**
 * Ops and discards of one account waiting for the canvas at once; more are answered
 * `unavailable` without a call. A page sends one per click and its hold has a few items, so
 * this is a capacity bound on what one socket can queue at the canvas, kept with or without
 * a policy, not an abuse threshold.
 */
export const MAX_IN_FLIGHT = 8;

/** At most `limit` events per fixed window of `windowMs`. */
export interface Limit {
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * How many hammers and shields an account may use per window by trust score: the first tier
 * whose `below` is above the account's effective score applies; past the last tier there is
 * no limit. `unscored` stands in for a token without a score (older tokens, or a gateway
 * without weights), so the owner decides how those are treated.
 */
export interface TrustPolicy {
  readonly unscored: number;
  readonly windowMs: number;
  readonly tiers: readonly { readonly below: number; readonly uses: number }[];
}

/**
 * Bot signals: each adds its weight to a suspicion score that halves every `halfLifeMs`.
 * - `offView`: an op outside the cells the page reported showing (plus `viewMargin`).
 * - `noView`: an op from a socket that never reported a view (a client that does not send
 *   one; old pages do the same for a while after a deploy, so this one may weigh 0).
 * - `onCooldown`: `samples` uses in a row of an item that had just arrived, each within
 *   `withinMs` of its arrival, all within `spreadMs` of each other: a person's reaction
 *   varies more than a timer's.
 * Suspicion costs `trustPenalty` trust points per point; from `challengeAt` the account must
 * pass a fresh Turnstile before its next move (0: never), and from `flagAt` moderators see it
 * in the admin area. No signal bans or blocks anyone by itself.
 */
export interface SignalPolicy {
  readonly halfLifeMs: number;
  readonly offView: number;
  readonly viewMargin: number;
  readonly noView: number;
  readonly onCooldown: number;
  readonly samples: number;
  readonly withinMs: number;
  readonly spreadMs: number;
  readonly trustPenalty: number;
  readonly challengeAt: number;
  readonly flagAt: number;
}

/** Each part is optional: a part left out turns that limit off. */
export interface AbusePolicy {
  /**
   * Socket opens per account, per address key (IPv4, or an IPv6 /64) and per IPv6 network
   * (/48: a subscriber is often given one, and could use a fresh /64 for each open).
   */
  readonly opens?: { readonly account?: Limit; readonly address?: Limit; readonly network?: Limit };
  /** Ops and discards per account. */
  readonly ops?: { readonly account?: Limit };
  readonly trust?: TrustPolicy;
  readonly signals?: SignalPolicy;
}

/** Longest window or half-life a policy may set (ms): longer state outlives memory anyway. */
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Most samples the timing signal keeps per player: a bound on memory, not a tuning knob. */
export const MAX_SAMPLES = 32;
/** Most tiers a trust policy may list. */
const MAX_TIERS = 16;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function whole(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? value
    : null;
}

function weight(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e6
    ? value
    : null;
}

function limit(value: unknown): Limit | null {
  if (!isObject(value)) return null;
  const count = whole(value.limit, 1e6);
  const windowMs = whole(value.windowMs, MAX_WINDOW_MS);
  if (count === null || windowMs === null || windowMs < 1000) return null;
  return { limit: count, windowMs };
}

/** An optional part: absent is fine (undefined), present but malformed fails the policy. */
function part<T>(value: unknown, read: (v: unknown) => T | null): T | undefined | null {
  return value === undefined ? undefined : read(value);
}

function limits<K extends string>(value: unknown, keys: readonly K[]) {
  if (!isObject(value)) return null;
  const out: Partial<Record<K, Limit>> = {};
  for (const key of keys) {
    const read = part(value[key], limit);
    if (read === null) return null;
    if (read) out[key] = read;
  }
  return out;
}

function trust(value: unknown): TrustPolicy | null {
  if (!isObject(value) || !Array.isArray(value.tiers) || value.tiers.length > MAX_TIERS) {
    return null;
  }
  const unscored = whole(value.unscored, 100);
  const windowMs = whole(value.windowMs, MAX_WINDOW_MS);
  if (unscored === null || windowMs === null || windowMs < 1000) return null;
  const tiers: { below: number; uses: number }[] = [];
  for (const tier of value.tiers as unknown[]) {
    if (!isObject(tier)) return null;
    const below = whole(tier.below, 101);
    const uses = whole(tier.uses, 1e6);
    if (below === null || uses === null) return null;
    // Ascending, so the first match is the strictest that applies.
    if (tiers.length > 0 && below <= tiers.at(-1)!.below) return null;
    tiers.push({ below, uses });
  }
  return { unscored, windowMs, tiers };
}

function signals(value: unknown): SignalPolicy | null {
  if (!isObject(value)) return null;
  const halfLifeMs = whole(value.halfLifeMs, MAX_WINDOW_MS);
  const samples = whole(value.samples, MAX_SAMPLES);
  const read = {
    offView: weight(value.offView),
    viewMargin: whole(value.viewMargin, 0xffff),
    noView: weight(value.noView),
    onCooldown: weight(value.onCooldown),
    withinMs: whole(value.withinMs, MAX_WINDOW_MS),
    spreadMs: whole(value.spreadMs, MAX_WINDOW_MS),
    trustPenalty: weight(value.trustPenalty),
    challengeAt: weight(value.challengeAt),
    flagAt: weight(value.flagAt),
  };
  if (halfLifeMs === null || halfLifeMs < 1000 || samples === null || samples < 2) return null;
  for (const v of Object.values(read)) if (v === null) return null;
  return { halfLifeMs, samples, ...(read as { [K in keyof typeof read]: number }) };
}

/**
 * The policy in `text`, or null when it is missing or malformed. Null turns every limit and
 * signal here off (fail open): refusing every op or every hammer because a key is missing
 * would stop the game for everyone, while the item economy (one item per cooldown, drawn by
 * the server), the per-socket bound on ops in flight and the WAF still bound what an account
 * can do. FanoutDO logs `abuse_policy_missing` at error level, so the owner hears of it.
 * Malformed means any part present but wrong: a typo must not silently drop one limit.
 */
export function parsePolicy(text: string | null): AbusePolicy | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const opens = part(value.opens, (v) => limits(v, ['account', 'address', 'network'] as const));
  const ops = part(value.ops, (v) => limits(v, ['account'] as const));
  const trusted = part(value.trust, trust);
  const signaled = part(value.signals, signals);
  if (opens === null || ops === null || trusted === null || signaled === null) return null;
  return {
    ...(opens ? { opens } : {}),
    ...(ops ? { ops } : {}),
    ...(trusted ? { trust: trusted } : {}),
    ...(signaled ? { signals: signaled } : {}),
  };
}

/**
 * Fixed-window counters by key, at most `max` keys: past that, the windows started longest
 * ago are dropped first (a Map keeps insertion order, and a new window is inserted anew).
 */
export class Windows {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly max: number) {}

  /** Counts one event for `key`; false (and not counted) when the window is full. */
  take(key: string, rule: Limit, now: number): boolean {
    return this.reserve(key, rule, now) !== null;
  }

  /**
   * As take(), returning when the window the event was counted in started (null: refused),
   * so refund() can give it back to that window and no other.
   */
  reserve(key: string, rule: Limit, now: number): number | null {
    const window = this.current(key, rule, now);
    if (window.count >= rule.limit) return null;
    window.count++;
    return window.start;
  }

  /** Events counted for `key` in its current window. */
  used(key: string, rule: Limit, now: number): number {
    const window = this.windows.get(key);
    return window && now - window.start < rule.windowMs ? window.count : 0;
  }

  /** Counts one event for `key` without a ceiling (it was checked before, see used()). */
  add(key: string, rule: Limit, now: number): void {
    this.current(key, rule, now).count++;
  }

  /**
   * Gives back one event reserved for `key` in the window that started at `start` (the event
   * did not happen after all). Nothing once that window has given way to a new one: an event
   * of the old window must not free room in the new.
   */
  refund(key: string, start: number): void {
    const window = this.windows.get(key);
    if (window && window.start === start && window.count > 0) window.count--;
  }

  get size(): number {
    return this.windows.size;
  }

  private current(key: string, rule: Limit, now: number) {
    let window = this.windows.get(key);
    if (!window || now - window.start >= rule.windowMs) {
      this.windows.delete(key);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
      while (this.windows.size > this.max) {
        this.windows.delete(this.windows.keys().next().value!);
      }
    }
    return window;
  }
}

/** The kinds of bot signal (ADR 0026); also the names of their counters. */
export type SignalKind = 'offView' | 'noView' | 'onCooldown';

/** What moderators see of one account (FanoutDO.suspects). */
export interface Suspect {
  readonly player: string;
  /** Suspicion now, after decay. */
  readonly score: number;
  readonly offView: number;
  readonly noView: number;
  readonly onCooldown: number;
  /** Turnstiles it was asked for and passed while this object was up. */
  readonly passed: number;
  /** When a Turnstile was required of it (ms), if one still is. */
  readonly challengedAt?: number;
}

interface Suspicion {
  score: number;
  at: number;
  offView: number;
  noView: number;
  onCooldown: number;
  passed: number;
  /** Lags (ms) of the latest fresh-item uses, for the timing signal. */
  lags: number[];
  /** The item arrival last sampled, so one arrival counts once. */
  sampled: number;
}

/**
 * Per-player suspicion from bot signals, at most `max` players (least recently updated first
 * out).
 */
export class Signals {
  private readonly players = new Map<string, Suspicion>();

  constructor(private readonly max: number) {}

  /** Suspicion of `player` at `now`, decayed. */
  score(player: string, policy: SignalPolicy, now: number): number {
    const entry = this.players.get(player);
    return entry ? decayed(entry, policy, now) : 0;
  }

  /**
   * Records the signals of one op at (x, y): against the reported view (null: none), and,
   * when the op uses an item that arrived at `arrived` (ms) and was not sampled yet, the lag
   * since. Returns the signals that fired, and the suspicion after them.
   */
  op(
    player: string,
    at: { readonly x: number; readonly y: number },
    view: readonly [number, number, number, number] | null,
    arrived: number | null,
    policy: SignalPolicy,
    now: number,
  ): { readonly fired: readonly SignalKind[]; readonly score: number } {
    const fired: SignalKind[] = [];
    if (view === null) fired.push('noView');
    else if (!inside(at, view, policy.viewMargin)) fired.push('offView');
    const entry = this.entry(player, policy, now);
    if (arrived !== null && arrived > entry.sampled && now >= arrived) {
      entry.sampled = arrived;
      const lag = now - arrived;
      if (lag > policy.withinMs) {
        // A person who waited: the streak is broken.
        entry.lags = [];
      } else {
        entry.lags.push(lag);
        if (entry.lags.length > policy.samples) entry.lags.shift();
        if (
          entry.lags.length >= policy.samples &&
          Math.max(...entry.lags) - Math.min(...entry.lags) <= policy.spreadMs
        ) {
          fired.push('onCooldown');
          entry.lags = [];
        }
      }
    }
    for (const kind of fired) {
      entry[kind]++;
      entry.score += policy[kind];
    }
    return { fired, score: entry.score };
  }

  /**
   * `player` passed a Turnstile it was asked for: its suspicion (and timing streak) starts
   * over, but the counts stay, with one more pass, so moderators still see its history.
   */
  passed(player: string, now: number): void {
    const entry = this.players.get(player) ?? this.fresh(player, now);
    entry.score = 0;
    entry.at = now;
    entry.lags = [];
    entry.passed++;
  }

  /** Drops everything kept of `player` (its account was deleted). */
  forget(player: string): void {
    this.players.delete(player);
  }

  /**
   * Players at or above `flagAt`, and those that passed a Turnstile, most suspicious first,
   * at most `limit`.
   */
  flagged(policy: SignalPolicy, now: number, limit: number): Suspect[] {
    const out: Suspect[] = [];
    for (const player of this.players.keys()) {
      const suspect = this.suspect(player, policy, now);
      const flagged = suspect.score >= policy.flagAt && suspect.score > 0;
      if (flagged || suspect.passed > 0) out.push(suspect);
    }
    out.sort((a, b) => b.score - a.score || b.passed - a.passed);
    return out.slice(0, limit);
  }

  /** What is known of `player` (zeros for a player with no signals). */
  suspect(player: string, policy: SignalPolicy | null, now: number): Suspect {
    const entry = this.players.get(player);
    const score = entry && policy ? decayed(entry, policy, now) : 0;
    return {
      player,
      score: Math.round(score * 100) / 100,
      offView: entry?.offView ?? 0,
      noView: entry?.noView ?? 0,
      onCooldown: entry?.onCooldown ?? 0,
      passed: entry?.passed ?? 0,
    };
  }

  get size(): number {
    return this.players.size;
  }

  /**
   * The player's entry, decayed to `now` and moved to the end of the map: the players updated
   * longest ago are dropped first, so an active bot is never pushed out by a crowd of others.
   */
  private entry(player: string, policy: SignalPolicy, now: number): Suspicion {
    const entry = this.players.get(player);
    if (!entry) return this.fresh(player, now);
    entry.score = decayed(entry, policy, now);
    entry.at = now;
    this.players.delete(player);
    this.players.set(player, entry);
    return entry;
  }

  private fresh(player: string, now: number): Suspicion {
    const fresh: Suspicion = {
      score: 0,
      at: now,
      offView: 0,
      noView: 0,
      onCooldown: 0,
      passed: 0,
      lags: [],
      sampled: 0,
    };
    this.players.set(player, fresh);
    while (this.players.size > this.max) {
      this.players.delete(this.players.keys().next().value!);
    }
    return fresh;
  }
}

function decayed(entry: Suspicion, policy: SignalPolicy, now: number): number {
  const age = Math.max(0, now - entry.at);
  return entry.score * 2 ** (-age / policy.halfLifeMs);
}

/** True when (x, y) lies in the view grown by `margin` cells on every side. */
export function inside(
  at: { readonly x: number; readonly y: number },
  [x, y, w, h]: readonly [number, number, number, number],
  margin: number,
): boolean {
  return at.x >= x - margin && at.x < x + w + margin && at.y >= y - margin && at.y < y + h + margin;
}

/**
 * How many hammers and shields an account may use per window (the limit), or null for no
 * limit: its score from the token (`unscored` without one), less the suspicion penalty,
 * picks the first tier it is below.
 */
export function allowance(
  policy: AbusePolicy,
  token: number | undefined,
  suspicion: number,
): Limit | null {
  const trust = policy.trust;
  if (!trust) return null;
  const penalty = policy.signals ? policy.signals.trustPenalty * suspicion : 0;
  const score = (token ?? trust.unscored) - penalty;
  const tier = trust.tiers.find((t) => score < t.below);
  return tier ? { limit: tier.uses, windowMs: trust.windowMs } : null;
}
