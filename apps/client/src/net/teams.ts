// The teams API of the gateway (ADR 0020). The server decides every rule; this only asks,
// shows, and words the answers.

import { seasonParam } from '../game/share.ts';
import { type Me, NICKNAME_PATTERN, nicknameProblem } from './account.ts';

/** The account's own team, as /api/me and every team change report it. */
export interface MyTeam {
  readonly id: number;
  readonly name: string;
  /** Index into the brick palette. */
  readonly color: number;
  /** True for its owner: leaving closes it for everyone. */
  readonly owner: boolean;
  /**
   * True while a moderator's placeholder (`team_<id>`) stands in for its name (ADR 0023); its
   * owner may then choose a new one (POST /api/teams/rename).
   */
  readonly nameReset?: boolean;
}

export interface TeamSummary {
  readonly id: number;
  readonly name: string;
  readonly color: number;
  readonly members: number;
  /** Cells standing on the map. */
  readonly cells: number;
}

export interface RankedTeam extends TeamSummary {
  readonly rank: number;
  readonly built: number;
  readonly cleared: number;
  readonly shields: number;
  /**
   * Closed since the season (only in a past season's ranking, named "A closed team" by the
   * gateway); missing from older gateways.
   */
  readonly closed?: boolean;
}

export interface Ranking {
  readonly canvas: string;
  readonly updatedAt: number | null;
  readonly teams: readonly RankedTeam[];
  /** A season asked by id that is over: its teams closed since are in it, marked closed. */
  readonly over?: boolean;
}

export interface TeamDetail extends TeamSummary {
  /** The owner's nickname; null once closed. */
  readonly owner: string | null;
  readonly createdAt: number;
  readonly closedAt: number | null;
  readonly built: number;
  readonly cleared: number;
  readonly shields: number;
  readonly rank: number | null;
}

export type TeamError =
  | 'too_short'
  | 'too_long'
  | 'characters'
  | 'blocked'
  | 'taken'
  | 'color'
  | 'too_soon'
  | 'owner'
  | 'closed'
  | 'not_reset'
  | 'no_nickname'
  | 'unavailable'
  | 'signed_out'
  | 'csrf';

export type TeamChange =
  | { readonly ok: true; readonly me: Me }
  | { readonly ok: false; readonly error: TeamError; readonly retryAt?: number };

/** Team names follow the nickname rules (ADR 0016, 0020). */
export const TEAM_NAME_PATTERN = NICKNAME_PATTERN;

/** The obvious name problems, before asking the server. */
export function teamNameProblem(name: string): TeamError | null {
  return nicknameProblem(name);
}

/** "2d 4h", "3h 10m", "12m", or "a minute", for waits shown to players. */
export function waitText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return minutes === 1 ? 'a minute' : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function teamMessage(error: TeamError, retryAt?: number, now = Date.now()): string {
  switch (error) {
    case 'too_short':
      return 'Use at least 3 characters.';
    case 'too_long':
      return 'Use at most 20 characters.';
    case 'characters':
      return 'Use letters, numbers or _ only, without spaces.';
    case 'blocked':
      return 'That name is not allowed. Try another one.';
    case 'taken':
      return 'A team or a player already has that name.';
    case 'color':
      return 'Pick a colour.';
    case 'too_soon':
      return retryAt && retryAt > now
        ? `You can do that again in ${waitText(retryAt - now)}.`
        : 'You can join a team every 3 days and create one every 7 days.';
    case 'owner':
      return 'You own your team. Close it first: leaving closes it for everyone.';
    case 'closed':
      return 'That team has closed.';
    case 'not_reset':
      return 'Your team already has its new name.';
    case 'no_nickname':
      return 'Pick a nickname before joining a team.';
    case 'unavailable':
      return 'Teams cannot be changed right now. Try again in a minute.';
    case 'signed_out':
    case 'csrf':
      return 'Your sign-in ended. Sign in again to continue.';
  }
}

/** The button beside a team in the list: joining is one click, switching asks again. */
export function joinLabel(mine: number | null, team: number, confirming: boolean): string {
  if (mine === team) return 'Your team';
  if (mine === null) return 'Join';
  return confirming ? 'Confirm switch' : 'Switch';
}

/** Says how long until the account may join or switch again; null when it may now. */
export function switchNotice(joinableAt: number | undefined, now = Date.now()): string | null {
  if (!joinableAt || joinableAt <= now) return null;
  return `You can switch teams again in ${waitText(joinableAt - now)}.`;
}

/** Says how long until the account may create a team; null when it may now. */
export function createNotice(creatableAt: number | undefined, now = Date.now()): string | null {
  if (!creatableAt || creatableAt <= now) return null;
  return `You can create a team again in ${waitText(creatableAt - now)}.`;
}

/** A link that opens the team screen on this team. */
export function inviteLink(origin: string, team: number): string {
  return `${origin}/?team=${team}`;
}

/** The team id of an invite link's `?team=`, or null. */
export function invitedTeam(params: URLSearchParams): number | null {
  const value = params.get('team');
  return value && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : null;
}

/** Whole numbers the way the design shows them: 28,914. */
export function count(n: number): string {
  return n.toLocaleString('en-US');
}

/** "1 member", "154 members". */
export function memberCount(n: number): string {
  return `${count(n)} ${n === 1 ? 'member' : 'members'}`;
}

async function getJson<T>(fetcher: typeof fetch, path: string): Promise<T | null> {
  try {
    const response = await fetcher(path, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

/** The current season's ranking, or a past season's by id; null when it cannot be read. */
export async function fetchRanking(
  fetcher: typeof fetch = fetch,
  season: number | null = null,
): Promise<Ranking | null> {
  return getJson<Ranking>(
    fetcher,
    season === null ? '/api/teams/ranking' : `/api/teams/ranking?season=${season}`,
  );
}

/**
 * The ranking screen's line under its title and its empty state: the current season, a
 * season asked by id that is still under way, or one that is over (`over`, from the gateway).
 */
export function rankingCopy(
  season: number | null,
  over: boolean,
): { readonly sub: string; readonly empty: string } {
  if (season !== null && over) {
    return {
      sub: `Season ${season} · ranked by cells each team built that were still standing at the end`,
      empty: `No team had cells standing at the end of Season ${season}.`,
    };
  }
  return {
    sub: `${season === null ? 'This season' : `Season ${season}`} · ranked by cells your team built that are still standing · updated every minute`,
    empty: 'No team has cells standing yet. Build some for yours!',
  };
}

/** `?ranking=<id>`: the page opens on that season's ranking (the timelapse links there). */
export function rankingSeasonOf(params: URLSearchParams): number | null {
  return seasonParam(params, 'ranking');
}

export async function fetchTeams(
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<TeamSummary[] | null> {
  const q = query.trim();
  const body = await getJson<{ teams: TeamSummary[] }>(
    fetcher,
    q ? `/api/teams?q=${encodeURIComponent(q)}` : '/api/teams',
  );
  return body?.teams ?? null;
}

export async function fetchTeam(
  id: number,
  fetcher: typeof fetch = fetch,
): Promise<TeamDetail | null> {
  return (await getJson<{ team: TeamDetail }>(fetcher, `/api/teams/${id}`))?.team ?? null;
}

async function change(
  fetcher: typeof fetch,
  path: string,
  csrf: string,
  body: unknown,
): Promise<TeamChange> {
  try {
    const response = await fetcher(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(body),
    });
    const answer = (await response.json()) as Me & { error?: TeamError; retryAt?: number };
    if (response.ok) return { ok: true, me: answer };
    return {
      ok: false,
      error: answer.error ?? 'unavailable',
      ...(answer.retryAt ? { retryAt: answer.retryAt } : {}),
    };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

export function createTeam(
  csrf: string,
  name: string,
  color: number,
  fetcher: typeof fetch = fetch,
): Promise<TeamChange> {
  return change(fetcher, '/api/teams', csrf, { name: name.trim(), color });
}

export function joinTeam(csrf: string, id: number, fetcher: typeof fetch = fetch) {
  return change(fetcher, `/api/teams/${id}/join`, csrf, {});
}

export function leaveTeam(csrf: string, fetcher: typeof fetch = fetch) {
  return change(fetcher, '/api/teams/leave', csrf, {});
}

/** The owner's new name for a team a moderator reset (ADR 0023); otherwise names are fixed. */
export function renameTeam(csrf: string, name: string, fetcher: typeof fetch = fetch) {
  return change(fetcher, '/api/teams/rename', csrf, { name: name.trim() });
}

/** True when the account owns a team whose name a moderator reset: it should pick a new one. */
export function needsTeamName(user: Me['user'] | undefined): boolean {
  const team = user?.team;
  return team?.owner === true && team.nameReset === true;
}

/** Why a team-name report was not taken (ADR 0023): the report API's codes. */
export type TeamReportError =
  | 'not_found'
  | 'self'
  | 'already_reported'
  | 'too_many'
  | 'no_nickname'
  | 'unavailable'
  | 'signed_out'
  | 'csrf';

/** POST /api/reports {team, reason: 'team_name'}; `sent` or the server's error code. */
export async function reportTeamName(
  csrf: string,
  team: number,
  fetcher: typeof fetch = fetch,
): Promise<'sent' | TeamReportError> {
  try {
    const response = await fetcher('/api/reports', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ team, reason: 'team_name' }),
    });
    if (response.ok) return 'sent';
    const body = (await response.json().catch(() => ({}))) as { error?: TeamReportError };
    return body.error ?? 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export function teamReportMessage(result: 'sent' | TeamReportError): string {
  switch (result) {
    case 'sent':
      return 'Thanks. A moderator will look at that team name.';
    case 'not_found':
      return 'That team has closed.';
    case 'self':
      return 'That is your own team.';
    case 'already_reported':
      return 'You already reported this team name. A moderator will look at it.';
    case 'too_many':
      return 'You have sent a lot of reports today. Try again tomorrow.';
    case 'no_nickname':
      return 'Pick your own nickname before reporting others.';
    case 'signed_out':
    case 'csrf':
      return 'Your sign-in ended. Sign in again to continue.';
    // `unavailable`, and any code a newer server sends that this build does not know.
    default:
      return 'Reports cannot be sent right now. Try again in a minute.';
  }
}

/**
 * True for a name a moderator reset to its placeholder (`team_<id>`, a shape no player may
 * choose, ADR 0023): there is nothing to report until the owner picks a new one.
 */
export function placeholderTeamName(name: string): boolean {
  return /^team_\d/i.test(name);
}
