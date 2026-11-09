// Season: each season is a canvas of its own (ADR 0021). The registry routes players to the
// season whose start passed last and its canvas enforces the end; every change here writes
// both. Also the emergency read-only switch, the Stage 0 canvas's end and a season's archive
// (ADR 0021, 0024): archive-only removals and "seal now".

export const SEASON_HTML = `
<section class="view" data-view="season" hidden>
  <section class="card" aria-labelledby="ss-title">
    <div class="card-head"><h2 id="ss-title">Timeline</h2><span class="meta" id="ss-meta"></span></div>
    <div class="card-body"><ol class="timeline" id="ss-list"></ol></div>
  </section>
  <section class="card" aria-labelledby="ss-sel-title">
    <div class="card-head"><h2 id="ss-sel-title">Season</h2><span id="ss-sel-pill"></span></div>
    <div class="card-body">
      <div class="progress" id="ss-progress" aria-hidden="true"><span></span></div>
      <dl class="facts" id="ss-sel"></dl>
      <div class="buttons-row" id="ss-sel-acts"></div>
    </div>
  </section>
  <div class="pair">
    <section class="card" aria-labelledby="ns-title" data-owner>
      <div class="card-head"><h2 id="ns-title">New season</h2></div>
      <div class="card-body">
        <form id="ns-form" class="grid">
          <label class="field wide">Canvas name<input name="canvas" required maxlength="32"
            pattern="[a-z0-9][a-z0-9\\-]{0,31}" autocomplete="off" placeholder="s2">
            <span class="hint">Lower-case letters, digits and -.</span></label>
          <label class="field">Starts<input name="startsAt" type="datetime-local" step="1" required></label>
          <label class="field">Ends<input name="endsAt" type="datetime-local" step="1" required></label>
          <p class="note wide">Your local time. The settings in force now carry over to the new
            canvas; change them under Game config before it starts.</p>
          <div class="wide"><button type="submit" class="primary big">Create season</button></div>
        </form>
      </div>
    </section>
    <section class="card" aria-labelledby="s0-title" data-owner>
      <div class="card-head"><h2 id="s0-title">Stage 0 canvas</h2></div>
      <div class="card-body">
        <p class="note">Creating or moving the earliest season sets the Stage 0 canvas to end at
          its start. If that failed and the start has passed, end it here. Pages still open on it
          stop playing for good.</p>
        <div><button type="button" id="s0-end" class="danger big">End the Stage 0 canvas now</button></div>
      </div>
    </section>
  </div>
  <section class="card" aria-labelledby="ar-title">
    <div class="card-head"><h2 id="ar-title">Archive</h2><span class="meta" id="ar-meta"></span></div>
    <div class="card-body">
      <p class="note">What the sealed archive leaves out, and when it is sealed (90 days after the
        end, or earlier on request). Removals are for content found after the end, when a rollback
        is no longer possible; each covers the ops whose anchor cell lies in its area, over a seq
        window. Once sealing starts the list is fixed.</p>
      <form id="ar-load" class="inline">
        <label class="field">Season canvas<input name="canvas" required maxlength="32"
          autocomplete="off" placeholder="s1"></label>
        <button type="submit" class="primary big">Show archive</button>
      </form>
      <dl class="facts" id="ar-facts" hidden></dl>
    </div>
    <div class="table-wrap" id="ar-table" hidden>
      <table>
        <thead><tr><th scope="col">#</th><th scope="col">Seqs</th><th scope="col">Area</th>
          <th scope="col">Player</th><th scope="col" class="acts">Action</th></tr></thead>
        <tbody id="ar-list"></tbody>
      </table>
    </div>
    <div class="card-foot" id="ar-add-box" hidden>
      <form id="ar-add" class="grid">
        <label class="field wide">Player nickname<input name="nickname" maxlength="64" autocomplete="off">
          <span class="hint">Empty: every player's ops in the area (owners only).</span></label>
        <label class="field">x<input name="x" type="number" min="0" required></label>
        <label class="field">y<input name="y" type="number" min="0" required></label>
        <label class="field">Width<input name="w" type="number" min="1" required></label>
        <label class="field">Height<input name="h" type="number" min="1" required></label>
        <label class="field">From seq<input name="from" type="number" min="1">
          <span class="hint">Empty: 1.</span></label>
        <label class="field">To seq<input name="to" type="number" min="1">
          <span class="hint">Empty: the last (while open, the latest so far).</span></label>
        <div class="wide acts-in">
          <button type="button" id="ar-seal" class="danger big">Seal now</button>
          <button type="submit" class="primary big">Add removal</button>
        </div>
      </form>
    </div>
  </section>
</section>
`;

export const SEASON_JS = `
  // ---- Season -------------------------------------------------------------------------------

  let archiveCanvas = null;
  const SEASON_TONE = { running: 'green', scheduled: 'blue', ended: '' };

  async function changeEnd(s) {
    const got = await ask({
      title: 'Change the end of ' + s.canvas + '?',
      text: 'Now ' + when(s.endsAt) + '.',
      fields: [{ name: 'endsAt', label: 'New end (your local time)', type: 'datetime-local',
        value: toLocal(s.endsAt), required: true }],
      confirm: 'Change end',
    });
    if (!got) return;
    const endsAt = localMs(got.endsAt);
    if (!Number.isFinite(endsAt)) return say('That is not a date.', true);
    act('Change end', () => call('/api/seasons/' + encodeURIComponent(s.canvas) + '/schedule',
      { endsAt, reason: got.reason }));
  }

  async function endSeason(s) {
    const got = await ask({
      title: 'End season ' + s.canvas + ' now?',
      text: 'Its map stops taking moves for good. This cannot be undone.',
      confirm: 'End season',
      danger: true,
    });
    if (got) act('End season', () => call('/api/seasons/' + encodeURIComponent(s.canvas) + '/end', { reason: got.reason }));
  }

  /** The emergency switch: the canvas refuses every move while read-only, and keeps serving the map. */
  async function setReadOnly(on) {
    const got = await ask(on
      ? { title: 'Make the map read-only?', text: 'Every move is refused for every player, at once, ' +
          'until an owner reopens it. Players see the reason.', confirm: 'Make read-only', danger: true }
      : { title: 'Reopen the map?', text: 'Players can move again at once.', confirm: 'Reopen' });
    if (got) {
      act(on ? 'Read-only' : 'Reopen', () => call('/api/emergency/read-only', { readOnly: on, reason: got.reason }));
    }
  }

  $('ns-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const f = form.elements;
    const startsAt = localMs(f.startsAt.value);
    const endsAt = localMs(f.endsAt.value);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return say('Both times are needed.', true);
    if (endsAt <= startsAt) return say('The end must come after the start.', true);
    const canvas = f.canvas.value;
    const got = await ask({
      title: 'Create season ' + canvas + '?',
      text: 'From ' + when(startsAt) + ' to ' + when(endsAt) + '.',
      confirm: 'Create season',
    });
    if (!got) return;
    const result = await act('New season', () => call('/api/seasons', { canvas, startsAt, endsAt, reason: got.reason }));
    if (!result) return;
    form.reset();
    if (!result.carried) return;
    // The settings in force carry over to the new canvas (ADR 0022); say what did not.
    const failed = result.carried.filter((c) => c.error);
    const made = result.carried.filter((c) => typeof c.carried === 'number');
    if (failed.length > 0) {
      say('Season created, but these settings did not carry over: ' +
        failed.map((c) => c.scope + ' (' + c.error + ')').join(', ') +
        '. Make them again under Game config, for the next season, before it starts.', true);
    } else if (made.length > 0) {
      say('Season created; carried over: ' + made.map((c) => c.scope + '@' + c.carried).join(', ') + '.');
    }
  });

  $('s0-end').addEventListener('click', async () => {
    const got = await ask({
      title: 'End the Stage 0 canvas now?',
      text: 'Pages still open on it stop playing for good.',
      confirm: 'End Stage 0',
      danger: true,
    });
    if (got) act('End Stage 0', () => call('/api/stage0/end', { reason: got.reason }));
  });

  // ---- Archive ----

  function openArchive(canvas) {
    archiveCanvas = canvas;
    $('ar-load').elements.canvas.value = canvas;
    loadArchive().then(() => $('ar-title').scrollIntoView({ block: 'start', behavior: 'smooth' }))
      .catch((error) => say('Archive: ' + error.message, true));
  }

  async function loadArchive() {
    const shown = archiveCanvas !== null;
    $('ar-facts').hidden = !shown;
    $('ar-table').hidden = !shown;
    if (!shown) {
      $('ar-add-box').hidden = true;
      $('ar-meta').textContent = '';
      return;
    }
    const path = '/api/seasons/' + encodeURIComponent(archiveCanvas);
    const a = await call(path + '/archive');
    const sealed = a.phase === 'sealed';
    $('ar-meta').textContent = a.canvas;
    facts($('ar-facts'), [
      ['Phase', pill(a.phase, sealed ? '' : a.phase === 'open' ? 'green' : 'blue')],
      a.endsAt !== null && ['Ends', at(a.endsAt)],
      [a.finalSeq !== null ? 'Last seq' : 'Seq so far', String(a.finalSeq !== null ? a.finalSeq : a.seq)],
      ['Rollbacks left out too', String(a.rollbacks)],
      ['Sealing', sealed ? 'sealed ' + when(a.sealedAt)
        : a.sealRequested ? 'requested: runs at the next maintenance pass'
        : a.phase === 'open' ? 'after the end'
        : '90 days after the end'],
    ]);
    fill($('ar-list'), a.removals.map((r, index) => tr(
      String(index), r.from + ' to ' + r.to, areaText(r.area), r.player || 'every player',
      acts(!sealed && btn('Drop', 'secondary', () => dropRemoval(a.canvas, index))),
    )), 'Nothing left out.');
    $('ar-add-box').hidden = sealed;
    $('ar-seal').hidden = !(isOwner() && a.phase !== 'open' && !sealed && !a.sealRequested);
  }

  async function dropRemoval(canvas, index) {
    const got = await ask({
      title: 'Drop removal #' + index + ' of ' + canvas + '?',
      text: 'Its ops go back into the archive.',
      confirm: 'Drop removal',
    });
    if (got) {
      act('Drop removal', () => call('/api/seasons/' + encodeURIComponent(canvas) + '/removals',
        { drop: index, reason: got.reason }));
    }
  }

  $('ar-load').addEventListener('submit', (event) => {
    event.preventDefault();
    archiveCanvas = event.currentTarget.elements.canvas.value.trim();
    loadArchive().catch((error) => say('Archive: ' + error.message, true));
  });

  $('ar-add').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const f = form.elements;
    const add = {
      area: { x: Number(f.x.value), y: Number(f.y.value), w: Number(f.w.value), h: Number(f.h.value) },
      from: intOrNull(f.from.value),
      to: intOrNull(f.to.value),
    };
    if (f.nickname.value.trim() !== '') add.nickname = f.nickname.value.trim();
    const whose = add.nickname ? add.nickname + "'s ops" : "EVERY player's ops";
    const got = await ask({
      title: 'Leave ops out of the archive?',
      text: whose + ' in ' + areaText(add.area) + ' are left out of the archive of ' + archiveCanvas + '.',
      confirm: 'Add removal',
      danger: !add.nickname,
    });
    if (!got) return;
    const done = await act('Add removal', () => call('/api/seasons/' + encodeURIComponent(archiveCanvas) + '/removals',
      { add, reason: got.reason }));
    if (done) form.reset();
  });

  $('ar-seal').addEventListener('click', async () => {
    const got = await ask({
      title: 'Seal the archive of ' + archiveCanvas + ' now?',
      text: 'No removal can be added after it, and the season\\'s player ids are dropped for good.',
      confirm: 'Seal now',
      danger: true,
    });
    if (got) act('Seal', () => call('/api/seasons/' + encodeURIComponent(archiveCanvas) + '/seal', { reason: got.reason }));
  });

  /** The season shown under the timeline; the running one until another is picked. */
  let seasonPick = null;

  function showSeason(s, sponsors, config) {
    $('ss-sel-title').textContent = s ? 'Season ' + s.canvas : 'Stage 0';
    $('ss-sel-pill').replaceChildren(s ? pill(s.state, SEASON_TONE[s.state]) : pill('running', 'green'));
    const now = Date.now();
    const running = s && s.state === 'running';
    $('ss-progress').hidden = !running;
    if (running) {
      css($('ss-progress').firstElementChild,
        { width: Math.min(100, ((now - s.startsAt) / (s.endsAt - s.startsAt)) * 100) + '%' });
    }
    const canvas = s ? s.canvas : 'canvas';
    const theirs = sponsors.filter((x) => x.canvas === canvas);
    facts($('ss-sel'), s ? [
      ['Canvas', s.canvas],
      ['Starts', at(s.startsAt)],
      ['Ends', el('span', null, at(s.endsAt), ' (' + ago(s.endsAt) + ')')],
      ['Game config', running && config
        ? 'items@' + config.current.items + ' · growth@' + config.current.growth + ' in force'
        : s.state === 'scheduled' ? 'set it under Game config, next season' : 'kept with its canvas'],
      ['Sponsors', theirs.length + ' set' + (theirs.some((x) => x.featured) ? ', 1 featured' : '')],
    ] : [['Canvas', 'Stage 0: no season has started yet']]);
    $('ss-sel-acts').replaceChildren(...[
      s && s.state !== 'ended' && isOwner() && btn('Change end', 'secondary big', () => changeEnd(s)),
      running && isOwner() && btn('End season now', 'danger big', () => endSeason(s)),
      s && s.state === 'scheduled' && btn('Its game config', 'secondary big', () => {
        cf.target = s.canvas;
        cf.filledKey = null;
        go('config');
      }),
      btn('Its sponsors', 'secondary big', () => {
        sp.canvas = canvas;
        sp.at = null;
        go('sponsors');
      }),
      s && btn('Its archive', 'ghost big', () => openArchive(s.canvas)),
    ].filter(Boolean));
  }

  view('season', 'Season', async () => {
    const [data, sponsors] = await Promise.all([
      call('/api/seasons'),
      call('/api/sponsors').then((d) => d.sponsors).catch(() => []),
      loadArchive(),
    ]);
    const seasons = data.seasons.slice().sort((a, b) => a.startsAt - b.startsAt);
    const running = seasons.find((s) => s.state === 'running');
    $('ss-meta').textContent = running ? 'players are on ' + running.canvas : 'players are on Stage 0';
    let picked = seasons.find((s) => s.canvas === seasonPick) || running || null;
    if (!picked && seasons.length > 0) picked = seasons.find((s) => s.state === 'scheduled') || seasons[seasons.length - 1];
    seasonPick = picked ? picked.canvas : null;
    $('ss-list').replaceChildren(...(seasons.length > 0 ? seasons.map((s) => el('li', null, choice('season-card', [
      el('span', { class: 'head' }, el('strong', null, s.canvas), pill(s.state, SEASON_TONE[s.state])),
      el('span', null, new Date(s.startsAt).toLocaleDateString() + ' – ' + new Date(s.endsAt).toLocaleDateString()),
      el('span', { class: 'sub' }, s.state === 'running' ? 'ends ' + ago(s.endsAt)
        : s.state === 'scheduled' ? 'starts ' + ago(s.startsAt) : 'ended ' + ago(s.endsAt)),
    ], s.canvas === seasonPick, () => {
      seasonPick = s.canvas;
      reload();
    }))) : [el('li', { class: 'notice info' }, 'No season yet: players are on the Stage 0 canvas.')]));
    showSeason(picked, sponsors, configState);
  });
`;
