import type { AccessIdentity } from './access.ts';

// The audit log (ADR 0022): one row per admin action that passed sign-in and validation,
// written in the same D1 batch as the change it records when there is one, and one per
// change refused for want of a role (outcome `forbidden`). Append only: the table's triggers
// refuse UPDATE, DELETE and REPLACE, and no route offers any of them.

/** Who acted: an admin, or a person Access let in who has no role for it. */
export type Actor = AccessIdentity;

export interface AuditEntry {
  /** Dotted name, e.g. `config.schedule`, `emergency.cooldown_double`, `role.grant`. */
  readonly action: string;
  readonly target?: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string;
  /** `ok`, or why the game refused it (`not_available`, `stale`, ...). */
  readonly outcome?: string;
}

export interface AuditRow {
  readonly id: number;
  readonly at: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string;
  readonly outcome: string;
}

export function auditStatement(
  db: D1Database,
  admin: Actor,
  now: number,
  entry: AuditEntry,
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO audit_log (at, actor, actor_sub, action, target, before, after, reason, outcome) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      now,
      admin.email,
      admin.sub,
      entry.action,
      entry.target ?? '',
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.reason ?? '',
      entry.outcome ?? 'ok',
    );
}

export async function audit(
  db: D1Database,
  admin: Actor,
  now: number,
  entry: AuditEntry,
): Promise<void> {
  await auditStatement(db, admin, now, entry).run();
}

/**
 * Appends `entry` unless `actor` already has a row with the same action within `windowMs`:
 * for refusals of people with no role, who must not be able to fill the log by repeating a
 * request (Access lets them in, so they can script it). One statement, so two racing
 * requests write at most one row more.
 */
export async function auditOncePer(
  db: D1Database,
  actor: Actor,
  now: number,
  windowMs: number,
  entry: AuditEntry,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO audit_log (at, actor, actor_sub, action, target, reason, outcome) ' +
        'SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM audit_log ' +
        'WHERE actor = ? AND action = ? AND at > ?)',
    )
    .bind(
      now,
      actor.email,
      actor.sub,
      entry.action,
      entry.target ?? '',
      entry.reason ?? '',
      entry.outcome ?? 'ok',
      actor.email,
      entry.action,
      now - windowMs,
    )
    .run();
}

/** At most one refusal row per hour for a person with no role (a bound, not a threshold). */
export const NO_ROLE_AUDIT_MS = 60 * 60 * 1000;

export const AUDIT_PAGE = 50;

/** Newest first, `limit` rows with ids below `before` (all when absent). */
export async function listAudit(
  db: D1Database,
  before: number | null,
  limit = AUDIT_PAGE,
): Promise<AuditRow[]> {
  const { results } = await db
    .prepare(
      'SELECT id, at, actor, action, target, before, after, reason, outcome FROM audit_log ' +
        'WHERE id < ? ORDER BY id DESC LIMIT ?',
    )
    .bind(before ?? Number.MAX_SAFE_INTEGER, limit)
    .all<Record<string, unknown>>();
  return results.map((row) => ({
    id: row.id as number,
    at: row.at as number,
    actor: row.actor as string,
    action: row.action as string,
    target: row.target as string,
    before: parse(row.before),
    after: parse(row.after),
    reason: row.reason as string,
    outcome: row.outcome as string,
  }));
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
