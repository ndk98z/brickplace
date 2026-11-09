// The account API of the gateway (ADR 0015, 0016). The server decides everything; this only
// asks and shows.

import { type MeStatus, maintenanceUntilOf, meStatusOf, seasonOver } from '../game/states.ts';
import type { MyTeam } from './teams.ts';

export type ProviderId = 'google' | 'reddit' | 'discord' | 'dev';

export interface AuthConfig {
  readonly providers: readonly ProviderId[];
  readonly turnstileSiteKey: string | null;
  /** Local dev: a signed-out page plays under a dev id. */
  readonly devGuest: boolean;
  /**
   * The canvas in the public tiles bucket (ADR 0009, 0018): pages watch through it and open
   * a socket only to play. Missing or null: no CDN, every page keeps a socket.
   */
  readonly tilesUrl?: string | null;
  /** The season being played (ADR 0021); null or missing before the first season. */
  readonly season?: SeasonInfo | null;
  /** The next season to start, if one is registered (missing from older gateways). */
  readonly nextSeason?: { readonly canvas: string; readonly startsAt: number } | null;
  /** The registry could not be read: `season` and `tilesUrl` are a guess (Stage 0). */
  readonly seasonGuessed?: true;
  /**
   * How many may play at once (ADR 0039); null: no cap. Missing from older gateways (and
   * when the gateway could not be asked): the page does not check before opening a socket.
   */
  readonly playerCap?: number | null;
}

export interface SeasonInfo {
  readonly id: number;
  readonly canvas: string;
  readonly startsAt: number;
  readonly endsAt: number;
  /**
   * `finalizing`: over, its archive not sealed yet (moderators may still remove content);
   * `ended`: sealed. Older gateways say `ended` from the end on.
   */
  readonly state: 'scheduled' | 'live' | 'finalizing' | 'ended';
}

export interface UserView {
  readonly nickname: string | null;
  readonly suggestedNickname: string;
  readonly nicknameChangeableAt: number | null;
  readonly email: string | null;
  /**
   * Until when (ms) this sign-in may connect another provider or delete the account; then
   * sign in again first.
   */
  readonly linkUntil: number;
  readonly identities: readonly { readonly provider: ProviderId; readonly name: string | null }[];
  /** The account's team (ADR 0020); missing from gateways older than teams. */
  readonly team?: MyTeam | null;
  /** When joining or switching is allowed next (ms); 0: now. */
  readonly teamJoinableAt?: number;
  /** When creating a team is allowed next (ms); 0: now. */
  readonly teamCreatableAt?: number;
}

export interface Me {
  readonly signedIn: boolean;
  readonly user: UserView | null;
  readonly csrf: string | null;
  /**
   * How long (ms) the session token in the cookie stays enough for a socket; null when
   * signed out. The page moves to a fresh socket before then (Game.sessionRenewed).
   */
  readonly sessionExpiresIn?: number | null;
  readonly config: AuthConfig;
  /** True when the cookie's account is banned: signed out, shown as suspended (ADR 0023). */
  readonly suspended?: boolean;
}

/** Signed out with nothing to offer: what the page assumes when the gateway cannot say. */
export const NOBODY: Me = {
  signedIn: false,
  user: null,
  csrf: null,
  config: { providers: [], turnstileSiteKey: null, devGuest: false },
};

/** How this page takes part: plays as its account, as a dev guest, or watches. */
export type Role = 'player' | 'guest' | 'watcher';

export function roleFor(me: Me, watchOnly: boolean, now = Date.now()): Role {
  // A season that is over has a read-only map: nobody holds a socket or items for it.
  if (seasonOver(me.config.season, now)) return 'watcher';
  if (me.signedIn && me.user?.nickname) return 'player';
  if (!me.signedIn && me.config.devGuest && !watchOnly) return 'guest';
  return 'watcher';
}

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  google: 'Google',
  reddit: 'Reddit',
  discord: 'Discord',
  dev: 'Dev sign-in (local only)',
};

/** GET /api/me; null when the gateway cannot answer (offline, locked, restarting). */
export async function fetchMe(fetcher: typeof fetch = fetch): Promise<Me | null> {
  return (await fetchMeResult(fetcher)).me;
}

/** GET /api/me, with why there is no answer when there is none (game/states.ts). */
export async function fetchMeResult(
  fetcher: typeof fetch = fetch,
): Promise<{ me: Me | null; status: MeStatus; maintenanceUntil: number | null }> {
  try {
    // Bounded: the page waits for this before drawing, so a hung gateway must not blank it.
    const response = await fetcher('/api/me', {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(5000),
    });
    const body: unknown = await response.json().catch(() => null);
    const status = meStatusOf(response.status, body);
    // A banned account's answer is a signed-out view marked `suspended` (ADR 0023): the page
    // takes it, so it stops playing, and shows the suspended state.
    const usable = status === 'ok' || status === 'suspended';
    const me = response.ok && usable && body !== null ? (body as Me) : null;
    return {
      me,
      status: me || status !== 'ok' ? status : 'unavailable',
      maintenanceUntil: maintenanceUntilOf(body),
    };
  } catch {
    return { me: null, status: 'offline', maintenanceUntil: null };
  }
}

export type NicknameError =
  | 'too_short'
  | 'too_long'
  | 'characters'
  | 'blocked'
  | 'taken'
  | 'too_soon'
  | 'unavailable'
  | 'signed_out'
  | 'csrf';

export type NicknameResult =
  | { readonly ok: true; readonly me: Me }
  | { readonly ok: false; readonly error: NicknameError; readonly retryAt?: number };

/** ASCII letters, digits and underscore (ADR 0016). */
export const NICKNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

/** The server checks the same rules; this only saves a round trip for the obvious ones. */
export function nicknameProblem(nickname: string): NicknameError | null {
  const trimmed = nickname.trim();
  if (trimmed.length < 3) return 'too_short';
  if (trimmed.length > 20) return 'too_long';
  return NICKNAME_PATTERN.test(trimmed) ? null : 'characters';
}

export function nicknameMessage(error: NicknameError, retryAt?: number): string {
  switch (error) {
    case 'too_short':
      return 'Use at least 3 characters.';
    case 'too_long':
      return 'Use at most 20 characters.';
    case 'characters':
      return 'Use letters, numbers or _ only, without spaces.';
    case 'blocked':
      return 'That nickname is not allowed. Try another one.';
    case 'taken':
      return 'A player or a team already has that name.';
    case 'too_soon':
      return retryAt
        ? `You can change your nickname again on ${new Date(retryAt).toLocaleDateString()}.`
        : 'You can change your nickname once every 30 days.';
    case 'unavailable':
      return 'Nicknames cannot be checked right now. Try again in a minute.';
    case 'signed_out':
    case 'csrf':
      return 'Your sign-in ended. Sign in again to continue.';
  }
}

async function post(path: string, csrf: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify(body),
  });
}

export async function saveNickname(csrf: string, nickname: string): Promise<NicknameResult> {
  try {
    const response = await post('/api/nickname', csrf, { nickname: nickname.trim() });
    const body = (await response.json()) as Me & { error?: NicknameError; retryAt?: number };
    if (response.ok) return { ok: true, me: body };
    return {
      ok: false,
      error: body.error ?? 'unavailable',
      ...(body.retryAt ? { retryAt: body.retryAt } : {}),
    };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

/** Unlinks a provider; returns the new account view, or the server's error code. */
export async function unlinkProvider(csrf: string, provider: ProviderId): Promise<Me | string> {
  try {
    const response = await post(`/api/identities/${provider}/unlink`, csrf, {});
    const body = (await response.json()) as Me & { error?: string };
    return response.ok ? body : (body.error ?? 'unavailable');
  } catch {
    return 'unavailable';
  }
}

/** Why a nickname is reported: the gateway accepts exactly these (ADR 0019). */
export const REPORT_REASONS = {
  offensive: 'Rude, sexual or offensive',
  hateful: 'Hateful or harassing',
  impersonation: 'Pretends to be someone else',
  personal_info: 'Contains personal information',
} as const;

export type ReportReason = keyof typeof REPORT_REASONS;

export type ReportError =
  | 'not_found'
  | 'self'
  | 'reason'
  | 'already_reported'
  | 'too_many'
  | 'no_nickname'
  | 'unavailable'
  | 'signed_out'
  | 'csrf';

export function reportMessage(result: 'sent' | ReportError): string {
  switch (result) {
    case 'sent':
      return 'Thanks. A moderator will look at it.';
    case 'not_found':
      return 'No player has that nickname.';
    case 'self':
      return 'That is your own nickname.';
    case 'reason':
      return 'Pick a reason.';
    case 'already_reported':
      return 'You already reported this nickname. A moderator will look at it.';
    case 'too_many':
      return 'You have sent a lot of reports today. Try again tomorrow.';
    case 'no_nickname':
      return 'Pick your own nickname before reporting others.';
    case 'unavailable':
      return 'Reports cannot be sent right now. Try again in a minute.';
    case 'signed_out':
    case 'csrf':
      return 'Your sign-in ended. Sign in again to continue.';
  }
}

/** POST /api/reports; `sent` or the server's error code. */
export async function reportNickname(
  csrf: string,
  nickname: string,
  reason: ReportReason,
): Promise<'sent' | ReportError> {
  try {
    const response = await post('/api/reports', csrf, { nickname: nickname.trim(), reason });
    if (response.ok) return 'sent';
    const body = (await response.json().catch(() => ({}))) as { error?: ReportError };
    return body.error ?? 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** The profile's "Your season" numbers (ADR 0031): this account's moves on the current map. */
export interface SeasonNumbers {
  /** The season they count for; null on the map before seasons. */
  readonly season: number | null;
  readonly bricks: number;
  readonly hammers: number;
  readonly shields: number;
  readonly days: number;
}

/** The card's tiles, in the design's order. */
export function seasonTiles(numbers: SeasonNumbers): readonly (readonly [string, number])[] {
  return [
    ['Bricks placed', numbers.bricks],
    ['Hammers used', numbers.hammers],
    ['Shields placed', numbers.shields],
    ['Days played', numbers.days],
  ];
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

/** POST /api/me/season, for the signed-in account only; null when it cannot be read. */
export async function fetchSeasonNumbers(
  csrf: string,
  fetcher: typeof fetch = (...args) => fetch(...args),
): Promise<SeasonNumbers | null> {
  try {
    const response = await fetcher('/api/me/season', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: '{}',
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const numbers = [body.bricks, body.hammers, body.shields, body.days].map(count);
    if (numbers.some((n) => n === null)) return null;
    const season = typeof body.season === 'number' ? body.season : null;
    const [bricks, hammers, shields, days] = numbers as number[];
    return { season, bricks: bricks!, hammers: hammers!, shields: shields!, days: days! };
  } catch {
    return null;
  }
}

/**
 * Fetches the account's data (POST, so no other site can trigger it) and hands it to the
 * browser as a file. Returns null when it worked, or the server's error code.
 */
export async function downloadAccountData(csrf: string): Promise<string | null> {
  try {
    const response = await post('/api/account/export', csrf, {});
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      return body.error ?? 'unavailable';
    }
    const name =
      /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ??
      'brickplace-account.json';
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return null;
  } catch {
    return 'unavailable';
  }
}

/** What an account without a nickname types to confirm deletion (the gateway's DELETE_WORD). */
export const DELETE_WORD = 'delete';

/** True when `typed` confirms deleting this account: its nickname, in any letter case. */
export function confirmsDeletion(typed: string, nickname: string | null): boolean {
  return typed.trim().toLowerCase() === (nickname ?? DELETE_WORD).toLowerCase();
}

export function deleteMessage(error: string): string {
  switch (error) {
    case 'reauth':
      return 'For safety, deleting needs a sign-in from the last 10 minutes. Sign out, sign in again, then delete.';
    case 'confirm':
      return 'Type your nickname exactly to confirm.';
    case 'signed_out':
    case 'csrf':
      return 'Your sign-in ended. Sign in again to continue.';
    default:
      return 'That did not work. Try again in a minute.';
  }
}

/** POST /api/account/delete; null when the account is gone, or the server's error code. */
export async function deleteAccount(csrf: string, confirm: string): Promise<string | null> {
  try {
    const response = await post('/api/account/delete', csrf, { confirm: confirm.trim() });
    if (response.ok) return null;
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return body.error ?? 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * Shows the server a Turnstile token from the "confirm you are human" check (ADR 0026), with
 * the canvas the page loaded (its socket may still be on it after a season change); null
 * when the account may move again, or the server's error code (`turnstile`: the check did not
 * pass; `unavailable`: try again).
 */
export async function passChallenge(
  csrf: string,
  turnstile: string | null,
  canvas: string,
  fetcher: typeof fetch = (...args) => fetch(...args),
): Promise<string | null> {
  try {
    const response = await fetcher('/api/challenge', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ turnstile, canvas }),
    });
    if (response.ok) return null;
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return body.error ?? 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function signOut(csrf: string | null, everywhere = false): Promise<void> {
  if (!csrf) return;
  try {
    await post('/auth/logout', csrf, { everywhere });
  } catch {
    // The page reloads either way; a cookie left behind is refused at its next check.
  }
}

let signInReturn: string | null = null;

/**
 * Where a sign-in comes back to: the link the page was opened with (a share link's spot, a
 * team invite), which the page drops from its address once applied. Paths only.
 */
export function rememberReturnPath(path: string): void {
  signInReturn = path.startsWith('/') && !path.startsWith('//') ? path : null;
}

/**
 * Sends the browser to the provider: a form POST, so the Turnstile token and (for a link)
 * the CSRF token travel in the body, never in a URL.
 */
export function startSignIn(
  provider: ProviderId,
  fields: { turnstile?: string | null; link?: { csrf: string } },
): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `/auth/${provider}/start`;
  const add = (name: string, value: string) => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.append(input);
  };
  add('return', signInReturn ?? location.pathname);
  if (fields.turnstile) add('turnstile', fields.turnstile);
  if (fields.link) {
    add('mode', 'link');
    add('csrf', fields.link.csrf);
  }
  document.body.append(form);
  form.submit();
}

/** Copy for `?auth_error=` and `?linked=` after the provider sent the browser back. */
export function returnNotice(
  params: URLSearchParams,
  /** A signed-in page ignores `banned`: a refused sign-in leaves the page signed out. */
  signedIn = false,
): { title: string; body: string; tone: 'info' | 'warn' } | null {
  if (params.has('account_deleted')) {
    return {
      title: 'Account deleted',
      body: 'Your account and sign-ins are gone. The cells you placed stay on the map, linked to no one.',
      tone: 'info',
    };
  }
  const linked = params.get('linked');
  if (linked && linked in PROVIDER_NAMES) {
    return {
      title: 'Account connected',
      body: `You can now sign in with ${PROVIDER_NAMES[linked as ProviderId]} too.`,
      tone: 'info',
    };
  }
  const error = params.get('auth_error');
  if (!error || (error === 'banned' && signedIn)) return null;
  const body: Record<string, string> = {
    cancelled: 'Sign-in was cancelled. You can keep watching or try again.',
    turnstile: 'We could not confirm you are human. Finish the check and try again.',
    banned: 'This account is suspended.',
    taken: 'That account is already connected to another BrickPlace account.',
    provider_taken: 'Your account already has one of those connected.',
    state: 'Sign-in took too long or was opened twice. Please try again.',
    session:
      'Connecting an account needs a sign-in from the last 10 minutes. Sign out, sign in again, then connect it.',
    not_configured: 'Sign-in is not open on this server yet.',
    recently_deleted:
      'An account made with this sign-in was just deleted. You can make a new one in about an hour.',
  };
  return {
    title: "Couldn't sign you in",
    body: body[error] ?? 'Something went wrong with the provider. Please try again.',
    tone: 'warn',
  };
}
