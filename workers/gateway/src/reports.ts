// Reporting a nickname or a team name (ADR 0008, 0019, 0023): a signed-in player flags
// another player's nickname, or a team's name, for moderators. One open report per reporter
// and target, and a daily cap per reporter whose number is an abuse threshold: it lives in
// KV, never in this repo.

/** Why a nickname is reported: a fixed, small set (also checked by the D1 schema). */
export const REPORT_REASONS = ['offensive', 'hateful', 'impersonation', 'personal_info'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);
}

/**
 * KV key (MODERATION namespace, written from the private ops repo) holding how many reports
 * one account may file per rolling 24 hours: a whole number, `0` closes reporting.
 */
export const REPORT_LIMIT_KEY = 'report-daily-limit';
export const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long an isolate keeps the limit before reading KV again. */
const LIMIT_TTL_MS = 5 * 60 * 1000;

let cached: { limit: number; at: number; kv: KVNamespace } | null = null;

/**
 * The daily cap from KV, cached per isolate for a few minutes. Outside dev, a missing,
 * unreadable or malformed value gives `null`: reports are refused (fail closed) rather than
 * taken without a cap. Dev without a value has no cap (`Infinity`).
 */
export async function reportLimit(
  kv: KVNamespace | undefined,
  dev: boolean,
  now: number,
): Promise<number | null> {
  if (cached && kv === cached.kv && now - cached.at < LIMIT_TTL_MS) return cached.limit;
  let text: string | null = null;
  try {
    text = kv ? await kv.get(REPORT_LIMIT_KEY) : null;
  } catch (error) {
    console.error('report limit unreadable', error);
  }
  const trimmed = text?.trim() ?? '';
  if (!/^\d{1,9}$/.test(trimmed)) {
    if (text !== null) console.error(`${REPORT_LIMIT_KEY} is not a whole number`);
    return dev ? Number.POSITIVE_INFINITY : null;
  }
  const limit = Number(trimmed);
  if (kv) cached = { limit, at: now, kv };
  return limit;
}

/** Drops the cached limit (tests change it between cases). */
export function forgetReportLimit(): void {
  cached = null;
}

/**
 * The one reason a team is reported for: its name (ADR 0023). The schema ties it to team
 * targets, and the nickname reasons to players.
 */
export const TEAM_NAME_REASON = 'team_name';

export type FileResult = 'filed' | 'already_reported' | 'too_many';

/** What a report is about: a player's nickname, or a team's name (ADR 0023). */
export type ReportTarget =
  | { readonly player: string; readonly nickname: string; readonly reason: ReportReason }
  | { readonly team: number; readonly name: string };

/**
 * Files a report unless this reporter already has an open one on this target, or has filed
 * `limit` reports in the last 24 hours. The cap is a condition of the INSERT itself, so
 * reports sent at once cannot pass it together; the partial UNIQUE indexes do the same for
 * the one-open-report rule.
 */
export async function fileReport(
  db: D1Database,
  report: { reporter: string; target: ReportTarget; now: number; limit: number },
): Promise<FileResult> {
  const { reporter, target, now, limit } = report;
  const column = 'player' in target ? 'target_id' : 'target_team_id';
  const id = 'player' in target ? target.player : target.team;
  const named = 'player' in target ? target.nickname : target.name;
  const reason = 'player' in target ? target.reason : TEAM_NAME_REASON;
  const open = await db
    .prepare(
      `SELECT 1 AS one FROM reports WHERE reporter_id = ? AND ${column} = ? AND status = 'open'`,
    )
    .bind(reporter, id)
    .first();
  if (open) return 'already_reported';
  try {
    const capped = Number.isFinite(limit);
    const insert = db.prepare(
      `INSERT INTO reports (reporter_id, ${column}, target_nickname, reason, created_at) ` +
        `SELECT ?, ?, ?, ?, ?${
          capped
            ? ' WHERE (SELECT COUNT(*) FROM reports WHERE reporter_id = ? AND created_at > ?) < ?'
            : ''
        }`,
    );
    const values: unknown[] = [reporter, id, named, reason, now];
    if (capped) values.push(reporter, now - REPORT_WINDOW_MS, limit);
    const result = await insert.bind(...values).run();
    return result.meta.changes > 0 ? 'filed' : 'too_many';
  } catch (error) {
    if (String(error).includes('UNIQUE')) return 'already_reported';
    throw error;
  }
}
