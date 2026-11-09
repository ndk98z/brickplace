// Account trust score (ADR 0026): computed when a session token is issued, from what D1 knows
// of the account, with weights from KV, and carried in the token (`r`). FanoutDO limits a
// low-trust account's hammers and shields by it. The weights are abuse thresholds: they live
// in KV (MODERATION, key `trust-weights`, written from the private ops repo), never here.

import type { User } from './accounts.ts';
import type { Context } from './http.ts';

/** KV key (MODERATION namespace) of the weights below, as JSON. */
export const TRUST_WEIGHTS_KEY = 'trust-weights';
/** How long an isolate keeps the weights before reading KV again. */
const WEIGHTS_TTL_MS = 5 * 60 * 1000;

/**
 * Points per fact; the sum is rounded and kept within 0..100. Age counts whole days since the
 * account was made, up to `maxAgeDays`. `email`: a provider gave a verified address (Reddit
 * gives none). `perIdentity`: each linked provider after the first. `perActionedReport`:
 * reports a moderator acted on. `perOpenReport` is optional and 0 when left out: nobody has
 * looked at an open report yet, so weighing it lets a crowd of accounts lower a victim's trust
 * by reporting it (ADR 0026). `perBan` counts every ban the account ever had, lifted or
 * expired ones too. Penalties are negative weights.
 */
export interface TrustWeights {
  readonly base: number;
  readonly perDay: number;
  readonly maxAgeDays: number;
  readonly email: number;
  readonly perIdentity: number;
  readonly perOpenReport: number;
  readonly perActionedReport: number;
  readonly perBan: number;
}

/** What D1 knows of an account that the score reads. */
export interface TrustFacts {
  readonly ageMs: number;
  readonly email: boolean;
  readonly identities: number;
  readonly openReports: number;
  readonly actionedReports: number;
  readonly bans: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KEYS = [
  'base',
  'perDay',
  'maxAgeDays',
  'email',
  'perIdentity',
  'perOpenReport',
  'perActionedReport',
  'perBan',
] as const;

/** Weights that may be left out, and what they are then. */
const OPTIONAL: Partial<Record<(typeof KEYS)[number], number>> = { perOpenReport: 0 };

/**
 * The weights in `text`, or null when missing or malformed (a required key absent, or any key
 * not a number).
 */
export function parseWeights(text: string | null): TrustWeights | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const read = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of KEYS) {
    const v = read[key] === undefined ? OPTIONAL[key] : read[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1000) return null;
    out[key] = v;
  }
  if (!Number.isInteger(out.maxAgeDays) || out.maxAgeDays! < 0) return null;
  return out as unknown as TrustWeights;
}

/** The score (0..100, whole) these weights give these facts. */
export function scoreOf(weights: TrustWeights, facts: TrustFacts): number {
  const days = Math.min(Math.floor(Math.max(0, facts.ageMs) / DAY_MS), weights.maxAgeDays);
  const raw =
    weights.base +
    weights.perDay * days +
    (facts.email ? weights.email : 0) +
    weights.perIdentity * Math.max(0, facts.identities - 1) +
    weights.perOpenReport * facts.openReports +
    weights.perActionedReport * facts.actionedReports +
    weights.perBan * facts.bans;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

let cached: { weights: TrustWeights | null; at: number; kv: KVNamespace } | null = null;

/** The weights from KV, cached per isolate for a few minutes (a miss too). */
async function weightsFrom(kv: KVNamespace | undefined, now: number): Promise<TrustWeights | null> {
  if (!kv) return null;
  if (cached && kv === cached.kv && now - cached.at < WEIGHTS_TTL_MS) return cached.weights;
  const text = await kv.get(TRUST_WEIGHTS_KEY);
  const weights = parseWeights(text);
  if (!weights) {
    console.error(
      text === null
        ? `${TRUST_WEIGHTS_KEY} is not set: tokens carry no trust score`
        : `${TRUST_WEIGHTS_KEY} is malformed: tokens carry no trust score`,
    );
  }
  cached = { weights, at: now, kv };
  return weights;
}

/** Drops the cached weights (tests change them between cases). */
export function forgetWeights(): void {
  cached = null;
}

/**
 * The account's trust score for a new token, or null when there are no usable weights or D1
 * or KV cannot answer: the token then carries none, and FanoutDO uses the policy's
 * `unscored` instead. Never throws, so a sign-in or renewal does not fail over it. One D1 read.
 */
export async function trustScore(ctx: Context, user: User): Promise<number | null> {
  try {
    const weights = await weightsFrom(ctx.env.MODERATION, ctx.now);
    if (!weights) return null;
    const row = await ctx.env.ACCOUNTS.prepare(
      'SELECT ' +
        '(SELECT COUNT(*) FROM identities WHERE user_id = ?1) AS identities, ' +
        "(SELECT COUNT(*) FROM reports WHERE target_id = ?1 AND status = 'open') AS open_reports, " +
        "(SELECT COUNT(*) FROM reports WHERE target_id = ?1 AND status = 'actioned') AS actioned, " +
        '(SELECT COUNT(*) FROM bans WHERE user_id = ?1) AS bans',
    )
      .bind(user.id)
      .first<{ identities: number; open_reports: number; actioned: number; bans: number }>();
    if (!row) return null;
    return scoreOf(weights, {
      ageMs: ctx.now - user.created_at,
      email: user.email !== null,
      identities: row.identities,
      openReports: row.open_reports,
      actionedReports: row.actioned,
      bans: row.bans,
    });
  } catch (error) {
    console.error('trust score unavailable; the token carries none', error);
    return null;
  }
}
