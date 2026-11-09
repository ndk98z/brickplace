// Teams in D1 (ADR 0020): creating, joining and leaving, and the ranking the canvas feeds.
// Schema: migrations/0004_teams.sql. Times are ms since the epoch. Every rule that two
// requests could race past is a condition of the statement that applies it.

const DAY_MS = 24 * 60 * 60 * 1000;
/** A join (creating a team joins it) waits this long after the last one. Game rule, public. */
export const JOIN_EVERY_MS = 3 * DAY_MS;
/** A team may be created this long after the account's last one. Game rule, public. */
export const CREATE_EVERY_MS = 7 * DAY_MS;
/** Team colours index the 32-colour brick palette. */
export const TEAM_COLORS = 32;
/**
 * The canvas the ranking shows while no season is registered: Stage 0's. With seasons, the
 * current season's canvas is ranked instead (team-api.ts, ADR 0021).
 */
export const RANKED_CANVAS = 'canvas';
/** Teams in the ranking. */
export const RANKING_SIZE = 100;
/** Teams in one list or search answer. */
export const LIST_SIZE = 20;

/**
 * Team names and nicknames share one shape, and neither may equal the other in any letter case
 * (owner decision 2026-10-25, ADR 0020), so no team passes for a player and no player for a
 * team. Each is a subquery for the condition of the statement that writes the other, given the
 * SQL parameter holding the key (lower case): racing requests cannot both pass. Both use an
 * index (`users.nickname_key` UNIQUE, `teams_open_name`). A nickname reset to its placeholder
 * still holds `player_<n>`, which no team may take anyway (reserved).
 */
export const openTeamNamed = (param: string): string =>
  `SELECT 1 FROM teams WHERE name_key = ${param} AND closed_at IS NULL`;
export const nicknameHeld = (param: string): string =>
  `SELECT 1 FROM users WHERE nickname_key = ${param}`;

/** Where an account stands in the teams: its row of team_players and its team, if any. */
export interface Place {
  readonly team_id: number | null;
  readonly joined_at: number | null;
  readonly created_team_at: number | null;
  readonly free_join: number;
  readonly name: string | null;
  readonly color: number | null;
  readonly owner_id: string | null;
  readonly name_reset_at: number | null;
}

export interface MyTeam {
  readonly id: number;
  readonly name: string;
  readonly color: number;
  /** True when this account owns it: leaving closes it. */
  readonly owner: boolean;
  /**
   * True while a moderator's reset placeholder (`team_<id>`) stands in for its name (ADR
   * 0023): the owner should choose a new one (POST /api/teams/rename).
   */
  readonly nameReset: boolean;
}

export async function placeOf(db: D1Database, user: string): Promise<Place | null> {
  return db
    .prepare(
      'SELECT p.team_id, p.joined_at, p.created_team_at, p.free_join, t.name, t.color, ' +
        't.owner_id, t.name_reset_at FROM team_players p LEFT JOIN teams t ON t.id = p.team_id ' +
        'WHERE p.user_id = ?',
    )
    .bind(user)
    .first<Place>();
}

export function myTeam(place: Place | null, user: string): MyTeam | null {
  if (!place?.team_id || place.name === null || place.color === null) return null;
  return {
    id: place.team_id,
    name: place.name,
    color: place.color,
    owner: place.owner_id === user,
    nameReset: place.name_reset_at !== null,
  };
}

/**
 * An open team's name and owner, for a report on its name; null when it is closed, missing, or
 * its name is a moderator's placeholder (nothing to report until the owner picks a new one).
 */
export async function reportableTeam(
  db: D1Database,
  id: number,
): Promise<{ name: string; owner_id: string } | null> {
  return db
    .prepare(
      'SELECT name, owner_id FROM teams WHERE id = ? AND closed_at IS NULL ' +
        'AND name_reset_at IS NULL',
    )
    .bind(id)
    .first<{ name: string; owner_id: string }>();
}

/**
 * Gives the open team `owner` owns a new name, only while a moderator's reset placeholder
 * stands in for it (ADR 0023): team names are otherwise fixed. `taken` when an open team holds
 * the name in any letter case, or an account has it as its nickname; `blocked` for the name
 * the reset removed.
 */
export async function renameTeam(
  db: D1Database,
  owner: string,
  name: { name: string; key: string },
): Promise<'renamed' | 'not_reset' | 'taken' | 'blocked'> {
  try {
    const result = await db
      .prepare(
        'UPDATE teams SET name = ?1, name_key = ?2, name_reset_at = NULL WHERE owner_id = ?3 ' +
          'AND closed_at IS NULL AND name_reset_at IS NOT NULL ' +
          'AND (name_reset_key IS NULL OR name_reset_key <> ?2) ' +
          `AND NOT EXISTS (${nicknameHeld('?2')})`,
      )
      .bind(name.name, name.key, owner)
      .run();
    if (result.meta.changes > 0) return 'renamed';
    const removed = await db
      .prepare(
        'SELECT 1 AS one FROM teams WHERE owner_id = ? AND closed_at IS NULL ' +
          'AND name_reset_at IS NOT NULL AND name_reset_key = ?',
      )
      .bind(owner, name.key)
      .first();
    if (removed) return 'blocked';
    return (await db.prepare(nicknameHeld('?')).bind(name.key).first()) ? 'taken' : 'not_reset';
  } catch (error) {
    if (String(error).includes('UNIQUE')) return 'taken';
    throw error;
  }
}

/** When the account may join (or switch to) a team next: 0 when it may now. */
export function joinableAt(place: Place | null): number {
  if (!place || place.free_join === 1 || place.joined_at === null) return 0;
  return place.joined_at + JOIN_EVERY_MS;
}

/** When the account may create a team next: 0 when it may now (if it owns none). */
export function creatableAt(place: Place | null): number {
  const created = place?.created_team_at;
  return Math.max(joinableAt(place), created == null ? 0 : created + CREATE_EVERY_MS);
}

export type CreateResult =
  | { readonly ok: true; readonly team: number }
  | { readonly ok: false; readonly reason: 'taken' | 'owner' | 'too_soon' };

/**
 * Creates a team owned by `user` and moves them into it. Refused when the name is held by an
 * open team or is any account's nickname, its owner's included (any letter case: `taken`),
 * when they own an open team, or before both waits are over
 * (the 7-day one since their last creation and the 3-day one since their last join): those
 * conditions are part of the INSERT, and the unique indexes cover the rest.
 */
export async function createTeam(
  db: D1Database,
  user: string,
  team: { name: string; key: string; color: number },
  now: number,
): Promise<CreateResult> {
  try {
    const [inserted] = await db.batch([
      db
        .prepare(
          'INSERT INTO teams (name, name_key, color, owner_id, created_at) ' +
            'SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM team_players WHERE ' +
            'user_id = ? AND ((created_team_at IS NOT NULL AND created_team_at > ?) OR ' +
            '(free_join = 0 AND joined_at IS NOT NULL AND joined_at > ?))) ' +
            `AND NOT EXISTS (${nicknameHeld('?')})`,
        )
        .bind(
          team.name,
          team.key,
          team.color,
          user,
          now,
          user,
          now - CREATE_EVERY_MS,
          now - JOIN_EVERY_MS,
          team.key,
        ),
      // The team just made is this owner's only open one (unique index): join it.
      db
        .prepare(
          'INSERT INTO team_players (user_id, team_id, joined_at, created_team_at, free_join) ' +
            'SELECT ?, id, ?, ?, 0 FROM teams WHERE owner_id = ? AND closed_at IS NULL ' +
            'AND created_at = ? ON CONFLICT (user_id) DO UPDATE SET team_id = excluded.team_id, ' +
            'joined_at = excluded.joined_at, created_team_at = excluded.created_team_at, ' +
            'free_join = 0',
        )
        .bind(user, now, now, user, now),
    ]);
    if ((inserted?.meta.changes ?? 0) === 0) {
      const held = await db.prepare(nicknameHeld('?')).bind(team.key).first();
      return { ok: false, reason: held ? 'taken' : 'too_soon' };
    }
    return { ok: true, team: Number(inserted!.meta.last_row_id) };
  } catch (error) {
    const text = String(error);
    if (text.includes('UNIQUE')) {
      return { ok: false, reason: text.includes('owner_id') ? 'owner' : 'taken' };
    }
    throw error;
  }
}

export type JoinResult = 'joined' | 'already' | 'closed' | 'owner' | 'too_soon';

/**
 * Moves `user` into an open team, leaving the one they are in. Refused for a team that is
 * closed or missing, while they own an open team (they must close it first, by leaving), and
 * within 3 days of their last join unless their team closed under them. One statement.
 */
export async function joinTeam(
  db: D1Database,
  user: string,
  team: number,
  now: number,
): Promise<JoinResult> {
  const result = await db
    .prepare(
      'INSERT INTO team_players (user_id, team_id, joined_at, free_join) ' +
        'SELECT ?, id, ?, 0 FROM teams WHERE id = ? AND closed_at IS NULL ' +
        'AND NOT EXISTS (SELECT 1 FROM teams WHERE owner_id = ? AND closed_at IS NULL) ' +
        'AND NOT EXISTS (SELECT 1 FROM team_players WHERE user_id = ? AND team_id = ?) ' +
        'ON CONFLICT (user_id) DO UPDATE SET team_id = excluded.team_id, ' +
        'joined_at = excluded.joined_at, free_join = 0 WHERE team_players.free_join = 1 ' +
        'OR team_players.joined_at IS NULL OR team_players.joined_at <= ?',
    )
    .bind(user, now, team, user, user, team, now - JOIN_EVERY_MS)
    .run();
  if (result.meta.changes > 0) return 'joined';
  // Refused: say why (reads only; nothing changed).
  const place = await placeOf(db, user);
  if (place?.team_id === team) return 'already';
  const target = await db
    .prepare('SELECT closed_at FROM teams WHERE id = ?')
    .bind(team)
    .first<{ closed_at: number | null }>();
  if (!target || target.closed_at !== null) return 'closed';
  if (place && place.owner_id === user) return 'owner';
  return 'too_soon';
}

/**
 * The statements that close the team `user` owns, if any: its other members leave it with a
 * free next join, and the team keeps no link to its owner. Shared by leaving and deleting the
 * account; the owner's own row is the caller's to change.
 */
export function closeOwnedTeam(db: D1Database, user: string, now: number): D1PreparedStatement[] {
  return [
    db
      .prepare(
        'UPDATE team_players SET team_id = NULL, free_join = 1 WHERE user_id <> ? AND ' +
          'team_id = (SELECT id FROM teams WHERE owner_id = ? AND closed_at IS NULL)',
      )
      .bind(user, user),
    db
      .prepare(
        'UPDATE teams SET closed_at = ?, owner_id = NULL WHERE owner_id = ? AND closed_at IS NULL',
      )
      .bind(now, user),
  ];
}

/** Leaves the account's team; an owner leaving closes it. */
export async function leaveTeam(
  db: D1Database,
  user: string,
  now: number,
): Promise<'left' | 'closed' | 'none'> {
  const [, closed, left] = await db.batch([
    ...closeOwnedTeam(db, user, now),
    db
      .prepare('UPDATE team_players SET team_id = NULL WHERE user_id = ? AND team_id IS NOT NULL')
      .bind(user),
  ]);
  if ((closed?.meta.changes ?? 0) > 0) return 'closed';
  return (left?.meta.changes ?? 0) > 0 ? 'left' : 'none';
}

/** What deleting an account does to teams: closes the one it owns and drops its row. */
export function teamsOnDeletion(db: D1Database, user: string, now: number): D1PreparedStatement[] {
  return [
    ...closeOwnedTeam(db, user, now),
    db.prepare('DELETE FROM team_players WHERE user_id = ?').bind(user),
  ];
}

export interface TeamSummary {
  readonly id: number;
  readonly name: string;
  readonly color: number;
  readonly members: number;
  /** Cells standing on the ranked canvas. */
  readonly cells: number;
}

export interface RankedTeam extends TeamSummary {
  readonly rank: number;
  readonly built: number;
  readonly cleared: number;
  readonly shields: number;
  /**
   * Closed since (only in a past season's ranking): named CLOSED_TEAM_NAME, not by its own name,
   * which no report or reset can reach once the team is closed; no members.
   */
  readonly closed: boolean;
}

/** What a past season's ranking calls a team closed since (owner decision, 2026-10-26). */
export const CLOSED_TEAM_NAME = 'A closed team';

export interface Ranking {
  readonly canvas: string;
  /** When the newest standing in it was written by the canvas (ms); null when empty. */
  readonly updatedAt: number | null;
  readonly teams: readonly RankedTeam[];
}

/**
 * Standings read per page for the ranking: the standings live in their own database (ADR
 * 0020), so closed teams can only be dropped after their rows are read, and the next page is
 * read while fewer than RANKING_SIZE open teams have been found.
 */
export const STANDINGS_READ = 200;
/**
 * Pages read at most: a bound on one ranking's reads, not a tuning knob. Only with more than
 * STANDINGS_READ × STANDINGS_PAGES − RANKING_SIZE closed teams near the top does the ranking
 * show fewer teams.
 */
export const STANDINGS_PAGES = 10;

const MEMBERS = '(SELECT COUNT(*) FROM team_players p WHERE p.team_id = t.id) AS members';

interface Standing {
  readonly team_id: number;
  readonly cells: number;
  readonly built: number;
  readonly cleared: number;
  readonly shields: number;
  readonly updated_at: number;
}

interface TeamRow {
  readonly id: number;
  readonly name: string;
  readonly color: number;
  readonly closed_at: number | null;
  readonly members: number;
}

const STANDING_COLUMNS = 'team_id, cells, built, cleared, shields, updated_at';

/**
 * Teams by id from the accounts database, members counted for these rows only, or not at all
 * (0) when `members` is false.
 */
async function teamsByIds(accounts: D1Database, ids: readonly number[], members = true) {
  if (ids.length === 0) return new Map<number, TeamRow>();
  // One JSON parameter: D1 caps bound parameters at 100.
  const { results } = await accounts
    .prepare(
      `SELECT t.id, t.name, t.color, t.closed_at, ${members ? MEMBERS : '0 AS members'} ` +
        'FROM teams t ' +
        'WHERE t.id IN (SELECT value FROM json_each(?))',
    )
    .bind(JSON.stringify(ids))
    .all<TeamRow>();
  return new Map(results.map((row) => [row.id, row]));
}

/** Standings by team id on one canvas, from the standings database. */
async function standingsOf(standings: D1Database, canvas: string, ids: readonly number[]) {
  if (ids.length === 0) return new Map<number, Standing>();
  const { results } = await standings
    .prepare(
      `SELECT ${STANDING_COLUMNS} FROM team_standings WHERE canvas = ? ` +
        'AND team_id IN (SELECT value FROM json_each(?))',
    )
    .bind(canvas, JSON.stringify(ids))
    .all<Standing>();
  return new Map(results.map((row) => [row.team_id, row]));
}

/** Where a standing sorts in the ranking: by cells, then built, then team id. */
type RankKey = Pick<Standing, 'cells' | 'built' | 'team_id'>;

/**
 * Open teams in ranking order with their standings, at most `want`: a page of standings at a
 * time (after the last row read, never an offset), then the names and closed flags of that
 * page from accounts, until `want` open teams are found or the standings run out. With
 * `before`, only the teams that sort ahead of that standing. `complete` is false when `pages`
 * (STANDINGS_PAGES but in tests) ran out first, so an open team may be missing. Without
 * `members` nobody is counted (0), for callers that need only the order. With `closed`, teams
 * closed since keep their place (a past season's ranking: they built its map).
 */
async function openStandings(
  accounts: D1Database,
  standings: D1Database,
  canvas: string,
  options: {
    readonly want: number;
    readonly members: boolean;
    readonly before?: RankKey;
    readonly pages: number;
    readonly closed?: boolean;
  },
): Promise<{ teams: { standing: Standing; team: TeamRow }[]; complete: boolean }> {
  const { want, members, before, pages, closed = false } = options;
  const found: { standing: Standing; team: TeamRow }[] = [];
  let after: RankKey | null = null;
  for (let page = 0; page < pages; page++) {
    const where = ['canvas = ?', 'cells > 0'];
    const values: unknown[] = [canvas];
    if (after) {
      where.push('(cells < ? OR (cells = ? AND (built < ? OR (built = ? AND team_id > ?))))');
      values.push(after.cells, after.cells, after.built, after.built, after.team_id);
    }
    if (before) {
      where.push('(cells > ? OR (cells = ? AND (built > ? OR (built = ? AND team_id < ?))))');
      values.push(before.cells, before.cells, before.built, before.built, before.team_id);
    }
    const { results: rows } = await standings
      .prepare(
        `SELECT ${STANDING_COLUMNS} FROM team_standings WHERE ${where.join(' AND ')} ` +
          'ORDER BY cells DESC, built DESC, team_id LIMIT ?',
      )
      .bind(...values, STANDINGS_READ)
      .all<Standing>();
    const named = await teamsByIds(
      accounts,
      rows.map((s) => s.team_id),
      members,
    );
    for (const standing of rows) {
      const team = named.get(standing.team_id);
      // Closed teams drop out of a live ranking: their cells stay on the map and count for no
      // one else.
      if (!team || (team.closed_at !== null && !closed)) continue;
      found.push({ standing, team });
      if (found.length === want) return { teams: found, complete: true };
    }
    if (rows.length < STANDINGS_READ) return { teams: found, complete: true };
    after = rows.at(-1)!;
  }
  return { teams: found, complete: false };
}

/**
 * Open teams by cells standing on the canvas; ties share a rank (1, 2, 2, 4). The standings
 * come from the standings database, names and closed flags from accounts, a page at a time
 * until RANKING_SIZE open teams are found, so closed teams near the top do not crowd open ones
 * out. With `closed` (a season that is over), teams closed since keep their place, marked
 * closed and named CLOSED_TEAM_NAME. `pages` is for tests.
 */
export async function ranking(
  accounts: D1Database,
  standings: D1Database,
  canvas: string,
  pages = STANDINGS_PAGES,
  closed = false,
): Promise<Ranking> {
  const { teams: open } = await openStandings(accounts, standings, canvas, {
    want: RANKING_SIZE,
    members: true,
    pages,
    closed,
  });
  let updatedAt: number | null = null;
  const teams: RankedTeam[] = [];
  for (const { standing, team } of open) {
    updatedAt = Math.max(updatedAt ?? 0, standing.updated_at);
    const previous = teams.at(-1);
    const rank = previous && previous.cells === standing.cells ? previous.rank : teams.length + 1;
    const closedSince = team.closed_at !== null;
    teams.push({
      rank,
      id: team.id,
      // A closed team's name is past every report and reset: it is not shown again.
      name: closedSince ? CLOSED_TEAM_NAME : team.name,
      color: team.color,
      members: team.members,
      cells: standing.cells,
      built: standing.built,
      cleared: standing.cleared,
      shields: standing.shields,
      closed: closedSince,
    });
  }
  return { canvas, updatedAt, teams };
}

/**
 * Open teams to join, by cells standing: the first LIST_SIZE whose name starts with `prefix`
 * (any letter case, in name order), or, without one, the top of the ranking topped up with the
 * newest open teams.
 */
export async function listTeams(
  accounts: D1Database,
  standings: D1Database,
  canvas: string,
  prefix: string,
): Promise<TeamSummary[]> {
  const out: TeamSummary[] = [];
  if (!prefix) {
    const top = await ranking(accounts, standings, canvas);
    for (const { id, name, color, members, cells } of top.teams.slice(0, LIST_SIZE)) {
      out.push({ id, name, color, members, cells });
    }
    if (out.length === LIST_SIZE) return out;
  }
  const key = prefix.toLowerCase();
  // Name keys hold [a-z0-9_] only, all below '~', so this range is a prefix match.
  const { results } = await accounts
    .prepare(
      // Cut in a derived table first, so members are counted for the returned rows only.
      `SELECT t.*, ${MEMBERS} FROM (SELECT id, name, color FROM teams WHERE closed_at IS NULL ` +
        (key ? 'AND name_key >= ? AND name_key < ? ORDER BY name_key ' : 'ORDER BY id DESC ') +
        'LIMIT ?) t',
    )
    .bind(...(key ? [key, `${key}~`] : []), LIST_SIZE)
    .all<Omit<TeamSummary, 'cells'>>();
  const fresh = results.filter((team) => !out.some((t) => t.id === team.id));
  const cells = await standingsOf(
    standings,
    canvas,
    fresh.map((t) => t.id),
  );
  for (const team of fresh) out.push({ ...team, cells: cells.get(team.id)?.cells ?? 0 });
  // A stable sort: ties keep the ranking's order, or name order for a search.
  return out.slice(0, LIST_SIZE).sort((a, b) => b.cells - a.cells);
}

export interface TeamDetail extends TeamSummary {
  readonly owner: string | null;
  readonly createdAt: number;
  readonly closedAt: number | null;
  readonly built: number;
  readonly cleared: number;
  readonly shields: number;
  /** Place in the ranking; null while closed, without cells, or outside the ranking. */
  readonly rank: number | null;
}

/**
 * One team, open or closed, with its owner's nickname and its standing; null if none. A closed
 * team is named CLOSED_TEAM_NAME, as in a past ranking: no report or reset reaches its name.
 * `pages` is for tests, and must match the ranking's.
 */
export async function teamDetail(
  accounts: D1Database,
  standings: D1Database,
  canvas: string,
  id: number,
  pages = STANDINGS_PAGES,
): Promise<TeamDetail | null> {
  const row = await accounts
    .prepare(
      `SELECT t.id, t.name, t.color, t.created_at, t.closed_at, u.nickname AS owner, ${MEMBERS} ` +
        'FROM teams t LEFT JOIN users u ON u.id = t.owner_id WHERE t.id = ?',
    )
    .bind(id)
    .first<{
      id: number;
      name: string;
      color: number;
      created_at: number;
      closed_at: number | null;
      owner: string | null;
      members: number;
    }>();
  if (!row) return null;
  const standing = (await standingsOf(standings, canvas, [id])).get(id);
  // The ranking's own rule, so the two pages always agree, read only for the teams ahead of
  // this one: in the ranking while fewer than RANKING_SIZE open teams sort ahead of it, and
  // ranked one after those with more cells (ties share a rank).
  let rank: number | null = null;
  if (row.closed_at === null && standing && standing.cells > 0) {
    const ahead = await openStandings(accounts, standings, canvas, {
      want: RANKING_SIZE,
      members: false,
      before: standing,
      pages,
    });
    if (ahead.complete && ahead.teams.length < RANKING_SIZE) {
      rank = ahead.teams.filter((t) => t.standing.cells > standing.cells).length + 1;
    }
  }
  return {
    id: row.id,
    name: row.closed_at === null ? row.name : CLOSED_TEAM_NAME,
    color: row.color,
    owner: row.owner,
    members: row.members,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    cells: standing?.cells ?? 0,
    built: standing?.built ?? 0,
    cleared: standing?.cleared ?? 0,
    shields: standing?.shields ?? 0,
    rank,
  };
}
