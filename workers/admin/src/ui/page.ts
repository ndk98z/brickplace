// The admin page (ADR 0022): one HTML shell, /admin.css and /admin.js, all served by this Worker
// behind Access under a CSP that allows nothing else (no inline style or script, no web fonts).
// The layout follows the admin artboards of the UI design: a dark sidebar with the sections in
// three groups (live, game, people), one view at a time in the main column, white cards on a
// light ground.

import { ADMINS_HTML, ADMINS_JS } from './admins.ts';
import { AREAS_HTML, AREAS_JS } from './areas.ts';
import { CORE_JS } from './core.ts';
import { CONFIG_HTML, CONFIG_JS } from './game-config.ts';
import { OVERVIEW_HTML, OVERVIEW_JS } from './overview.ts';
import { PLAYERS_HTML, PLAYERS_JS } from './players.ts';
import { REPORTS_HTML, REPORTS_JS } from './reports.ts';
import { SEASON_HTML, SEASON_JS } from './season.ts';
import { SPONSORS_HTML, SPONSORS_JS } from './sponsors.ts';

export { ADMIN_CSS } from './style.ts';

export const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>BrickPlace admin</title>
<link rel="stylesheet" href="/admin.css">
<script src="/admin.js" defer></script>
</head>
<body>
<aside class="side" aria-label="Admin sections">
  <div class="brand">BrickPlace <span class="brand-pill">Admin</span></div>
  <nav class="nav">
    <span class="nav-group">Live</span>
    <a href="#overview">Overview</a>
    <a href="#reports">Reports <span class="count" id="nav-count" hidden></span></a>
    <a href="#areas">Areas &amp; locks</a>
    <span class="nav-group">Game</span>
    <a href="#season">Season</a>
    <a href="#config">Game config</a>
    <a href="#sponsors">Sponsors &amp; links</a>
    <span class="nav-group">People</span>
    <a href="#players">Players &amp; teams</a>
    <a href="#audit">Admins &amp; audit</a>
  </nav>
  <div class="who" id="who">Loading...</div>
</aside>
<div class="main">
  <div class="env" id="env" hidden></div>
  <main class="content">
    <div class="top">
      <h1 id="title">Overview</h1>
      <span id="season-pill"></span>
      <button type="button" id="refresh" class="secondary push">Refresh</button>
    </div>
${OVERVIEW_HTML}${REPORTS_HTML}${AREAS_HTML}${SEASON_HTML}${CONFIG_HTML}${SPONSORS_HTML}${PLAYERS_HTML}${ADMINS_HTML}
  </main>
</div>
<dialog id="ask" aria-labelledby="ask-title">
  <form id="ask-form">
    <h2 id="ask-title"></h2>
    <p class="text" id="ask-text"></p>
    <div id="ask-fields"></div>
    <label class="field" id="ask-reason">Reason
      <textarea name="reason" rows="3" maxlength="500"></textarea>
      <span class="hint" id="ask-reason-hint"></span></label>
    <div class="buttons">
      <button type="button" id="ask-cancel" class="ghost big">Cancel</button>
      <button type="submit" id="ask-ok" class="primary big">Confirm</button>
    </div>
  </form>
</dialog>
<div class="toast" id="toast" role="status" hidden>
  <p id="toast-text"></p>
  <button type="button" id="toast-close" aria-label="Close message">Close</button>
</div>
</body>
</html>
`;

const BOOT_JS = `
  // ---- Start --------------------------------------------------------------------------------

  const ENV_NOTE = {
    production: 'Production: every change here reaches live players.',
    staging: 'Staging',
    dev: 'Local dev: no Cloudflare Access',
  };

  async function boot() {
    try {
      me = await call('/api/me');
    } catch (error) {
      $('who').textContent = 'Not signed in: ' + error.message;
      say('Not signed in: ' + error.message, true);
      return;
    }
    $('who').replaceChildren(el('span', null, 'Signed in through Cloudflare Access'),
      el('strong', null, me.email), el('span', { class: 'role-pill' }, me.role));
    const env = $('env');
    env.textContent = ENV_NOTE[me.environment] || me.environment;
    env.className = 'env env-' + me.environment;
    env.hidden = false;
    for (const node of document.querySelectorAll('[data-owner]')) node.hidden = !isOwner();
    await show(location.hash.slice(1) || 'overview');
  }

  boot();
`;

/** One script: the shared helpers, then each view, in one closure. */
export const ADMIN_JS = `'use strict';
(() => {
${CORE_JS}${OVERVIEW_JS}${REPORTS_JS}${PLAYERS_JS}${AREAS_JS}${SEASON_JS}${CONFIG_JS}${SPONSORS_JS}${ADMINS_JS}${BOOT_JS}
})();
`;
