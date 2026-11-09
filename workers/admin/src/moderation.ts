import type { Suspect } from '@brickplace/realtime';
import { fanoutName, MAX_FANOUT_SHARDS } from '@brickplace/realtime/player';
import type { Admin } from './identity.ts';
import type { Env } from './index.ts';
import { currentCanvas } from './ports.ts';

// Player moderation (ADR 0023) on the gateway's accounts database (ACCOUNTS, ADR 0022): the
// report queue, bans, nickname and team-name resets, closing a team, and kicking a player's
// open sockets through FanoutDO. The schema stays the gateway's (workers/gateway/migrations).
// Changes run inside routes' `acting()`, which audits them before and after; every rule two
// admins could race past is a condition of the statement that applies it.
//
// The audit log is append-only and outlives a deleted account, so audit rows name players by
// id only, never by nickname or email. Team names are not personal data (ADR 0020).

/** A player (account id, also the op log's player id) or a team (its id). */
export type Target = { readonly player: string } | { readonly team: number };

/** Account ids are random UUIDs (ADR 0016). */
export const PLAYER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Longest ban reason kept: the player sees it in their data download (ADR 0019). */
export const BAN_REASON_MAX = 200;
/** Latest a ban may expire (ms ahead); for longer, a permanent ban. */
export const BAN_MAX_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const QUEUE_LIMIT = 100;
const SEARCH_LIMIT = 20;

/** How an audit row names a target: ids only. */
export function targetName(target: Target): string {
  return 'player' in target ? `player:${target.player}` : `team:${target.team}`;
}

function targetColumn(target: Target): [string, string | number] {
  return 'player' in target ? ['target_id', target.player] : ['target_team_id', target.team];
}

/**
 * Closes every open report on `target` as `status`, for the caller's batch. With `when`, only
 * if that condition holds as the statement runs (after the change it follows).
 */
export function closeReports(
  db: D1Database,
  target: Target,
  status: 'actioned' | 'dismissed',
  now: number,
  when?: { readonly sql: string; readonly values: readonly unknown[] },
): D1PreparedStatement {
  const [column, id] = targetColumn(target);
  return db
    .prepare(
      `UPDATE reports SET status = ?, resolved_at = ? WHERE status = 'open' AND ${column} = ?` +
        (when ? ` AND ${when.sql}` : ''),
    )
    .bind(status, now, id, ...(when?.values ?? []));
}

/** Open reports on `target`. */
export async function openReports(db: D1Database, target: Target): Promise<number> {
  const [column, id] = targetColumn(target);
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open' AND ${column} = ?`)
    .bind(id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The names a reason about `target` must not quote, lower case: a player's nickname (or
 * placeholder) and the name a reset removed; a team's name, its removed name, and its owner's.
 */
export async function namesOf(db: D1Database, target: Target): Promise<string[]> {
  const row =
    'player' in target
      ? await db
          .prepare(
            'SELECT nickname_key AS a, nickname_reset_key AS b, NULL AS c FROM users WHERE id = ?',
          )
          .bind(target.player)
          .first<{ a: string | null; b: string | null; c: string | null }>()
      : await db
          .prepare(
            'SELECT t.name_key AS a, t.name_reset_key AS b, u.nickname_key AS c FROM teams t ' +
              'LEFT JOIN users u ON u.id = t.owner_id WHERE t.id = ?',
          )
          .bind(target.team)
          .first<{ a: string | null; b: string | null; c: string | null }>();
  return [row?.a, row?.b, row?.c].filter((n): n is string => typeof n === 'string');
}

/**
 * True when `player` may be the admin themselves: its account email, or an email one of its
 * provider identities gave, is the admin's Access email (any letter case). A guard against
 * accidents and the obvious conflict of interest, not a proof: an account under another
 * address, or none (Reddit gives none), is not recognised (ADR 0023).
 */
export async function isSelf(db: D1Database, admin: Admin, player: string): Promise<boolean> {
  const row = await db
    .prepare(
      'SELECT 1 AS one FROM users WHERE id = ?1 AND (lower(email) = ?2 OR EXISTS (SELECT 1 ' +
        'FROM identities WHERE user_id = ?1 AND lower(email) = ?2))',
    )
    .bind(player, admin.email.toLowerCase())
    .first();
  return row !== null;
}

// ---- The report queue ---------------------------------------------------------------------

export interface QueueEntry {
  readonly kind: 'player' | 'team';
  /** The account id (a player), or the team id. */
  readonly id: string | number;
  readonly reports: number;
  readonly reasons: readonly string[];
  /** The names as reported (they may have changed since). */
  readonly reported: readonly string[];
  readonly firstAt: number;
  readonly lastAt: number;
  /** The name now: for a reset one, its placeholder. */
  readonly current: string | null;
  /** True while a moderator's reset placeholder stands in for the name. */
  readonly reset: boolean;
  /** Player: when the account was made. Team: when the team was made. */
  readonly createdAt: number | null;
  /** Player: bans ever (lifted and expired included). */
  readonly priorBans: number;
  /** Player: a ban applies now. */
  readonly banned: boolean;
  /** Team: closed (its cells stay on the map). */
  readonly closed: boolean;
  /** Team: the owner's account id, for acting on the owner too. */
  readonly ownerId: string | null;
}

type QueueRow = {
  player: string | null;
  team: number | null;
  reports: number;
  reasons: string | null;
  names: string | null;
  first_at: number;
  last_at: number;
  nickname: string | null;
  nickname_reset_at: number | null;
  user_created_at: number | null;
  bans: number;
  active_bans: number;
  team_name: string | null;
  team_created_at: number | null;
  team_closed_at: number | null;
  team_reset_at: number | null;
  owner_id: string | null;
};

/** Names and reasons hold no comma (letters, digits and `_`), so the default separator is safe. */
const split = (text: string | null) => (text ? text.split(',') : []);

/**
 * Open reports grouped by target, most reported first, then oldest. Reporters are never
 * shown: only how many filed, why, and the names they saw.
 */
export async function reportQueue(db: D1Database, now: number): Promise<QueueEntry[]> {
  const { results } = await db
    .prepare(
      'SELECT r.target_id AS player, r.target_team_id AS team, r.reports, r.reasons, r.names, ' +
        'r.first_at, r.last_at, u.nickname, u.nickname_reset_at, ' +
        'u.created_at AS user_created_at, ' +
        '(SELECT COUNT(*) FROM bans b WHERE b.user_id = r.target_id) AS bans, ' +
        '(SELECT COUNT(*) FROM bans b WHERE b.user_id = r.target_id AND b.lifted_at IS NULL ' +
        'AND (b.expires_at IS NULL OR b.expires_at > ?1)) AS active_bans, ' +
        't.name AS team_name, t.created_at AS team_created_at, ' +
        't.closed_at AS team_closed_at, t.name_reset_at AS team_reset_at, t.owner_id ' +
        'FROM (SELECT target_id, target_team_id, COUNT(*) AS reports, ' +
        'group_concat(DISTINCT reason) AS reasons, ' +
        'group_concat(DISTINCT target_nickname) AS names, ' +
        'MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM reports ' +
        "WHERE status = 'open' GROUP BY target_id, target_team_id) r " +
        'LEFT JOIN users u ON u.id = r.target_id LEFT JOIN teams t ON t.id = r.target_team_id ' +
        'ORDER BY r.reports DESC, r.first_at, r.target_id, r.target_team_id LIMIT ?2',
    )
    .bind(now, QUEUE_LIMIT)
    .all<QueueRow>();
  return results.map((row) => {
    const player = row.player !== null;
    return {
      kind: player ? 'player' : 'team',
      id: player ? row.player! : row.team!,
      reports: row.reports,
      reasons: split(row.reasons),
      reported: split(row.names),
      firstAt: row.first_at,
      lastAt: row.last_at,
      current: player ? row.nickname : row.team_name,
      reset: player ? row.nickname_reset_at !== null : row.team_reset_at !== null,
      createdAt: player ? row.user_created_at : row.team_created_at,
      priorBans: row.bans,
      banned: row.active_bans > 0,
      closed: !player && row.team_closed_at !== null,
      ownerId: player ? null : row.owner_id,
    };
  });
}

// ---- Players ------------------------------------------------------------------------------

export interface BanView {
  readonly id: number;
  readonly reason: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly liftedAt: number | null;
  /** In force now. */
  readonly active: boolean;
}

export interface PlayerView {
  readonly id: string;
  /** As stored: a reset one shows its placeholder. */
  readonly nickname: string | null;
  readonly nicknameReset: boolean;
  readonly createdAt: number;
  readonly openReports: number;
  readonly team: { readonly id: number; readonly name: string; readonly owner: boolean } | null;
  readonly bans: readonly BanView[];
}

type PlayerRow = {
  id: string;
  nickname: string | null;
  nickname_reset_at: number | null;
  created_at: number;
  team_id: number | null;
  team_name: string | null;
  team_owner: string | null;
};

type BanRow = {
  id: number;
  reason: string;
  created_at: number;
  expires_at: number | null;
  lifted_at: number | null;
};

const applies = (ban: BanRow, now: number) =>
  ban.lifted_at === null && (ban.expires_at === null || ban.expires_at > now);

async function bansOf(db: D1Database, player: string): Promise<BanRow[]> {
  const { results } = await db
    .prepare(
      'SELECT id, reason, created_at, expires_at, lifted_at FROM bans WHERE user_id = ? ' +
        'ORDER BY created_at DESC, id DESC',
    )
    .bind(player)
    .all<BanRow>();
  return results;
}

/** One account, its bans and its open reports; null when there is none. */
export async function playerView(
  db: D1Database,
  player: string,
  now: number,
): Promise<PlayerView | null> {
  const row = await db
    .prepare(
      'SELECT u.id, u.nickname, u.nickname_reset_at, u.created_at, t.id AS team_id, ' +
        't.name AS team_name, t.owner_id AS team_owner FROM users u ' +
        'LEFT JOIN team_players p ON p.user_id = u.id LEFT JOIN teams t ON t.id = p.team_id ' +
        'WHERE u.id = ?',
    )
    .bind(player)
    .first<PlayerRow>();
  if (!row) return null;
  return {
    id: row.id,
    nickname: row.nickname,
    nicknameReset: row.nickname_reset_at !== null,
    createdAt: row.created_at,
    openReports: await openReports(db, { player }),
    team:
      row.team_id !== null && row.team_name !== null
        ? { id: row.team_id, name: row.team_name, owner: row.team_owner === row.id }
        : null,
    bans: (await bansOf(db, player)).map((b) => ({
      id: b.id,
      reason: b.reason,
      createdAt: b.created_at,
      expiresAt: b.expires_at,
      liftedAt: b.lifted_at,
      active: applies(b, now),
    })),
  };
}

/** Accounts by id, or by nickname (any letter case) starting with `query`. */
export async function findPlayers(
  db: D1Database,
  query: string,
  now: number,
): Promise<PlayerView[]> {
  if (PLAYER_ID.test(query)) {
    const one = await playerView(db, query, now);
    return one ? [one] : [];
  }
  const key = query.toLowerCase();
  if (!/^[a-z0-9_]{1,20}$/.test(key)) return [];
  // Nickname keys hold [a-z0-9_] only, all below '~', so this range is a prefix match.
  const { results } = await db
    .prepare(
      'SELECT id FROM users WHERE nickname_key >= ? AND nickname_key < ? ' +
        'ORDER BY nickname_key LIMIT ?',
    )
    .bind(key, `${key}~`, SEARCH_LIMIT)
    .all<{ id: string }>();
  const views = await Promise.all(results.map((r) => playerView(db, r.id, now)));
  return views.filter((v): v is PlayerView => v !== null);
}

export type BanResult =
  | { readonly ok: true; readonly ban: number }
  | { readonly ok: false; readonly reason: 'already_banned' | 'not_found' };

/**
 * Bans `player` until `expiresAt` (null: until lifted), closing its open reports as actioned
 * when asked, in the same transaction and only with the ban. At most one ban applies at a
 * time: the insert checks it, so two moderators cannot both ban. `issuer` is the admin's
 * Access id, never their email.
 */
export async function banPlayer(
  db: D1Database,
  ban: {
    readonly player: string;
    readonly reason: string;
    readonly expiresAt: number | null;
    readonly issuer: string;
    readonly closeReports: boolean;
  },
  now: number,
): Promise<BanResult> {
  const { player, reason, expiresAt, issuer } = ban;
  const statements = [
    db
      .prepare(
        'INSERT INTO bans (user_id, reason, created_by, created_at, expires_at) ' +
          'SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1) ' +
          'AND NOT EXISTS (SELECT 1 FROM bans WHERE user_id = ?1 AND lifted_at IS NULL ' +
          'AND (expires_at IS NULL OR expires_at > ?4))',
      )
      .bind(player, reason, issuer, now, expiresAt),
  ];
  if (ban.closeReports) {
    statements.push(
      closeReports(db, { player }, 'actioned', now, {
        sql: 'EXISTS (SELECT 1 FROM bans WHERE user_id = ? AND created_at = ? AND created_by = ?)',
        values: [player, now, issuer],
      }),
    );
  }
  const [inserted] = await db.batch(statements);
  if ((inserted?.meta.changes ?? 0) > 0) {
    return { ok: true, ban: Number(inserted!.meta.last_row_id) };
  }
  const exists = await db.prepare('SELECT 1 AS one FROM users WHERE id = ?').bind(player).first();
  return { ok: false, reason: exists ? 'already_banned' : 'not_found' };
}

export type UnbanResult =
  | { readonly ok: true; readonly lifted: number }
  | { readonly ok: false; readonly reason: 'not_banned' | 'owner_only' };

/** Whether a ban in force on `player` is permanent; null when none applies. */
export async function activeBan(
  db: D1Database,
  player: string,
  now: number,
): Promise<{ readonly permanent: boolean; readonly expiresAt: number | null } | null> {
  const active = (await bansOf(db, player)).filter((b) => applies(b, now));
  if (active.length === 0) return null;
  const permanent = active.some((b) => b.expires_at === null);
  return {
    permanent,
    expiresAt: permanent ? null : Math.max(...active.map((b) => b.expires_at!)),
  };
}

/**
 * Lifts the bans in force on `player`. A permanent ban is lifted only by an owner
 * (`mayLiftPermanent`); the statement itself leaves permanent bans alone otherwise, so a
 * moderator's lift cannot catch one that appeared meanwhile.
 */
export async function unbanPlayer(
  db: D1Database,
  player: string,
  mayLiftPermanent: boolean,
  now: number,
): Promise<UnbanResult> {
  const result = await db
    .prepare(
      'UPDATE bans SET lifted_at = ?1 WHERE user_id = ?2 AND lifted_at IS NULL ' +
        `AND ${mayLiftPermanent ? '(expires_at IS NULL OR expires_at > ?1)' : 'expires_at > ?1'}`,
    )
    .bind(now, player)
    .run();
  const lifted = result.meta.changes;
  if (lifted > 0) return { ok: true, lifted };
  const left = await activeBan(db, player, now);
  return { ok: false, reason: left?.permanent ? 'owner_only' : 'not_banned' };
}

export type ResetResult =
  | { readonly ok: true; readonly name: string }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'no_nickname' | 'already_reset' | 'closed';
    };

/**
 * A reset, tried with the plain placeholder first. One chosen before the placeholders were
 * reserved could hold it already: then once more with a random suffix.
 */
async function withPlaceholder(
  run: (placeholder: string) => Promise<D1Result[]>,
  plain: string,
  suffixed: string,
): Promise<D1Result[]> {
  try {
    return await run(plain);
  } catch (error) {
    if (!String(error).includes('UNIQUE')) throw error;
    return run(suffixed);
  }
}

/**
 * Resets `player`'s nickname to `player_<n>` (n: the account's row number, unique). The
 * account then counts as having no nickname: it watches until it chooses one, and that choice
 * skips the 30-day limit (gateway) but may not be the removed name (`nickname_reset_key`).
 * Closes its open reports when asked.
 */
export async function resetNickname(
  db: D1Database,
  player: string,
  close: boolean,
  now: number,
): Promise<ResetResult> {
  const row = await db
    .prepare('SELECT nickname, nickname_reset_at FROM users WHERE id = ?')
    .bind(player)
    .first<{ nickname: string | null; nickname_reset_at: number | null }>();
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.nickname === null) return { ok: false, reason: 'no_nickname' };
  if (row.nickname_reset_at !== null) return { ok: false, reason: 'already_reset' };
  const results = await withPlaceholder(
    (placeholder) => {
      const statements = [
        db
          .prepare(
            // SET reads the old row: the removed name is kept, so it cannot come straight back.
            'UPDATE users SET nickname_reset_key = nickname_key, ' +
              `nickname = ${placeholder}, nickname_key = ${placeholder}, ` +
              'nickname_reset_at = ? WHERE id = ? AND nickname IS NOT NULL ' +
              'AND nickname_reset_at IS NULL',
          )
          .bind(now, player),
      ];
      if (close) {
        statements.push(
          closeReports(db, { player }, 'actioned', now, {
            sql: 'EXISTS (SELECT 1 FROM users WHERE id = ? AND nickname_reset_at = ?)',
            values: [player, now],
          }),
        );
      }
      return db.batch(statements);
    },
    "'player_' || rowid",
    "'player_' || rowid || '_' || (1000 + abs(random() % 9000))",
  );
  if ((results[0]?.meta.changes ?? 0) === 0) return { ok: false, reason: 'already_reset' };
  const after = await db
    .prepare('SELECT nickname FROM users WHERE id = ?')
    .bind(player)
    .first<{ nickname: string }>();
  return { ok: true, name: after?.nickname ?? '' };
}

// ---- Teams --------------------------------------------------------------------------------

export interface TeamView {
  readonly id: number;
  readonly name: string;
  readonly nameReset: boolean;
  readonly createdAt: number;
  readonly closedAt: number | null;
  /** The owner's account id; null once closed. */
  readonly ownerId: string | null;
  readonly members: number;
  readonly openReports: number;
}

type TeamRow = {
  id: number;
  name: string;
  name_reset_at: number | null;
  created_at: number;
  closed_at: number | null;
  owner_id: string | null;
  members: number;
};

const TEAM_SELECT =
  'SELECT t.id, t.name, t.name_reset_at, t.created_at, t.closed_at, t.owner_id, ' +
  '(SELECT COUNT(*) FROM team_players p WHERE p.team_id = t.id) AS members FROM teams t ';

async function teamViews(db: D1Database, rows: readonly TeamRow[]): Promise<TeamView[]> {
  return Promise.all(
    rows.map(async (t) => ({
      id: t.id,
      name: t.name,
      nameReset: t.name_reset_at !== null,
      createdAt: t.created_at,
      closedAt: t.closed_at,
      ownerId: t.owner_id,
      members: t.members,
      openReports: await openReports(db, { team: t.id }),
    })),
  );
}

export async function teamView(db: D1Database, team: number): Promise<TeamView | null> {
  const row = await db.prepare(`${TEAM_SELECT}WHERE t.id = ?`).bind(team).first<TeamRow>();
  return row ? ((await teamViews(db, [row]))[0] ?? null) : null;
}

/** Teams by id, or by name (any letter case) starting with `query`, open ones first. */
export async function findTeams(db: D1Database, query: string): Promise<TeamView[]> {
  if (/^[1-9]\d{0,9}$/.test(query)) {
    const one = await teamView(db, Number(query));
    return one ? [one] : [];
  }
  const key = query.toLowerCase();
  if (!/^[a-z0-9_]{1,20}$/.test(key)) return [];
  const { results } = await db
    .prepare(
      `${TEAM_SELECT}WHERE t.name_key >= ? AND t.name_key < ? ` +
        'ORDER BY t.closed_at IS NOT NULL, t.name_key, t.id LIMIT ?',
    )
    .bind(key, `${key}~`, SEARCH_LIMIT)
    .all<TeamRow>();
  return teamViews(db, results);
}

/** The statement that resets an open team's name to `placeholder` (SQL). */
function resetTeamStatement(db: D1Database, team: number, placeholder: string, now: number) {
  return db
    .prepare(
      'UPDATE teams SET name_reset_key = name_key, ' +
        `name = ${placeholder}, name_key = ${placeholder}, name_reset_at = ? ` +
        'WHERE id = ? AND closed_at IS NULL AND name_reset_at IS NULL',
    )
    .bind(now, team);
}

const TEAM_PLACEHOLDER = "'team_' || id";
const TEAM_PLACEHOLDER_SUFFIXED = "'team_' || id || '_' || (1000 + abs(random() % 9000))";

/**
 * Resets an open team's name to `team_<id>`; its owner may then choose a new one (gateway).
 * Closes its open reports when asked.
 */
export async function resetTeamName(
  db: D1Database,
  team: number,
  close: boolean,
  now: number,
): Promise<ResetResult> {
  const before = await teamView(db, team);
  if (!before) return { ok: false, reason: 'not_found' };
  if (before.closedAt !== null) return { ok: false, reason: 'closed' };
  if (before.nameReset) return { ok: false, reason: 'already_reset' };
  const results = await withPlaceholder(
    (placeholder) => {
      const statements = [resetTeamStatement(db, team, placeholder, now)];
      if (close) {
        statements.push(
          closeReports(db, { team }, 'actioned', now, {
            sql: 'EXISTS (SELECT 1 FROM teams WHERE id = ? AND name_reset_at = ?)',
            values: [team, now],
          }),
        );
      }
      return db.batch(statements);
    },
    TEAM_PLACEHOLDER,
    TEAM_PLACEHOLDER_SUFFIXED,
  );
  if ((results[0]?.meta.changes ?? 0) === 0) return { ok: false, reason: 'already_reset' };
  return { ok: true, name: (await teamView(db, team))?.name ?? '' };
}

export type CloseTeamResult =
  | { readonly ok: true; readonly name: string; readonly members: number }
  | { readonly ok: false; readonly reason: 'not_found' | 'closed' };

/**
 * Closes an open team as its owner leaving would (ADR 0020): members leave it with a free
 * next join, the owner leaves it, and the row keeps no link to the owner. Its cells stay on
 * the map and keep counting for it; it drops out of the ranking. With `resetName`, its name
 * is reset first (an offensive name must not stay on the closed team's page). Closes its open
 * reports when asked.
 */
export async function closeTeam(
  db: D1Database,
  team: number,
  options: { readonly resetName: boolean; readonly closeReports: boolean },
  now: number,
): Promise<CloseTeamResult> {
  const before = await teamView(db, team);
  if (!before) return { ok: false, reason: 'not_found' };
  if (before.closedAt !== null) return { ok: false, reason: 'closed' };
  const results = await withPlaceholder(
    (placeholder) => {
      const statements: D1PreparedStatement[] = [];
      if (options.resetName && !before.nameReset) {
        statements.push(resetTeamStatement(db, team, placeholder, now));
      }
      statements.push(
        db
          .prepare(
            'UPDATE team_players SET team_id = NULL, free_join = 1 WHERE team_id = ?1 AND ' +
              'user_id <> (SELECT owner_id FROM teams WHERE id = ?1 AND closed_at IS NULL)',
          )
          .bind(team),
        db.prepare('UPDATE team_players SET team_id = NULL WHERE team_id = ?').bind(team),
        db
          .prepare(
            'UPDATE teams SET closed_at = ?, owner_id = NULL WHERE id = ? AND closed_at IS NULL',
          )
          .bind(now, team),
      );
      if (options.closeReports) {
        statements.push(
          closeReports(db, { team }, 'actioned', now, {
            sql: 'EXISTS (SELECT 1 FROM teams WHERE id = ? AND closed_at = ?)',
            values: [team, now],
          }),
        );
      }
      return db.batch(statements);
    },
    TEAM_PLACEHOLDER,
    TEAM_PLACEHOLDER_SUFFIXED,
  );
  const closed = results.at(options.closeReports ? -2 : -1);
  if ((closed?.meta.changes ?? 0) === 0) return { ok: false, reason: 'closed' };
  return { ok: true, name: (await teamView(db, team))?.name ?? '', members: before.members };
}

// ---- Bot signals --------------------------------------------------------------------------

/** Most suspects the page lists, over every shard (each shard lists at most 100). */
const MAX_LISTED_SUSPECTS = 100;

/**
 * Accounts whose bot signals the current season's fanout shards flagged, and those they hold
 * for a Turnstile (FanoutDO.suspects, ADR 0026). Each account plays on one shard (ADR 0028),
 * which keeps its signals, so every shard there may be is asked and the lists merged, most
 * suspicious first: accounts held for a Turnstile, then by score. An account seen on two
 * shards (after FANOUT_SHARDS changed) is listed once, with its highest score and a pending
 * challenge kept. Read only: nothing acts on them by itself; a moderator looks, and bans or
 * rolls back by hand. `partial` when some shards could not be reached; null when none could.
 */
export async function suspects(
  env: Env,
  now: number,
): Promise<{ readonly players: Suspect[]; readonly partial: boolean } | null> {
  try {
    const canvas = await currentCanvas(env, now);
    const results = await Promise.allSettled(
      Array.from({ length: MAX_FANOUT_SHARDS }, async (_, shard) => {
        const stub = env.FANOUT.get(env.FANOUT.idFromName(fanoutName(canvas, shard)));
        return (await stub.suspects()).players;
      }),
    );
    const lists = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const failed = results.length - lists.length;
    if (lists.length === 0) {
      console.error(
        'admin: bot signals unavailable',
        (results[0] as PromiseRejectedResult | undefined)?.reason,
      );
      return null;
    }
    if (failed > 0) console.error(`admin: bot signals from ${failed} shards unavailable`);
    const merged = new Map<string, Suspect>();
    for (const p of lists.flat()) {
      const seen = merged.get(p.player);
      if (!seen) {
        merged.set(p.player, { ...p });
        continue;
      }
      const challengedAt = seen.challengedAt ?? p.challengedAt;
      merged.set(p.player, {
        ...(p.score > seen.score ? p : seen),
        ...(challengedAt === undefined ? {} : { challengedAt }),
      });
    }
    const players = [...merged.values()].sort(
      (a, b) =>
        Number(b.challengedAt !== undefined) - Number(a.challengedAt !== undefined) ||
        b.score - a.score,
    );
    return { players: players.slice(0, MAX_LISTED_SUSPECTS), partial: failed > 0 };
  } catch (error) {
    console.error('admin: bot signals unavailable', error);
    return null;
  }
}

// ---- Open sockets -------------------------------------------------------------------------

/**
 * Closes `player`'s open sockets on the current season's canvas (FanoutDO.kick), so a ban or a
 * reset reaches them at once instead of when their token expires (ADR 0015, 0023). Sockets of
 * a canvas that is no longer current cannot play anyway. Never throws: the account change is
 * already made, and the token's expiry stays the bound when the fanout cannot be reached.
 */
export async function kickPlayer(env: Env, player: string, now: number): Promise<boolean> {
  try {
    const canvas = await currentCanvas(env, now);
    // Every shard there may be (ADR 0028), as the gateway's kick: a change of FANOUT_SHARDS
    // leaves older sockets where they joined. Kicks are rare; this is 64 calls. Settled one by
    // one: a shard that cannot be reached never keeps the others from kicking.
    const results = await Promise.allSettled(
      Array.from({ length: MAX_FANOUT_SHARDS }, (_, shard) =>
        env.FANOUT.get(env.FANOUT.idFromName(fanoutName(canvas, shard))).kick(player),
      ),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.error(
        `admin: kick failed on ${failed.length} shards; their sockets stop playing when their token expires`,
        (failed[0] as PromiseRejectedResult).reason,
      );
    }
    return failed.length === 0;
  } catch (error) {
    console.error('admin: kick failed; open sockets stop playing when their token expires', error);
    return false;
  }
}
