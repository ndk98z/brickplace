// Overview: live counts, what needs someone now (open reports, undelivered config versions,
// locks running out, a season ending, an empty featured slot), the season, the emergency
// switches and the latest audit entries. Every item links to the view that deals with it.

export const OVERVIEW_HTML = `
<section class="view" data-view="overview" hidden>
  <div class="tiles" id="ov-tiles"></div>
  <div class="row">
    <section class="card wide-col" aria-labelledby="ov-todo-title">
      <div class="card-head"><h2 id="ov-todo-title">Needs attention</h2>
        <span class="meta" id="ov-todo-meta"></span></div>
      <ul class="todo" id="ov-todo"></ul>
    </section>
    <div class="narrow-col stack">
      <section class="card" aria-labelledby="ov-season-title">
        <div class="card-head"><h2 id="ov-season-title">Season</h2>
          <a class="push" href="#season">Manage</a></div>
        <div class="card-body">
          <div class="progress" id="ov-progress" aria-hidden="true"><span></span></div>
          <dl class="facts" id="ov-season"></dl>
        </div>
      </section>
      <section class="card" aria-labelledby="ov-cap-title">
        <div class="card-head"><h2 id="ov-cap-title">Players at once</h2></div>
        <div class="card-body">
          <p class="note">Past the cap, a player who joins watches until a place frees up; one
            idle for 10 minutes gives up their place to them. Lowering it removes nobody.</p>
          <dl class="facts" id="ov-cap"></dl>
          <div class="buttons-row" id="ov-cap-acts"></div>
        </div>
      </section>
      <section class="card emergency" aria-labelledby="ov-emer-title">
        <div class="card-head"><h2 id="ov-emer-title">Emergency</h2></div>
        <div class="card-body">
          <p class="note">Act at once, for every player. Moderators can use them; reopening a
            read-only map needs an owner. Each one asks for a reason.</p>
          <div class="buttons-row" id="ov-emer-acts"></div>
          <p class="notice red" id="ov-emer-state" hidden></p>
        </div>
      </section>
    </div>
  </div>
  <section class="card" aria-labelledby="ov-act-title">
    <div class="card-head"><h2 id="ov-act-title">Recent activity</h2>
      <a class="push" href="#audit">Full audit log</a></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th>
          <th scope="col">Reason</th></tr></thead>
        <tbody id="ov-activity"></tbody>
      </table>
    </div>
  </section>
</section>
`;

export const OVERVIEW_JS = `
  // ---- Overview -----------------------------------------------------------------------------

  const ACTIVITY_ROWS = 5;
  const SOON_MS = 24 * 60 * 60 * 1000;

  function todoItem(kind, tone, title, detail, action, href) {
    return el('li', null, el('span', { class: 'kind' }, pill(kind, tone)),
      el('span', { class: 'lines' }, el('strong', null, title), el('span', null, detail)),
      el('a', { class: 'button', href }, action));
  }

  /** What needs someone, from what every view reads anyway. */
  function attention(d) {
    const items = [];
    const now = Date.now();
    if (d.entries.length > 0) {
      const oldest = d.entries.reduce((a, e) => Math.min(a, e.firstAt), now);
      const reports = d.entries.reduce((n, e) => n + e.reports, 0);
      items.push(todoItem('Reports', 'red', d.entries.length + ' player(s) or team(s) reported',
        reports + ' open report(s), the oldest ' + ago(oldest), 'Review', '#reports'));
    }
    if (d.readOnly && d.readOnly.readOnly) {
      items.push(todoItem('Map', 'red', 'The map is read-only', d.readOnly.note || 'No move is taken.',
        'Open', '#overview'));
    }
    for (const v of (d.config ? d.config.versions : []).filter((v) => v.cancelledAt === null && v.deliveredAt === null)) {
      items.push(todoItem('Config', 'red', v.scope + '@' + v.version + ' not delivered to the canvas',
        'Retry its delivery or cancel it.', 'Open', '#config'));
    }
    for (const l of (d.locks ? d.locks.locks : []).filter((l) => l.until !== null && l.until - now < SOON_MS)) {
      items.push(todoItem('Lock', 'green', 'Area lock #' + l.id + ' ends ' + ago(l.until), areaText(l.area),
        'Check', '#areas'));
    }
    const running = d.seasons.find((s) => s.state === 'running');
    const next = d.seasons.filter((s) => s.state === 'scheduled').sort((a, b) => a.startsAt - b.startsAt)[0];
    if (running && running.endsAt - now < 7 * SOON_MS) {
      items.push(todoItem('Season', 'blue', running.canvas + ' ends ' + ago(running.endsAt),
        next ? 'Next: ' + next.canvas + ', ' + when(next.startsAt) : 'No next season is scheduled.', 'Check', '#season'));
    }
    if (next) {
      const theirs = d.sponsors.filter((s) => s.canvas === next.canvas);
      items.push(todoItem('Season', 'blue', next.canvas + ' starts ' + ago(next.startsAt),
        theirs.length + ' sponsor(s) set; check its config before it starts.', 'Check', '#config'));
    }
    const canvas = running ? running.canvas : 'canvas';
    const live = d.sponsors.filter((s) => s.canvas === canvas && !s.hidden && s.showsFrom <= now && s.showsUntil > now);
    if (live.length > 0 && !live.some((s) => s.featured)) {
      items.push(todoItem('Sponsor', 'yellow', 'No featured sponsor on screen', live.length + ' sponsor(s) live, none featured.',
        'Fix', '#sponsors'));
    }
    return items;
  }

  /** The players-at-once cap (ADR 0039): a whole number, or "No cap". Owners only. */
  async function setPlayerCap(current) {
    const got = await ask({
      title: 'Change the cap on players at once?',
      text: 'Takes effect within about 30 seconds. Lowering it removes nobody: new players ' +
        'watch until the count falls under it.',
      fields: [
        { name: 'cap', label: 'Players at once', type: 'number', min: 0, step: 1,
          value: current.cap === null ? '' : String(current.cap) },
        { name: 'off', label: 'No cap', type: 'checkbox', value: current.cap === null },
      ],
      confirm: 'Save',
    });
    if (!got) return;
    const cap = got.off ? null : got.cap === '' ? NaN : Number(got.cap);
    if (cap !== null && !(Number.isInteger(cap) && cap >= 0)) {
      say('The cap is a whole number of players, or "No cap".', true);
      return;
    }
    act('Player cap', () => call('/api/player-cap', { cap, reason: got.reason }));
  }

  view('overview', 'Overview', async () => {
    const quiet = (p) => p.catch(() => null);
    const [stats, entries, seasons, readOnly, config, locks, sponsors, audit, cap] = await Promise.all([
      quiet(call('/api/stats')),
      queue(),
      call('/api/seasons').then((d) => d.seasons).catch(() => []),
      quiet(call('/api/emergency/read-only').then((d) => d.status)),
      quiet(call('/api/config')),
      quiet(call('/api/map/locks')),
      call('/api/sponsors').then((d) => d.sponsors).catch(() => []),
      call('/api/audit').then((d) => d.entries).catch(() => []),
      quiet(call('/api/player-cap')),
    ]);
    if (config) keepConfig(config.state);
    const reports = entries.reduce((n, e) => n + e.reports, 0);
    $('ov-tiles').replaceChildren(
      tile('Playing now', stats ? stats.playing.toLocaleString() : '-',
        !stats ? 'canvas unreachable'
          : cap && cap.cap !== null ? 'of ' + cap.cap.toLocaleString() + ' at once' : 'signed in with the map open',
        Boolean(stats && cap && cap.cap !== null && stats.playing >= cap.cap)),
      tile('Phase', stats ? stats.phase : '-', 'drop rates follow the phase'),
      // Bricks against the growth threshold; filled (no brick fits) only sets the phase. An
      // older game script sends no built: then only the phase measure shows.
      stats && typeof stats.built === 'number'
        ? tile('Open area built', stats.built + '%',
          (stats.growsAt === null ? 'whole map open' : 'grows at ' + stats.growsAt + '%')
            + ' · no brick fits ' + stats.filled + '%')
        : tile('No brick fits', stats ? stats.filled + '%' : '-',
          stats ? 'of the open area: sets the phase' : 'canvas unreachable'),
      tile('Open reports', String(entries.length), reports + ' report(s) in all', entries.length > 0),
    );

    const todo = attention({ entries, seasons, readOnly, config, locks, sponsors });
    $('ov-todo-meta').textContent = todo.length + ' item(s)';
    $('ov-todo').replaceChildren(...(todo.length > 0 ? todo
      : [el('li', null, el('span', { class: 'lines' }, el('strong', null, 'Nothing needs you right now.')))]));

    const now = Date.now();
    const running = seasons.find((s) => s.state === 'running');
    const next = seasons.filter((s) => s.state === 'scheduled').sort((a, b) => a.startsAt - b.startsAt)[0];
    const share = running ? Math.min(100, Math.max(0, ((now - running.startsAt) / (running.endsAt - running.startsAt)) * 100)) : 0;
    $('ov-progress').hidden = !running;
    css($('ov-progress').firstElementChild, { width: share + '%' });
    const canvas = running ? running.canvas : 'canvas';
    const onScreen = sponsors.filter((s) => s.canvas === canvas && !s.hidden && s.showsFrom <= now && s.showsUntil > now);
    $('ov-season-title').textContent = running ? 'Season ' + running.canvas : 'Stage 0';
    facts($('ov-season'), [
      running && ['Started', at(running.startsAt)],
      running && ['Ends', at(running.endsAt)],
      ['Next season', next ? next.canvas + ', ' + when(next.startsAt) : 'none scheduled'],
      ['Config in force', configState ? 'items@' + configState.current.items + ' · growth@' + configState.current.growth : 'canvas unreachable'],
      ['Sponsors on screen', Math.min(onScreen.length, 5) + ' of 5' + (onScreen.some((s) => s.featured) ? ' · 1 featured' : '')],
      ['Map', readOnly ? (readOnly.readOnly ? 'read-only' : 'open') : 'unreachable'],
    ]);

    facts($('ov-cap'), [
      ['Cap', !cap ? 'unreachable' : cap.cap === null ? 'none' : cap.cap.toLocaleString() + ' players' +
        (cap.isDefault ? ' (default)' : '')],
      ['Playing now', stats ? stats.playing.toLocaleString() : 'canvas unreachable'],
      cap && cap.updatedAt !== null && ['Changed', at(cap.updatedAt)],
    ]);
    $('ov-cap-acts').replaceChildren(...[
      cap && isOwner() && btn('Change the cap', 'primary', () => setPlayerCap(cap)),
    ].filter(Boolean));

    const ro = readOnly !== null && readOnly.readOnly;
    $('ov-emer-acts').replaceChildren(...[
      configState && btn('Slow down: cooldown ×2', 'danger big', doubleCooldown),
      readOnly && !ro && btn('Make map read-only', 'danger big', () => setReadOnly(true)),
      ro && isOwner() && btn('Reopen the map', 'primary big', () => setReadOnly(false)),
    ].filter(Boolean));
    $('ov-emer-state').hidden = !ro;
    $('ov-emer-state').textContent = ro ? 'The map is read-only' + (readOnly.note ? ': ' + readOnly.note : '') +
      (isOwner() ? '.' : '. Only an owner reopens it.') : '';

    // A change is logged as requested, then with how it ended: show only the ending here.
    const done = audit.filter((e) => e.outcome !== 'requested');
    fill($('ov-activity'), done.slice(0, ACTIVITY_ROWS).map((e) => tr(
      el('td', { class: 'dim' }, ago(e.at)),
      e.actor,
      el('td', null, el('strong', null, e.action), e.target ? el('div', { class: 'sub' }, e.target) : ''),
      e.reason,
    )), 'Nothing logged yet.');
  });
`;
