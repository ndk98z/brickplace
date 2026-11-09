import {
  deleteAccount,
  downloadAccountData,
  fetchMe,
  fetchSeasonNumbers,
  type Me,
  type NicknameResult,
  type ProviderId,
  passChallenge,
  type ReportError,
  type ReportReason,
  reportNickname,
  roleFor,
  type SeasonNumbers,
  saveNickname,
  signOut,
  startSignIn,
  unlinkProvider,
} from '../net/account.ts';
import { Observable } from '../ui/observable.ts';
import type { Game } from './game.ts';
import { canvasOf } from './season-watch.ts';

export type Dialog = 'signin' | 'nickname' | 'profile' | 'report' | null;

export interface AccountState {
  readonly me: Me;
  readonly dialog: Dialog;
  /** The nickname the report dialog opens with ('' to type one). */
  readonly reportTarget: string;
  /** Where closing the report dialog goes back to (the profile, when opened from there). */
  readonly reportReturn: Dialog;
}

/** How often an open page asks /api/me again, which renews the session token. */
const REFRESH_MS = 20 * 60 * 1000;

/**
 * The signed-in account (or none) and the account dialogs. Changes that alter who the socket
 * plays as (a first nickname, a session that ended) reconnect the game in its new role.
 */
export class Account {
  readonly state: Observable<AccountState>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewing: Promise<void> | null = null;
  /** The canvas (season) this page loaded, whatever later answers say is current. */
  private readonly canvas: string;

  constructor(
    me: Me,
    private readonly game: Pick<
      Game,
      'setRole' | 'onSessionEnded' | 'sessionRenewed' | 'challengePassed' | 'endingSeason'
    >,
    private readonly watchOnly: boolean,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {
    const needsNickname = me.signedIn && me.user !== null && me.user.nickname === null;
    this.canvas = canvasOf(me);
    this.state = new Observable<AccountState>({
      me,
      dialog: needsNickname ? 'nickname' : null,
      reportTarget: '',
      reportReturn: null,
    });
    game.onSessionEnded = () => void this.renew();
    game.sessionRenewed(me.sessionExpiresIn ?? null);
  }

  /**
   * The server refused a playing socket as signed out (its token expired, e.g. after the
   * computer slept). Renews the session and opens a new socket in whatever role results:
   * the old socket would otherwise watch silently. One renewal at a time.
   */
  renew(): Promise<void> {
    this.renewing ??= this.refresh(true).finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  open(dialog: Dialog): void {
    this.state.update({ dialog });
  }

  close(): void {
    this.state.update({ dialog: null });
  }

  /**
   * Opens the report dialog, pre-filled with a nickname. Screens that show other players'
   * nicknames (teams, ranking) call this; until they exist the profile opens it empty.
   */
  openReport(nickname = ''): void {
    const from = this.state.get().dialog;
    this.state.update({
      dialog: 'report',
      reportTarget: nickname,
      reportReturn: from === 'report' ? this.state.get().reportReturn : from,
    });
  }

  /** Closes the report dialog, back to wherever it was opened from. */
  closeReport(): void {
    this.state.update({ dialog: this.state.get().reportReturn, reportReturn: null });
  }

  async report(nickname: string, reason: ReportReason): Promise<'sent' | ReportError> {
    const { csrf } = this.state.get().me;
    if (!csrf) return 'signed_out';
    return reportNickname(csrf, nickname, reason);
  }

  /**
   * Shows the server the "confirm you are human" token (ADR 0026), naming the canvas this page
   * loaded (a season may have changed under it); on success the game reconnects and resends
   * the move it held. Null when it worked, or the error code.
   */
  async passChallenge(turnstile: string | null): Promise<string | null> {
    const { csrf } = this.state.get().me;
    if (!csrf) return 'signed_out';
    const error = await passChallenge(csrf, turnstile, this.canvas, this.fetcher);
    if (error === null) this.game.challengePassed();
    return error;
  }

  /** The profile's "Your season" numbers; null signed out or when they cannot be read. */
  async seasonNumbers(): Promise<SeasonNumbers | null> {
    const { csrf } = this.state.get().me;
    if (!csrf) return null;
    return fetchSeasonNumbers(csrf, this.fetcher);
  }

  /** Downloads the account's data as a JSON file; null, or the server's error code. */
  async downloadData(): Promise<string | null> {
    const { csrf } = this.state.get().me;
    if (!csrf) return 'signed_out';
    return downloadAccountData(csrf);
  }

  /** Deletes the account; on success the page reloads signed out. Else the error code. */
  async deleteAccount(confirm: string): Promise<string | null> {
    const { csrf } = this.state.get().me;
    if (!csrf) return 'signed_out';
    const error = await deleteAccount(csrf, confirm);
    if (error === null) location.assign('/?account_deleted=1');
    return error;
  }

  /**
   * Asks the gateway again; a session that ended turns the page into a watcher. `reconnect`
   * opens a new socket even when the role stays the same.
   */
  async refresh(reconnect = false): Promise<void> {
    const me = await fetchMe(this.fetcher);
    if (!me) return;
    this.apply(me, reconnect);
    // Banned since the page opened (a kick sends it here at once, ADR 0023).
    if (me.suspended === true) this.onSuspended?.();
  }

  /** Called when a renewal finds the account banned; main.tsx shows the suspended state. */
  onSuspended: (() => void) | null = null;

  /**
   * Takes an account view the gateway sent with a change made elsewhere (a team joined or
   * left). The new session token carries the team, so `reconnect` moves play to a new socket.
   */
  adopt(me: Me, reconnect = false): void {
    this.apply(me, reconnect);
  }

  /**
   * The season the page plays reached its end (SeasonWatch's timer): a watcher, whatever the
   * role was, as roleFor makes everyone once a season is over. Set directly rather than from
   * the last answer: a timer may fire a moment before the wall clock reaches the end, and an
   * answer guessed while the registry was down names no season at all. Nothing else of that
   * answer is taken again (its session expiry counted from when it came). Only while the end
   * still stands: an answer that moved it later since set the role again (endingSeason).
   */
  seasonEnded(): void {
    if (this.game.endingSeason) this.game.setRole('watcher');
  }

  private apply(me: Me, reconnect = false): void {
    this.state.update({ me });
    // First the expiry, so a socket opened by setRole records the renewed one.
    this.game.sessionRenewed(me.sessionExpiresIn ?? null);
    this.game.setRole(roleFor(me, this.watchOnly), reconnect);
  }

  signIn(provider: ProviderId, turnstile: string | null): void {
    startSignIn(provider, { turnstile });
  }

  link(provider: ProviderId): void {
    const { csrf } = this.state.get().me;
    if (csrf) startSignIn(provider, { link: { csrf } });
  }

  async chooseNickname(nickname: string): Promise<NicknameResult> {
    const { csrf } = this.state.get().me;
    if (!csrf) return { ok: false, error: 'signed_out' };
    const result = await saveNickname(csrf, nickname);
    if (result.ok) {
      this.apply(result.me);
      this.close();
    }
    return result;
  }

  async unlink(provider: ProviderId): Promise<string | null> {
    const { csrf } = this.state.get().me;
    if (!csrf) return 'signed_out';
    const result = await unlinkProvider(csrf, provider);
    if (typeof result === 'string') return result;
    this.apply(result);
    return null;
  }

  /** Signs out and reloads: the page starts again as a watcher. */
  async signOut(everywhere = false): Promise<void> {
    await signOut(this.state.get().me.csrf, everywhere);
    location.assign('/');
  }
}
