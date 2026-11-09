import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from '../src/config.ts';
import { Account } from '../src/game/account.ts';
import { Game } from '../src/game/game.ts';
import {
  confirmsDeletion,
  deleteAccount,
  deleteMessage,
  fetchMe,
  type Me,
  NOBODY,
  nicknameMessage,
  nicknameProblem,
  REPORT_REASONS,
  reportMessage,
  reportNickname,
  returnNotice,
  roleFor,
  seasonTiles,
} from '../src/net/account.ts';
import { discardNotice, noticeFor } from '../src/net/messages.ts';

const signedIn = (nickname: string | null): Me => ({
  signedIn: true,
  csrf: 'c',
  config: { providers: ['dev'], turnstileSiteKey: null, devGuest: true },
  user: {
    nickname,
    suggestedNickname: 'Someone',
    nicknameChangeableAt: null,
    email: null,
    linkUntil: 0,
    identities: [{ provider: 'dev', name: 'Someone' }],
  },
});

/** A game with what Account and the ack handling use, its connection swaps recorded. */
function playingGame(random: () => number = () => 0) {
  const config: ClientConfig = {
    socketUrl: 'ws://test/ws',
    mapSize: 2048,
    open: { x: 512, y: 512, w: 1024, h: 1024 },
    maxShield: 5,
    kofiUrl: null,
    sponsors: [],
    sponsorInfoUrl: null,
  };
  // Node has no frames; drawing is not under test here.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  const game = new Game(config, 'player', random);
  const internals = game as unknown as {
    connection: unknown;
    onAck(opId: number, ok: boolean, reason: string | null): void;
  };
  return { game, internals };
}

describe('a Turnstile challenge (ADR 0026)', () => {
  it('posts the token with CSRF and lets the game resume only once the server agrees', async () => {
    const { game } = playingGame();
    const resumed = vi.spyOn(game, 'challengePassed');
    let answer: Response = Response.json({ error: 'turnstile' }, { status: 403 });
    const calls: Request[] = [];
    const fetcher = (async (input: RequestInfo, init?: RequestInit) => {
      calls.push(new Request(new URL(String(input), 'https://brickplace.test'), init));
      return answer;
    }) as unknown as typeof fetch;
    const account = new Account(signedIn('Brick_Fan'), game, false, fetcher);
    expect(await account.passChallenge('tok')).toBe('turnstile');
    expect(resumed).not.toHaveBeenCalled();
    expect(calls[0]!.headers.get('X-CSRF-Token')).toBe('c');
    // With the canvas the page loaded (no season registered: Stage 0's).
    expect(await calls[0]!.json()).toEqual({ turnstile: 'tok', canvas: 'canvas' });
    answer = Response.json({ ok: true, cleared: true });
    expect(await account.passChallenge('tok-2')).toBeNull();
    expect(resumed).toHaveBeenCalledOnce();
  });

  it('says why hammers and shields are refused for a limited account, item kept', () => {
    const notice = noticeFor('limited', 'hammer');
    expect(notice.title).toBe('Hammers and shields are limited for now');
    expect(notice.body).toContain('Your hammer is still in your hold');
    expect(discardNotice('limited').title).toBe('Hammers and shields are limited for now');
  });
});

describe('a playing page refused as signed out', () => {
  it('renews its session and opens a new socket, once, even in the same role', async () => {
    const { game, internals } = playingGame();
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return Response.json(signedIn('Brick_Fan'));
    }) as unknown as typeof fetch;
    new Account(signedIn('Brick_Fan'), game, false, fetcher);
    const before = internals.connection;
    // Two refusals in a row (say an op and a discard) share one renewal.
    internals.onAck(1, false, 'signed_out');
    internals.onAck(2, false, 'signed_out');
    await vi.waitFor(() => expect(internals.connection).not.toBe(before));
    expect(calls).toBe(1);
    expect(game.ui.get().role).toBe('player');
  });

  it('becomes a watcher when the renewal finds the session gone', async () => {
    const { game, internals } = playingGame();
    const fetcher = (async () => Response.json(NOBODY)) as unknown as typeof fetch;
    new Account(signedIn('Brick_Fan'), game, false, fetcher);
    internals.onAck(1, false, 'signed_out');
    await vi.waitFor(() => expect(game.ui.get().role).toBe('watcher'));
  });

  it('renews at once when kicked (4403), and shows a ban as a suspension', async () => {
    const { game, internals } = playingGame();
    const fetcher = (async () =>
      Response.json({ ...NOBODY, suspended: true })) as unknown as typeof fetch;
    const account = new Account(signedIn('Brick_Fan'), game, false, fetcher);
    let suspended = false;
    account.onSuspended = () => {
      suspended = true;
    };
    const page = internals as unknown as { connect(role: string): unknown };
    // The socket's close goes through the events the game gave its connection.
    const events = (
      page.connect('player') as unknown as {
        events: { closed?(code: number): void };
      }
    ).events;
    events.closed?.(1006);
    expect(suspended).toBe(false);
    events.closed?.(4403);
    await vi.waitFor(() => expect(game.ui.get().role).toBe('watcher'));
    expect(suspended).toBe(true);
    expect(account.state.get().me.signedIn).toBe(false);
  });

  it('does nothing of the kind for a watcher', () => {
    const { game, internals } = playingGame();
    game.setRole('watcher');
    let renewed = false;
    game.onSessionEnded = () => {
      renewed = true;
    };
    internals.onAck(1, false, 'signed_out');
    expect(renewed).toBe(false);
  });
});

describe('a playing page whose session was renewed', () => {
  const MINUTE = 60_000;
  const T0 = Date.UTC(2026, 9, 24, 12);
  type Page = ReturnType<typeof playingGame>['internals'] & {
    onSocketOpening(): void;
    onSocketOpen(): void;
    sent: Map<number, unknown>;
  };

  /**
   * A playing page on a clock reading `now`: its socket starts opening with a token that
   * has 60 min left, then /api/me renews it to 80 min, and only then does the socket's first
   * frame arrive. Jitter comes from `random`.
   */
  async function renewedPage(random = 0, now = T0) {
    vi.useFakeTimers({ now });
    const { game, internals } = playingGame(() => random);
    const renewedMe: Me = { ...signedIn('Brick_Fan'), sessionExpiresIn: 80 * MINUTE };
    const fetcher = (async () => Response.json(renewedMe)) as unknown as typeof fetch;
    const account = new Account(
      { ...signedIn('Brick_Fan'), sessionExpiresIn: 60 * MINUTE },
      game,
      false,
      fetcher,
    );
    const page = internals as Page;
    page.onSocketOpening();
    await account.refresh();
    page.onSocketOpen();
    return { page, opened: page.connection };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves to a fresh socket shortly before the old token runs out', async () => {
    const { page, opened } = await renewedPage();
    vi.advanceTimersByTime(57 * MINUTE);
    expect(page.connection).toBe(opened);
    vi.advanceTimersByTime(1 * MINUTE);
    expect(page.connection).not.toBe(opened);
  });

  it('counts on its own clock, however far off it is from the server', async () => {
    // The server only says how long the token has left; this page's clock is 5 h behind.
    const { page, opened } = await renewedPage(0, T0 - 5 * 60 * MINUTE);
    vi.advanceTimersByTime(57 * MINUTE);
    expect(page.connection).toBe(opened);
    vi.advanceTimersByTime(1 * MINUTE);
    expect(page.connection).not.toBe(opened);
  });

  it('spreads the move over the minute before that, at random', async () => {
    const { page, opened } = await renewedPage(1);
    vi.advanceTimersByTime(57 * MINUTE - 1);
    expect(page.connection).toBe(opened);
    vi.advanceTimersByTime(1);
    expect(page.connection).not.toBe(opened);
  });

  it('waits for the answer to an op in flight before moving', async () => {
    const { page, opened } = await renewedPage();
    page.sent.set(5, { itemId: 1, kind: 'hammer', discard: false });
    vi.advanceTimersByTime(58 * MINUTE);
    expect(page.connection).toBe(opened);
    page.onAck(5, true, null);
    expect(page.connection).not.toBe(opened);
  });

  it('drops a waiting move when the role changes, so no second socket opens', async () => {
    const { page } = await renewedPage();
    page.sent.set(5, { itemId: 1, kind: 'hammer', discard: false });
    vi.advanceTimersByTime(58 * MINUTE);
    const game = page as unknown as Game;
    const sockets = vi.spyOn(page as unknown as { connect(role: string): unknown }, 'connect');
    game.setRole('watcher');
    // The op's answer arrives as the old socket stops (stop() reports it `unavailable`).
    page.onAck(5, false, 'unavailable');
    expect(sockets).toHaveBeenCalledTimes(1);
    expect(game.ui.get().role).toBe('watcher');
  });

  it('stays put while no renewed token is known', () => {
    vi.useFakeTimers({ now: T0 });
    const { game, internals } = playingGame();
    game.sessionRenewed(60 * MINUTE);
    (internals as Page).onSocketOpening();
    // The same token again, a round trip later, is not a renewal.
    vi.advanceTimersByTime(2_000);
    game.sessionRenewed(60 * MINUTE - 2_000 + 300);
    const opened = internals.connection;
    vi.advanceTimersByTime(90 * MINUTE);
    expect(internals.connection).toBe(opened);
  });
});

describe('role', () => {
  it('plays as the account once it has a nickname', () => {
    expect(roleFor(signedIn('Brick_Fan'), false)).toBe('player');
    expect(roleFor(signedIn(null), false)).toBe('watcher');
  });

  it('plays as a dev guest only in local dev, signed out, and not with ?watch', () => {
    const dev: Me = { ...NOBODY, config: { ...NOBODY.config, devGuest: true } };
    expect(roleFor(dev, false)).toBe('guest');
    expect(roleFor(dev, true)).toBe('watcher');
    expect(roleFor(NOBODY, false)).toBe('watcher');
  });

  it('only watches a season that is over', () => {
    const season = { id: 1, canvas: 's1', startsAt: 1_000, endsAt: 2_000, state: 'live' as const };
    const player = signedIn('Brick_Fan');
    const during: Me = { ...player, config: { ...player.config, season } };
    expect(roleFor(during, false, 1_500)).toBe('player');
    expect(roleFor(during, false, 2_000)).toBe('watcher');
    const ended: Me = {
      ...player,
      config: { ...player.config, season: { ...season, state: 'ended' } },
    };
    expect(roleFor(ended, false, 1_500)).toBe('watcher');
  });

  it('stops playing at its season end without taking the old answer again', () => {
    vi.useFakeTimers({ now: 1_500 });
    try {
      const season = {
        id: 1,
        canvas: 's1',
        startsAt: 1_000,
        endsAt: 2_000,
        state: 'live' as const,
      };
      const player = signedIn('Brick_Fan');
      const { game } = playingGame();
      const account = new Account({ ...player, config: { ...player.config, season } }, game, false);
      const renewed = vi.spyOn(game, 'sessionRenewed');
      // The timer may fire a moment before the wall clock reaches the end: a watcher anyway.
      vi.setSystemTime(1_999);
      game.seasonOver();
      account.seasonEnded();
      expect(game.ui.get().role).toBe('watcher');
      // Its session expiry counted from when the answer came: not set again from now.
      expect(renewed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps playing when an answer moved the end later while moves were awaited', () => {
    vi.useFakeTimers({ now: 2_000 });
    try {
      const { game } = playingGame();
      const account = new Account(signedIn('Brick_Fan'), game, false);
      game.seasonOver();
      // The refresh lands before the moves in flight are answered: the end moved later.
      game.setRole('player');
      account.seasonEnded();
      expect(game.ui.get().role).toBe('player');
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an unreachable gateway as signed out', async () => {
    const failing = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await fetchMe(failing)).toBeNull();
    const locked = (() =>
      Promise.resolve(new Response('', { status: 501 }))) as unknown as typeof fetch;
    expect(await fetchMe(locked)).toBeNull();
  });
});

describe('nickname checks before sending', () => {
  it('mirror the server rules', () => {
    expect(nicknameProblem('ab')).toBe('too_short');
    expect(nicknameProblem('  abc  ')).toBeNull();
    expect(nicknameProblem('a'.repeat(21))).toBe('too_long');
    expect(nicknameProblem('two words')).toBe('characters');
    expect(nicknameProblem('Brick_Fan_7')).toBeNull();
    expect(nicknameProblem('Brick-Fan')).toBe('characters');
  });

  it('explain every server error', () => {
    expect(nicknameMessage('taken')).toMatch(/already/);
    expect(nicknameMessage('too_soon', Date.UTC(2026, 10, 30))).toMatch(/again on/);
  });
});

describe('notices', () => {
  it('after the provider sends the browser back', () => {
    expect(returnNotice(new URLSearchParams('linked=discord'))?.body).toMatch(/Discord/);
    expect(returnNotice(new URLSearchParams('auth_error=turnstile'))?.tone).toBe('warn');
    expect(returnNotice(new URLSearchParams('auth_error=unknown'))?.body).toMatch(/try again/);
    expect(returnNotice(new URLSearchParams(''))).toBeNull();
  });

  it('for an op or discard refused because the page only watches', () => {
    expect(noticeFor('signed_out', 'brick').title).toBe('Sign in to play');
    expect(discardNotice('signed_out').title).toBe('Sign in to play');
  });

  it('after the account is deleted', () => {
    expect(returnNotice(new URLSearchParams('account_deleted=1'))?.title).toBe('Account deleted');
    expect(returnNotice(new URLSearchParams('auth_error=recently_deleted'))?.body).toMatch(/hour/);
  });
});

describe('reports, data download and deletion (ADR 0019)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Answers every fetch with this response and records the requests. */
  function answer(response: () => Response) {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo, init?: RequestInit) => {
      requests.push(new Request(new URL(String(input), 'https://brickplace.test'), init));
      return response();
    });
    return requests;
  }

  it('closes the report dialog back to where it was opened from', () => {
    const { game } = playingGame();
    const account = new Account(signedIn('Brick_Fan'), game, false);
    account.open('profile');
    account.openReport();
    expect(account.state.get()).toMatchObject({ dialog: 'report', reportTarget: '' });
    account.closeReport();
    expect(account.state.get().dialog).toBe('profile');
    // Opened from elsewhere (a ranking row, later), with the nickname filled in.
    account.close();
    account.openReport('Rude_Name');
    expect(account.state.get().reportTarget).toBe('Rude_Name');
    account.closeReport();
    expect(account.state.get().dialog).toBeNull();
  });

  it('offers exactly the reasons the gateway accepts', () => {
    expect(Object.keys(REPORT_REASONS)).toEqual([
      'offensive',
      'hateful',
      'impersonation',
      'personal_info',
    ]);
  });

  it('sends a report with the CSRF token and reads the server error', async () => {
    const requests = answer(() => new Response(null, { status: 201 }));
    expect(await reportNickname('tok', '  Brick_Fan ', 'hateful')).toBe('sent');
    expect(requests[0]!.headers.get('X-CSRF-Token')).toBe('tok');
    expect(await requests[0]!.json()).toEqual({ nickname: 'Brick_Fan', reason: 'hateful' });
    answer(() => Response.json({ error: 'too_many' }, { status: 429 }));
    expect(await reportNickname('tok', 'Brick_Fan', 'hateful')).toBe('too_many');
    // A rate-limit page from the edge is not JSON.
    answer(() => new Response('<html>slow down</html>', { status: 429 }));
    expect(await reportNickname('tok', 'Brick_Fan', 'hateful')).toBe('unavailable');
    expect(reportMessage('already_reported')).toMatch(/already/);
  });

  it('confirms deletion only with the nickname (any case) or, without one, the word', async () => {
    expect(confirmsDeletion(' brick_FAN ', 'Brick_Fan')).toBe(true);
    expect(confirmsDeletion('Brick_Fa', 'Brick_Fan')).toBe(false);
    expect(confirmsDeletion('DELETE', null)).toBe(true);
    expect(confirmsDeletion('', null)).toBe(false);
    const requests = answer(() => Response.json({ error: 'reauth' }, { status: 403 }));
    expect(await deleteAccount('tok', ' Brick_Fan ')).toBe('reauth');
    expect(await requests[0]!.json()).toEqual({ confirm: 'Brick_Fan' });
    expect(deleteMessage('reauth')).toMatch(/10 minutes/);
    answer(() => Response.json({ ok: true }));
    expect(await deleteAccount('tok', 'Brick_Fan')).toBeNull();
  });
});

describe('"Your season" numbers (ADR 0031)', () => {
  it('asks with CSRF for the signed-in account and keeps only whole counts', async () => {
    const { game } = playingGame();
    let answer: () => Response = () =>
      Response.json({ season: 3, bricks: 12, hammers: 4, shields: 1, days: 2 });
    const calls: Request[] = [];
    const fetcher = (async (input: RequestInfo, init?: RequestInit) => {
      calls.push(new Request(new URL(String(input), 'https://brickplace.test'), init));
      return answer();
    }) as unknown as typeof fetch;
    const account = new Account(signedIn('Brick_Fan'), game, false, fetcher);
    const numbers = await account.seasonNumbers();
    expect(numbers).toEqual({ season: 3, bricks: 12, hammers: 4, shields: 1, days: 2 });
    expect(calls[0]!.method).toBe('POST');
    expect(new URL(calls[0]!.url).pathname).toBe('/api/me/season');
    expect(calls[0]!.headers.get('X-CSRF-Token')).toBe('c');
    expect(seasonTiles(numbers!)).toEqual([
      ['Bricks placed', 12],
      ['Hammers used', 4],
      ['Shields placed', 1],
      ['Days played', 2],
    ]);
    // Before seasons: no season number, counts still shown.
    answer = () => Response.json({ season: null, bricks: 0, hammers: 0, shields: 0, days: 0 });
    expect((await account.seasonNumbers())?.season).toBeNull();
    // A count that is not a whole number, a refusal or a network error: nothing to show.
    answer = () => Response.json({ season: 3, bricks: -1, hammers: 0, shields: 0, days: 0 });
    expect(await account.seasonNumbers()).toBeNull();
    answer = () => Response.json({ error: 'unavailable' }, { status: 503 });
    expect(await account.seasonNumbers()).toBeNull();
    answer = () => {
      throw new TypeError('offline');
    };
    expect(await account.seasonNumbers()).toBeNull();
  });

  it('does not ask while signed out', async () => {
    const { game } = playingGame();
    const fetcher = vi.fn();
    const account = new Account(NOBODY, game, false, fetcher as unknown as typeof fetch);
    expect(await account.seasonNumbers()).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
