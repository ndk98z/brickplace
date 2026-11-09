import { render } from 'preact';
import { fetchSiteInfo, loadConfig } from './config.ts';
import { Account } from './game/account.ts';
import { Game } from './game/game.ts';
import { LiveStats, mapIsFull } from './game/live-stats.ts';
import { gameUnderWay, Screens } from './game/screens.ts';
import { reloadAtOnce, SeasonWatch, whenSettled } from './game/season-watch.ts';
import {
  arrivalPath,
  cameraFor,
  linkFromAnotherSeason,
  parseViewPath,
  seasonParam,
} from './game/share.ts';
import { followAccount, followConnection, initialStatus, SystemStatus } from './game/states.ts';
import { Teams } from './game/teams.ts';
import { fetchMeResult, NOBODY, rememberReturnPath, returnNotice, roleFor } from './net/account.ts';
import { invitedTeam, rankingSeasonOf } from './net/teams.ts';
import { App } from './ui/App.tsx';
import './ui/styles.css';

// Who this page is decides the socket, so ask before connecting. `?watch` keeps a local dev
// page from playing as a dev guest, to see what signed-out visitors see.
const params = new URLSearchParams(location.search);
const watchOnly = params.has('watch');
// Sponsors and links set in the admin area (ADR 0038) are asked for alongside; without an
// answer the build's own values stand in.
const [answer, site] = await Promise.all([fetchMeResult(), fetchSiteInfo()]);
const me = answer.me ?? NOBODY;
const initial = initialStatus(params, me, answer);
const status = new SystemStatus(initial.me, initial.maintenanceUntil);
const game = new Game(loadConfig(me.config.tilesUrl, site), roleFor(me, watchOnly));
// "Reduce motion" (Profile) reaches the CSS as an attribute: the system setting until the
// player switches it.
const motion = () => {
  document.documentElement.dataset.motion = game.prefs.state.get().reduceMotion ? 'reduce' : 'full';
};
motion();
game.prefs.state.subscribe(motion);
const account = new Account(me, game, watchOnly);
account.onSuspended = () => status.set({ me: 'suspended' });
account.start();
const teams = new Teams(account);
const screens = new Screens();
// Players on the map, the phase and the drop rates (ADR 0030): from the manifest while the
// page watches through the CDN (ADR 0033), polled while visible otherwise.
const live = new LiveStats();
game.onCdnStats = (stats) => live.offerManifest(stats);
live.start();
// The players-at-once cap (ADR 0039): with the map full, the page watches instead of opening a
// socket the server would turn away.
game.mapFull = () => mapIsFull(account.state.get().me.config.playerCap, live.current(Date.now()));
// Whose map this page shows: its sockets resume from it only on that canvas (ADR 0040). The
// Stage 0 canvas before any season; nothing when the gateway could only guess.
game.mapCanvas = me.config.seasonGuessed ? null : (me.config.season?.canvas ?? 'canvas');

// A share link (`/@x,y,zoomx`) opens the map at that spot and zoom; one from another season
// (`?season=`) also says the map has changed, and where that season's final map is.
const view = parseViewPath(location.pathname, game.store.size);
const linkSeason = view ? seasonParam(params, 'season') : null;
if (view) game.showView(cameraFor(view));
if (linkSeason !== null && linkFromAnotherSeason(linkSeason, me.config)) {
  game.notify({
    title: `This link is from Season ${linkSeason}`,
    body: 'The map has changed since. That season’s final map stays in the timelapse.',
    tone: 'info',
    action: {
      label: `See Season ${linkSeason}`,
      run: () => location.assign(`/timelapse.html?season=${linkSeason}`),
    },
  });
}
// A plain first visit gets the landing between seasons and a short welcome card while a game
// is under way; someone who came through a link gets neither, and a sign-in brings them back
// to that link. Nor does a page whose gateway answer is missing or says the account is
// suspended: its card says what matters, and an unknown season looks like a live one.
const invited = invitedTeam(params);
const arrival = arrivalPath(view, invited, linkSeason);
if (arrival) rememberReturnPath(arrival);
screens.start({
  signedIn: me.signedIn,
  playing: gameUnderWay(me.config.season, Date.now()),
  directed:
    view !== null ||
    params.has('team') ||
    params.has('ranking') ||
    params.has('auth_error') ||
    params.has('linked') ||
    params.has('account_deleted') ||
    initial.me !== 'ok',
});

// Account answers clear failures, open the guide on a first nickname, and tell a sign-out;
// back online, the gateway is asked again. A guide held back while no game was under way
// opens on the first page where one is.
followAccount(account.state, status, screens);
screens.pendingGuide(me.user?.nickname ?? null, gameUnderWay(me.config.season, Date.now()));
// Another season's canvas becoming current (ADR 0021): a hidden page with nothing under way
// reloads at once; otherwise the page says so and offers the reload.
const seasons = new SeasonWatch(answer.me, {
  refresh: () => account.refresh(),
  // Once the moves still awaiting an answer have one (a few seconds at most).
  over: () => {
    game.seasonOver();
    whenSettled(
      { pending: () => game.ui.get().hold.pending.size, subscribe: (l) => game.ui.subscribe(l) },
      () => account.seasonEnded(),
      {
        setTimeout: (run, ms) => setTimeout(run, ms),
        clearTimeout: (t) => clearTimeout(t as number),
      },
    );
  },
  changed: () => {
    // The map shown is the old season's: no socket may resume from it (ADR 0040).
    game.mapCanvas = null;
    const page = {
      hidden: document.visibilityState === 'hidden',
      dialogOpen:
        account.state.get().dialog !== null ||
        screens.state.get().screen !== null ||
        teams.state.get().screen !== null,
      awaitingAck: game.ui.get().hold.pending.size > 0,
      holding: game.waitingToPlay || game.ui.get().challenge,
    };
    if (reloadAtOnce(page)) location.reload();
    else status.set({ newSeason: true });
  },
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});
account.state.subscribe(() => seasons.observe(account.state.get().me));
// The first `ended` refusal only: the planned check covers the next start.
let halt = game.ui.get().halt;
game.ui.subscribe(() => {
  const now = game.ui.get().halt;
  if (now === 'ended' && halt !== 'ended') seasons.ended();
  halt = now;
});
const recheck = () => void status.recheck(fetchMeResult, (answer) => account.adopt(answer));
window.addEventListener('online', recheck);
// A first /api/me that timed out on a device that is online: the map arriving says so.
followConnection(game.ui, status, recheck);

// Back from a provider: say how it went once, then drop the marker from the address. The
// suspended card replaces the `banned` toast.
const notice = initial.me === 'suspended' ? null : returnNotice(params, me.signedIn);
if (notice) game.notify(notice);
// An invite link (`?team=`) opens the team screen on that team, once.
if (invited !== null) void teams.openTeam(invited);
// A season's ranking (`?ranking=<id>`, from the timelapse), once.
const rankingSeason = rankingSeasonOf(params);
if (rankingSeason !== null && invited === null) void teams.openRanking(rankingSeason);
// An owner whose team name a moderator reset is asked for a new one (ADR 0023).
teams.promptRename();
// The markers go from the address, and so does a share link's `/@x,y,zoomx` once applied, so
// a reload does not jump back to the link's spot.
if (
  view !== null ||
  params.has('auth_error') ||
  params.has('linked') ||
  params.has('account_deleted') ||
  params.has('team') ||
  params.has('ranking')
) {
  params.delete('auth_error');
  params.delete('linked');
  params.delete('account_deleted');
  params.delete('team');
  params.delete('ranking');
  // A share link's season goes with its spot.
  if (view !== null) params.delete('season');
  const query = params.toString();
  const path = view !== null ? '/' : location.pathname;
  history.replaceState(null, '', `${path}${query ? `?${query}` : ''}${location.hash}`);
}

render(
  <App game={game} account={account} teams={teams} screens={screens} status={status} live={live} />,
  document.querySelector('#app')!,
);
