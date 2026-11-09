import { describe, expect, it } from 'vitest';
import type { AccountState } from '../src/game/account.ts';
import { Teams, type TeamsAccount } from '../src/game/teams.ts';
import type { Me } from '../src/net/account.ts';
import {
  count,
  createNotice,
  invitedTeam,
  inviteLink,
  joinLabel,
  type MyTeam,
  memberCount,
  needsTeamName,
  placeholderTeamName,
  rankingCopy,
  rankingSeasonOf,
  switchNotice,
  type TeamDetail,
  type TeamReportError,
  teamMessage,
  teamReportMessage,
  waitText,
} from '../src/net/teams.ts';
import { Observable } from '../src/ui/observable.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('team copy', () => {
  it('words waits the way the design does', () => {
    expect(waitText(1)).toBe('a minute');
    expect(waitText(12 * MINUTE)).toBe('12m');
    expect(waitText(3 * HOUR + 10 * MINUTE)).toBe('3h 10m');
    expect(waitText(2 * DAY + 4 * HOUR)).toBe('2d 4h');
    expect(switchNotice(0, 1_000)).toBeNull();
    expect(switchNotice(undefined)).toBeNull();
    expect(switchNotice(1_000 + 2 * DAY + 4 * HOUR, 1_000)).toBe(
      'You can switch teams again in 2d 4h.',
    );
    expect(createNotice(1_000 + 6 * DAY, 1_000)).toBe('You can create a team again in 6d 0h.');
    expect(teamMessage('too_soon', 1_000 + 5 * MINUTE, 1_000)).toBe('You can do that again in 5m.');
    expect(teamMessage('owner')).toMatch(/Close it first/);
    expect(count(28914)).toBe('28,914');
    expect(memberCount(1)).toBe('1 member');
    expect(memberCount(1540)).toBe('1,540 members');
  });

  it('asks again before a switch, never before a first join', () => {
    expect(joinLabel(null, 4, false)).toBe('Join');
    expect(joinLabel(4, 4, false)).toBe('Your team');
    expect(joinLabel(3, 4, false)).toBe('Switch');
    expect(joinLabel(3, 4, true)).toBe('Confirm switch');
  });

  it('reads and writes invite links', () => {
    expect(inviteLink('https://brickplace.test', 12)).toBe('https://brickplace.test/?team=12');
    expect(invitedTeam(new URLSearchParams('team=12'))).toBe(12);
    expect(invitedTeam(new URLSearchParams('team=0'))).toBeNull();
    expect(invitedTeam(new URLSearchParams('team=12x'))).toBeNull();
    expect(invitedTeam(new URLSearchParams(''))).toBeNull();
  });
});

const signedIn = (nickname: string | null, team: MyTeam | null = null): Me => ({
  signedIn: true,
  csrf: 'c',
  config: { providers: ['dev'], turnstileSiteKey: null, devGuest: false },
  user: {
    nickname,
    suggestedNickname: 'Someone',
    nicknameChangeableAt: null,
    email: null,
    linkUntil: 0,
    identities: [],
    team,
    teamJoinableAt: 0,
    teamCreatableAt: 0,
  },
});

const detail = (id: number, name = `Team${id}`): TeamDetail => ({
  id,
  name,
  color: 3,
  members: 2,
  cells: 10,
  owner: 'Owner',
  createdAt: 1,
  closedAt: null,
  built: 12,
  cleared: 1,
  shields: 0,
  rank: 1,
});

/** A fake account and gateway: records what was opened, adopted and asked. */
function setup(
  me: Me,
  answers: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {},
) {
  const opened: string[] = [];
  const adopted: { me: Me; reconnect?: boolean }[] = [];
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const state = new Observable<AccountState>({
    me,
    dialog: null,
    reportTarget: '',
    reportReturn: null,
  });
  const account: TeamsAccount = {
    state,
    adopt(next, reconnect) {
      adopted.push({ me: next, reconnect });
      state.update({ me: next });
    },
    open(dialog) {
      opened.push(dialog);
    },
    openReport(nickname) {
      opened.push(`report:${nickname}`);
    },
  };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({
      path,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const answer = answers[path] ?? answers[path.split('?')[0]!];
    return answer ? answer(init) : Response.json({ error: 'not_found' }, { status: 404 });
  }) as typeof fetch;
  return { teams: new Teams(account, fetcher), opened, adopted, calls };
}

describe('the team screens', () => {
  it('loads the ranking, or says it cannot', async () => {
    const ranking = { canvas: 'canvas', updatedAt: 5, teams: [] };
    const { teams } = setup(signedIn('Ann'), {
      '/api/teams/ranking': () => Response.json(ranking),
    });
    await teams.openRanking();
    expect(teams.state.get()).toMatchObject({ screen: 'ranking', ranking, rankingFailed: false });
    const broken = setup(signedIn('Ann')).teams;
    await broken.openRanking();
    expect(broken.state.get()).toMatchObject({ screen: 'ranking', rankingFailed: true });
  });

  it("loads a past season's ranking, never showing another season's meanwhile", async () => {
    const current = { canvas: 's3', updatedAt: 5, teams: [] };
    const past = { canvas: 's2', updatedAt: 4, teams: [] };
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { teams, calls } = setup(signedIn('Ann'), {
      '/api/teams/ranking?season=2': async () => {
        await slow;
        return Response.json(past);
      },
      '/api/teams/ranking': () => Response.json(current),
    });
    await teams.openRanking();
    expect(teams.state.get()).toMatchObject({ ranking: current, rankingSeason: null });
    // Season 2 asked: the current ranking is not left under its title while it loads.
    const loading = teams.openRanking(2);
    expect(teams.state.get()).toMatchObject({ ranking: null, rankingSeason: 2 });
    // Back to the current season before season 2 answers: its late answer is dropped.
    await teams.openRanking();
    release();
    await loading;
    expect(teams.state.get()).toMatchObject({ ranking: current, rankingSeason: null });
    expect(calls.map((c) => c.path)).toEqual([
      '/api/teams/ranking',
      '/api/teams/ranking?season=2',
      '/api/teams/ranking',
    ]);
  });

  it("words a past season's ranking apart from one under way", () => {
    expect(rankingCopy(null, false).sub).toMatch(/^This season · .*updated every minute$/);
    // Asked by id while still under way (a `?ranking=` of the live season): still live.
    expect(rankingCopy(3, false).sub).toMatch(/^Season 3 · .*updated every minute$/);
    expect(rankingCopy(3, false).empty).toBe(rankingCopy(null, false).empty);
    const over = rankingCopy(2, true);
    expect(over.sub).toBe(
      'Season 2 · ranked by cells each team built that were still standing at the end',
    );
    expect(over.empty).toBe('No team had cells standing at the end of Season 2.');
  });

  it('opens a season ranking only from a well-formed `?ranking=`', () => {
    expect(rankingSeasonOf(new URLSearchParams('ranking=2'))).toBe(2);
    for (const value of ['0', '-1', '2.5', 'x', '', '1234567890']) {
      expect(rankingSeasonOf(new URLSearchParams({ ranking: value })), value).toBeNull();
    }
    expect(rankingSeasonOf(new URLSearchParams(''))).toBeNull();
  });

  it('sends a signed-out visitor to sign in, and an account without a nickname to pick one', async () => {
    const out = setup({ ...signedIn(null), signedIn: false, user: null, csrf: null });
    expect(await out.teams.join(4)).toBe(false);
    expect(out.opened).toEqual(['signin']);
    const unnamed = setup(signedIn(null));
    expect(await unnamed.teams.join(4)).toBe(false);
    expect(unnamed.opened).toEqual(['nickname']);
    expect(unnamed.calls).toEqual([]);
  });

  it('joins a team, takes the new account view and plays on a new socket', async () => {
    const joined = signedIn('Ann', { id: 4, name: 'Team4', color: 3, owner: false });
    const { teams, adopted, calls } = setup(signedIn('Ann'), {
      '/api/teams/4/join': () => Response.json(joined),
      '/api/teams/4': () => Response.json({ team: detail(4) }),
      '/api/teams': () => Response.json({ teams: [detail(4)] }),
    });
    await teams.openTeam();
    expect(teams.state.get().mine).toBeNull();
    expect(await teams.join(4)).toBe(true);
    expect(adopted).toEqual([{ me: joined, reconnect: true }]);
    expect(teams.state.get()).toMatchObject({ busy: false, message: null, mine: detail(4) });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post).toMatchObject({ path: '/api/teams/4/join', body: {} });
  });

  it('shows why a change was refused, and checks a name before sending it', async () => {
    const { teams, calls } = setup(signedIn('Ann'), {
      '/api/teams/9/join': () =>
        Response.json({ error: 'too_soon', retryAt: Date.now() + 2 * DAY + HOUR }, { status: 429 }),
    });
    expect(await teams.join(9)).toBe(false);
    expect(teams.state.get().message).toMatch(/^You can do that again in 2d 1h\.$|in 2d 0h\.$/);
    expect(await teams.create('no spaces', 3)).toBe(false);
    expect(teams.state.get().message).toBe('Use letters, numbers or _ only, without spaces.');
    expect(calls.filter((c) => c.path === '/api/teams' && c.method === 'POST')).toEqual([]);
  });

  it('creates a team with its colour', async () => {
    const owned = signedIn('Ann', { id: 8, name: 'Crew_8', color: 21, owner: true });
    const { teams, calls, adopted } = setup(signedIn('Ann'), {
      '/api/teams': (init) =>
        init?.method === 'POST'
          ? Response.json(owned, { status: 201 })
          : Response.json({ teams: [] }),
      '/api/teams/8': () => Response.json({ team: detail(8, 'Crew_8') }),
    });
    expect(await teams.create(' Crew_8 ', 21)).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { name: 'Crew_8', color: 21 } });
    expect(adopted[0]!.me.user!.team).toMatchObject({ owner: true });
    expect(teams.state.get().mine).toMatchObject({ name: 'Crew_8' });
  });

  it('opens an invite to another team, but not to the one the account is in', async () => {
    const { teams } = setup(signedIn('Ann', { id: 4, name: 'Team4', color: 3, owner: false }), {
      '/api/teams/4': () => Response.json({ team: detail(4) }),
      '/api/teams/7': () => Response.json({ team: detail(7) }),
      '/api/teams': () => Response.json({ teams: [] }),
    });
    await teams.openTeam(7);
    expect(teams.state.get()).toMatchObject({ screen: 'team', invited: detail(7) });
    await teams.openTeam(4);
    expect(teams.state.get()).toMatchObject({ invited: null, mine: detail(4) });
    teams.close();
    expect(teams.state.get().screen).toBeNull();
  });

  it("reports a team's name, and says what came of it", async () => {
    const { teams, calls } = setup(signedIn('Ann'), {
      '/api/reports': (init) =>
        JSON.parse(String(init?.body)).team === 5
          ? Response.json({ ok: true }, { status: 201 })
          : Response.json({ error: 'already_reported' }, { status: 409 }),
    });
    expect(await teams.reportName(5)).toBe(true);
    expect(calls[0]).toMatchObject({
      path: '/api/reports',
      method: 'POST',
      body: { team: 5, reason: 'team_name' },
    });
    expect(teams.state.get()).toMatchObject({
      busy: false,
      message: 'Thanks. A moderator will look at that team name.',
    });
    expect(await teams.reportName(6)).toBe(false);
    expect(teams.state.get().message).toBe(
      'You already reported this team name. A moderator will look at it.',
    );
    expect(teamReportMessage('unknown_code' as TeamReportError)).toBe(
      'Reports cannot be sent right now. Try again in a minute.',
    );
    // A moderator's placeholder offers nothing to report.
    expect(placeholderTeamName('team_12')).toBe(true);
    expect(placeholderTeamName('Team_Rocket')).toBe(false);
    const unnamed = setup(signedIn(null));
    expect(await unnamed.teams.reportName(5)).toBe(false);
    expect(unnamed.opened).toEqual(['nickname']);
    expect(unnamed.calls).toEqual([]);
  });

  it("asks the owner for a new name once a moderator reset the team's, once per page", async () => {
    const reset = { id: 8, name: 'team_8', color: 3, owner: true, nameReset: true };
    const renamed = signedIn('Ann', { ...reset, name: 'Crew_8', nameReset: false });
    const { teams, calls, adopted } = setup(signedIn('Ann', reset), {
      '/api/teams/rename': () => Response.json(renamed),
      '/api/teams/8': () => Response.json({ team: detail(8, 'team_8') }),
      '/api/teams': () => Response.json({ teams: [] }),
    });
    expect(needsTeamName(signedIn('Ann', reset).user)).toBe(true);
    const stop = teams.promptRename();
    // On load: the team screen opens.
    expect(teams.state.get().screen).toBe('team');
    teams.close();
    // A renewal saying the same does not open it again.
    teams.account.adopt(signedIn('Ann', reset));
    expect(teams.state.get().screen).toBeNull();
    expect(await teams.rename('no spaces')).toBe(false);
    expect(teams.state.get().message).toBe('Use letters, numbers or _ only, without spaces.');
    expect(await teams.rename(' Crew_8 ')).toBe(true);
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: '/api/teams/rename',
      body: { name: 'Crew_8' },
    });
    // Same team, same token team: no new socket.
    expect(adopted.at(-1)).toEqual({ me: renamed, reconnect: false });
    expect(needsTeamName(renamed.user)).toBe(false);
    stop();
    expect(teamMessage('not_reset')).toBe('Your team already has its new name.');
  });

  it('asks only owners, and only once the account has its own nickname', async () => {
    const reset = { id: 9, name: 'team_9', color: 3, owner: true, nameReset: true };
    const answers = {
      '/api/teams/9': () => Response.json({ team: detail(9, 'team_9') }),
      '/api/teams': () => Response.json({ teams: [] }),
    };
    const member = setup(signedIn('Bo', { ...reset, owner: false }), answers);
    member.teams.promptRename();
    expect(member.teams.state.get().screen).toBeNull();
    expect(needsTeamName(null)).toBe(false);
    // A reset nickname too: the nickname first, then the team name.
    const both = setup(signedIn(null, reset), answers);
    both.teams.promptRename();
    expect(both.teams.state.get().screen).toBeNull();
    both.teams.account.adopt(signedIn('Bo', reset));
    expect(both.teams.state.get().screen).toBe('team');
  });

  it('keeps the answer to the latest search only', async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { teams } = setup(signedIn('Ann'), {});
    const fetcher = (async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('q=old')) {
        await slow;
        return Response.json({ teams: [detail(1, 'old')] });
      }
      return Response.json({ teams: [detail(2, 'new')] });
    }) as typeof fetch;
    (teams as unknown as { fetcher: typeof fetch }).fetcher = fetcher;
    const first = teams.search('old');
    await teams.search('new');
    release();
    await first;
    expect(teams.state.get().list.map((t) => t.name)).toEqual(['new']);
    expect(teams.state.get().query).toBe('new');
  });
});
