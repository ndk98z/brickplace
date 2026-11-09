import type { Me } from '../net/account.ts';
import {
  createTeam,
  fetchRanking,
  fetchTeam,
  fetchTeams,
  joinTeam,
  leaveTeam,
  needsTeamName,
  type Ranking,
  renameTeam,
  reportTeamName,
  type TeamChange,
  type TeamDetail,
  type TeamSummary,
  teamMessage,
  teamNameProblem,
  teamReportMessage,
} from '../net/teams.ts';
import { Observable } from '../ui/observable.ts';
import type { AccountState } from './account.ts';

export type TeamScreen = 'team' | 'ranking' | null;

export interface TeamsState {
  readonly screen: TeamScreen;
  /** The ranking as last read; null until it arrives. */
  readonly ranking: Ranking | null;
  /** The past season the ranking screen shows (`?ranking=<id>`); null: the current one. */
  readonly rankingSeason: number | null;
  /** The ranking could not be read. */
  readonly rankingFailed: boolean;
  readonly query: string;
  /** Teams to join: the biggest, or those matching the search. */
  readonly list: readonly TeamSummary[];
  /** The account's own team, in full. */
  readonly mine: TeamDetail | null;
  /** A team opened from an invite link, when it is not the account's own. */
  readonly invited: TeamDetail | null;
  readonly busy: boolean;
  /** What the last change said, for the screen to show. */
  readonly message: string | null;
}

/** What Teams needs of the account: its view and a way to take a new one. */
export interface TeamsAccount {
  readonly state: Observable<AccountState>;
  adopt(me: Me, reconnect?: boolean): void;
  open(dialog: 'signin' | 'nickname'): void;
  openReport(nickname: string): void;
}

const EMPTY: TeamsState = {
  screen: null,
  ranking: null,
  rankingSeason: null,
  rankingFailed: false,
  query: '',
  list: [],
  mine: null,
  invited: null,
  busy: false,
  message: null,
};

/**
 * The team and ranking screens. Every change goes to the gateway, which answers with the
 * account view and a session token carrying the new team; the game then opens a new socket,
 * so the next op counts for the new team (ADR 0020).
 */
export class Teams {
  readonly state = new Observable<TeamsState>(EMPTY);
  /** Answers to older searches are dropped. */
  private searchId = 0;
  /** Answers to older ranking reads are dropped too (another season asked meanwhile). */
  private rankingId = 0;

  constructor(
    readonly account: TeamsAccount,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** Opens the team screen; `invited` shows that team first (from an invite link). */
  async openTeam(invited?: number): Promise<void> {
    this.state.update({ screen: 'team', message: null, invited: null });
    await Promise.all([
      this.loadMine(),
      this.search(this.state.get().query),
      invited ? this.loadInvited(invited) : Promise.resolve(),
    ]);
  }

  /** Opens the ranking: the current season's, or a past season's by id (ADR 0021). */
  async openRanking(season: number | null = null): Promise<void> {
    const id = ++this.rankingId;
    // Another season's ranking is not shown under this one's title while it loads.
    const same = season === this.state.get().rankingSeason;
    this.state.update({
      screen: 'ranking',
      rankingSeason: season,
      rankingFailed: false,
      ...(same ? {} : { ranking: null }),
    });
    const ranking = await fetchRanking(this.fetcher, season);
    if (id !== this.rankingId) return;
    this.state.update(ranking ? { ranking, rankingFailed: false } : { rankingFailed: true });
  }

  close(): void {
    this.state.update({ screen: null, message: null, invited: null });
  }

  async search(query: string): Promise<void> {
    const id = ++this.searchId;
    this.state.update({ query });
    const list = await fetchTeams(query, this.fetcher);
    if (id === this.searchId && list) this.state.update({ list });
  }

  async create(name: string, color: number): Promise<boolean> {
    const problem = teamNameProblem(name);
    if (problem) {
      this.state.update({ message: teamMessage(problem) });
      return false;
    }
    return this.change((csrf) => createTeam(csrf, name, color, this.fetcher));
  }

  join(team: number): Promise<boolean> {
    return this.change((csrf) => joinTeam(csrf, team, this.fetcher));
  }

  leave(): Promise<boolean> {
    return this.change((csrf) => leaveTeam(csrf, this.fetcher));
  }

  /**
   * The owner's new name after a moderator reset the team's (ADR 0023). The team stays the
   * same, so the socket does too.
   */
  async rename(name: string): Promise<boolean> {
    const problem = teamNameProblem(name);
    if (problem) {
      this.state.update({ message: teamMessage(problem) });
      return false;
    }
    return this.change((csrf) => renameTeam(csrf, name, this.fetcher), false);
  }

  /**
   * Opens the team screen, where the owner picks the new name, whenever the account owns a team
   * whose name a moderator reset (ADR 0023): at once if it does on load, or when a renewal
   * says so later. Once per team and page, so closing the screen is respected; it waits while
   * the account still has to pick its own nickname. Returns the unsubscribe.
   */
  promptRename(): () => void {
    const asked = new Set<number>();
    const check = () => {
      const { me, dialog } = this.account.state.get();
      const team = me.user?.team;
      if (!team || !needsTeamName(me.user) || !me.user?.nickname || dialog !== null) return;
      if (asked.has(team.id) || this.state.get().screen !== null) return;
      asked.add(team.id);
      void this.openTeam();
    };
    check();
    return this.account.state.subscribe(check);
  }

  /** Reports a team's name to moderators (ADR 0023); the screen shows what came of it. */
  async reportName(team: number): Promise<boolean> {
    const { me } = this.account.state.get();
    if (!me.signedIn || !me.csrf) {
      this.account.open('signin');
      return false;
    }
    if (!me.user?.nickname) {
      this.account.open('nickname');
      return false;
    }
    this.state.update({ busy: true, message: null });
    const result = await reportTeamName(me.csrf, team, this.fetcher);
    this.state.update({ busy: false, message: teamReportMessage(result) });
    return result === 'sent';
  }

  private async change(
    send: (csrf: string) => Promise<TeamChange>,
    reconnect = true,
  ): Promise<boolean> {
    const { me } = this.account.state.get();
    if (!me.signedIn || !me.csrf) {
      this.account.open('signin');
      return false;
    }
    if (!me.user?.nickname) {
      this.account.open('nickname');
      return false;
    }
    this.state.update({ busy: true, message: null });
    const result = await send(me.csrf);
    if (!result.ok) {
      this.state.update({ busy: false, message: teamMessage(result.error, result.retryAt) });
      return false;
    }
    // A new token with the new team: play on a fresh socket so ops count for it.
    this.account.adopt(result.me, reconnect);
    this.state.update({ busy: false, invited: null });
    await Promise.all([this.loadMine(), this.search(this.state.get().query)]);
    return true;
  }

  private async loadMine(): Promise<void> {
    const team = this.account.state.get().me.user?.team;
    const mine = team ? await fetchTeam(team.id, this.fetcher) : null;
    this.state.update({ mine });
  }

  private async loadInvited(id: number): Promise<void> {
    if (this.account.state.get().me.user?.team?.id === id) return;
    this.state.update({ invited: await fetchTeam(id, this.fetcher) });
  }
}
