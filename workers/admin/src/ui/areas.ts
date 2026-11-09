// Areas and locks: map moderation on the current season (ADR 0024). One area, picked once and
// drawn on a small map with the locks, then: who wrote its top-left cell, a rollback (always
// previewed by a dry run before it is applied) or a lock.

export const AREAS_HTML = `
<section class="view" data-view="areas" hidden>
  <p class="lead">A rollback puts the map back as if the matching ops had never been accepted
    (later ops that no longer fit drop out too), and the sealed archive leaves them out as well.
    A lock stops all play in a rectangle. Both act on the current season.</p>
  <div class="row">
    <section class="card narrow-col" aria-labelledby="ma-title">
      <div class="card-head"><h2 id="ma-title">Area</h2></div>
      <div class="card-body">
        <div class="minimap" id="ma-map" role="img" aria-label="The selected area and the locks on the map"></div>
        <span class="note">Red: locked. Blue: your selection. On the 1024 × 1024 map.</span>
        <div class="area4">
          <label class="field">x<input id="ma-x" type="number" min="0"></label>
          <label class="field">y<input id="ma-y" type="number" min="0"></label>
          <label class="field">Width<input id="ma-w" type="number" min="1"></label>
          <label class="field">Height<input id="ma-h" type="number" min="1"></label>
        </div>
        <strong id="ma-line"></strong>
        <div><button type="button" id="ma-clear" class="ghost">Clear the area</button></div>
      </div>
    </section>
    <section class="card wide-col" aria-labelledby="ma-act-title">
      <div class="card-head"><h2 id="ma-act-title">Do something with it</h2></div>
      <div class="tabs" role="tablist" aria-label="Action">
        <button type="button" role="tab" class="tab" id="ma-tab-cell" aria-selected="false" aria-controls="ma-cell">Who wrote it?</button>
        <button type="button" role="tab" class="tab" id="ma-tab-rb" aria-selected="true" aria-controls="ma-rb">Roll back</button>
        <button type="button" role="tab" class="tab" id="ma-tab-lock" aria-selected="false" aria-controls="ma-lock">Lock</button>
      </div>
      <div class="panel" id="ma-cell" role="tabpanel" aria-labelledby="ma-tab-cell" hidden>
        <span class="note">Looks up the top-left cell of the area (x, y).</span>
        <div><button type="button" id="cell-go" class="primary big">Look up</button></div>
        <div id="cell-result" class="result" hidden></div>
      </div>
      <div class="panel" id="ma-rb" role="tabpanel" aria-labelledby="ma-tab-rb">
        <form id="rb-form" class="grid">
          <label class="field">Nickname<input name="nickname" maxlength="20" autocomplete="off">
            <span class="hint">Or leave it empty and give an account id.</span></label>
          <label class="field">Account id<input name="player" maxlength="128" autocomplete="off">
            <span class="hint">Neither: every player (owners only).</span></label>
          <label class="field">From<input name="from" type="datetime-local" step="1">
            <span class="hint">Your local time; empty: the season start.</span></label>
          <label class="field">To<input name="to" type="datetime-local" step="1">
            <span class="hint">Empty: now.</span></label>
          <button type="button" class="switch wide" role="switch" aria-checked="true" id="rb-limit">
            <span class="track" aria-hidden="true"></span>
            <span class="lines"><strong>Only in the area</strong><span>Off: the whole map.</span></span>
          </button>
          <div class="wide"><button type="submit" class="primary big">Preview rollback</button></div>
        </form>
        <div id="rb-result" class="result" hidden></div>
        <div id="rb-acts" class="buttons-row" hidden></div>
      </div>
      <div class="panel" id="ma-lock" role="tabpanel" aria-labelledby="ma-tab-lock" hidden>
        <span class="note">Nobody can play in a locked area. It shows hatched on the map.</span>
        <div class="chips" role="group" aria-label="For how long" id="lock-durations"></div>
        <label class="field">Until<input id="lock-until" type="datetime-local" step="1">
          <span class="hint">Your local time; empty: until unlocked.</span></label>
        <div><button type="button" id="lock-go" class="danger big">Lock area</button></div>
      </div>
    </section>
  </div>
  <div class="row">
    <section class="card wide-col" aria-labelledby="lock-title">
      <div class="card-head"><h2 id="lock-title">Locked areas</h2><span class="meta" id="lock-meta"></span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th scope="col">#</th><th scope="col">Area</th><th scope="col">Until</th>
            <th scope="col">Note</th><th scope="col" class="acts">Action</th></tr></thead>
          <tbody id="lock-list"></tbody>
        </table>
      </div>
    </section>
    <section class="card narrow-col" aria-labelledby="applied-title">
      <div class="card-head"><h2 id="applied-title">Rollbacks applied</h2><span class="meta" id="applied-meta"></span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th scope="col">Seqs</th><th scope="col">Account</th>
            <th scope="col">Area</th><th scope="col">Cells</th><th scope="col">Applied</th></tr></thead>
          <tbody id="applied-list"></tbody>
        </table>
      </div>
    </section>
  </div>
</section>
`;

export const AREAS_JS = `
  // ---- Areas and locks ----------------------------------------------------------------------

  const MAP_SIDE = 1024;
  let previewTurn = 0;
  let areaLocks = [];
  let lockFor = 'unlocked';

  function areaText(a) {
    return a ? 'x ' + a.x + ' · y ' + a.y + ', ' + a.w + ' × ' + a.h : 'whole map';
  }

  /** The picked area, null when every field is empty; throws when it is half filled. */
  function pickedArea() {
    const box = ['ma-x', 'ma-y', 'ma-w', 'ma-h'].map((id) => intOrNull($(id).value));
    if (box.every((v) => v === null)) return null;
    if (box.some((v) => v === null || Number.isNaN(v))) throw new Error('The area needs x, y, width and height.');
    return { x: box[0], y: box[1], w: box[2], h: box[3] };
  }

  function setArea(a) {
    $('ma-x').value = a ? String(a.x) : '';
    $('ma-y').value = a ? String(a.y) : '';
    $('ma-w').value = a ? String(a.w) : '';
    $('ma-h').value = a ? String(a.h) : '';
    drawMap();
  }

  function markAt(cls, a) {
    return css(el('span', { class: 'mark ' + cls }), {
      left: (a.x / MAP_SIDE) * 100 + '%', top: (a.y / MAP_SIDE) * 100 + '%',
      width: (a.w / MAP_SIDE) * 100 + '%', height: (a.h / MAP_SIDE) * 100 + '%',
    });
  }

  function drawMap() {
    let area = null;
    try { area = pickedArea(); } catch { area = null; }
    $('ma-map').replaceChildren(...areaLocks.map((l) => markAt('lock', l.area)), area ? markAt('sel', area) : '');
    $('ma-line').textContent = area ? areaText(area) + ' = ' + (area.w * area.h).toLocaleString() + ' cells' : 'No area: the whole map.';
  }

  function maTab(name) {
    for (const [tab, panel] of [['ma-tab-cell', 'ma-cell'], ['ma-tab-rb', 'ma-rb'], ['ma-tab-lock', 'ma-lock']]) {
      const on = panel === name;
      $(tab).setAttribute('aria-selected', on ? 'true' : 'false');
      $(panel).hidden = !on;
    }
  }

  /** From the report queue or a player: opens the rollback form with this account filled in. */
  function rollBack(id) {
    const form = $('rb-form');
    go('areas').then(() => {
      maTab('ma-rb');
      form.reset();
      form.elements.player.value = id;
      $('rb-limit').setAttribute('aria-checked', 'false');
      form.elements.player.focus();
      form.scrollIntoView({ block: 'center' });
    });
  }

  function rollbackFilter() {
    const f = $('rb-form').elements;
    const filter = {};
    if (f.nickname.value.trim()) filter.nickname = f.nickname.value.trim();
    else if (f.player.value.trim()) filter.player = f.player.value.trim();
    if ($('rb-limit').getAttribute('aria-checked') === 'true') {
      const area = pickedArea();
      if (!area) throw new Error('Pick an area, or turn "Only in the area" off for the whole map.');
      filter.area = area;
    }
    const from = localMs(f.from.value);
    const to = localMs(f.to.value);
    if (Number.isNaN(from) || Number.isNaN(to)) throw new Error('A time is not a date.');
    if (from !== null) filter.from = from;
    if (to !== null) filter.to = to;
    return filter;
  }

  function showPreview(p) {
    const box = $('rb-result');
    box.hidden = false;
    box.className = p.tooLarge ? 'result bad' : 'result';
    const kinds = Object.entries(p.removedByKind || {}).map(([k, n]) => n + ' ' + k).join(' · ');
    const tiles = el('div', { class: 'stat-grid' },
      [['Ops left out', String(p.removedOps)], ['Cells that change', String(p.cells)],
        ['Tiles touched', String(p.tiles)]]
        .map(([label, value]) => el('span', { class: 'stat' }, el('span', null, label), el('strong', null, value))));
    const list = el('dl', { class: 'facts' });
    facts(list, [
      ['Window', p.window ? 'seq ' + p.window.from + ' to ' + p.window.to : 'no op in that time'],
      kinds && ['By kind', kinds],
      p.unattributedOps > 0 && ['Ops naming no player', p.unattributedOps + ' (a rollback by player cannot match them)'],
      ['Cells', 'filled ' + p.filled + ', emptied ' + p.emptied + ', recoloured ' + p.recolored + ', shields ' + p.shields],
      ['Area touched', p.bounds ? areaText(p.bounds) : 'none'],
      ['Computed at', 'seq ' + p.seq + ', replayed from seq ' + p.base],
    ]);
    box.replaceChildren(el('strong', null, 'Preview: nothing has changed yet'), tiles, list,
      p.tooLarge ? el('p', null, 'Too large to apply: narrow the area or the time.') : '');
  }

  async function runPreview(filter, turn) {
    const box = $('rb-result');
    const buttons = $('rb-acts');
    while (turn === previewTurn) {
      const data = await call('/api/map/rollback/preview', filter);
      if (turn !== previewTurn) return;
      const s = data.status;
      if (s.state === 'running') {
        box.hidden = false;
        box.className = 'result';
        box.textContent = 'Replaying the log: seq ' + s.done + ' of ' + s.of + '...';
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      const p = s.preview;
      showPreview(p);
      if (p.tooLarge || (p.cells === 0 && !p.window)) return;
      buttons.replaceChildren(
        btn('Apply this rollback', 'danger solid big', async () => {
          const got = await ask({
            title: 'Apply this rollback?',
            text: p.cells + ' cells change on ' + data.canvas + ' now, for every player.',
            confirm: 'Apply rollback',
            danger: true,
          });
          if (!got) return;
          const done = await act('Rollback', () => call('/api/map/rollback/apply',
            { job: p.job, filter: data.filter, reason: got.reason }));
          if (done) {
            showPreview(done.preview);
            buttons.hidden = true;
          }
        }),
        btn('Discard', 'ghost big', () => {
          previewTurn++;
          buttons.hidden = true;
          box.hidden = true;
          call('/api/map/rollback/cancel', {}).catch(() => {});
        }),
      );
      buttons.hidden = false;
      return;
    }
  }

  $('rb-form').addEventListener('submit', (event) => {
    event.preventDefault();
    let filter;
    try { filter = rollbackFilter(); } catch (error) { return say(error.message, true); }
    $('rb-acts').hidden = true;
    previewTurn++;
    runPreview(filter, previewTurn).catch((error) => say('Preview failed: ' + error.message, true));
  });

  $('rb-form').elements.player.addEventListener('input', (event) => {
    if (event.currentTarget.value) $('rb-form').elements.nickname.value = '';
  });

  $('rb-limit').addEventListener('click', () => {
    const on = $('rb-limit').getAttribute('aria-checked') !== 'true';
    $('rb-limit').setAttribute('aria-checked', on ? 'true' : 'false');
  });

  $('cell-go').addEventListener('click', async () => {
    const box = $('cell-result');
    const x = intOrNull($('ma-x').value);
    const y = intOrNull($('ma-y').value);
    if (x === null || y === null || Number.isNaN(x) || Number.isNaN(y)) return say('Give the area an x and a y first.', true);
    try {
      const data = await call('/api/map/cell?x=' + x + '&y=' + y);
      const w = data.writer;
      box.replaceChildren(w
        ? el('span', null, 'x ' + x + ' · y ' + y + ': ' + (w.nickname || '(no nickname)') + ', team ' + w.team + ', account ',
            idLink(w.player))
        : 'Nobody known for x ' + x + ' · y ' + y + '.');
      box.hidden = false;
    } catch (error) {
      say('Lookup failed: ' + error.message, true);
    }
  });

  const LOCK_FOR = [['1h', '1 hour', 3600000], ['6h', '6 hours', 21600000], ['24h', '24 hours', 86400000],
    ['unlocked', 'Until unlocked', null]];

  function renderDurations() {
    $('lock-durations').replaceChildren(...LOCK_FOR.map(([key, label, ms]) => choice('chip big', label, lockFor === key, () => {
      lockFor = key;
      $('lock-until').value = ms === null ? '' : toLocal(Date.now() + ms);
      renderDurations();
    })));
  }

  $('lock-until').addEventListener('input', () => {
    lockFor = $('lock-until').value ? '' : 'unlocked';
    renderDurations();
  });

  $('lock-go').addEventListener('click', async () => {
    let area;
    try { area = pickedArea(); } catch (error) { return say(error.message, true); }
    if (!area) return say('Pick the area to lock first.', true);
    const until = localMs($('lock-until').value);
    if (Number.isNaN(until)) return say('Until is not a date.', true);
    const got = await ask({
      title: 'Lock ' + areaText(area) + '?',
      text: 'Nobody can play in it ' + (until === null ? 'until it is unlocked' : 'until ' + when(until)) + '.',
      confirm: 'Lock area',
      danger: true,
    });
    if (!got) return;
    const done = await act('Lock', () => call('/api/map/locks', { area, until, reason: got.reason }));
    if (done) {
      $('lock-until').value = '';
      lockFor = 'unlocked';
      renderDurations();
    }
  });

  async function unlock(lock) {
    const got = await ask({ title: 'Unlock area #' + lock.id + '?', text: areaText(lock.area), confirm: 'Unlock' });
    if (got) act('Unlock', () => call('/api/map/locks/' + lock.id + '/unlock', { reason: got.reason }));
  }

  for (const id of ['ma-x', 'ma-y', 'ma-w', 'ma-h']) $(id).addEventListener('input', drawMap);
  $('ma-clear').addEventListener('click', () => setArea(null));
  $('ma-tab-cell').addEventListener('click', () => maTab('ma-cell'));
  $('ma-tab-rb').addEventListener('click', () => maTab('ma-rb'));
  $('ma-tab-lock').addEventListener('click', () => maTab('ma-lock'));
  renderDurations();

  view('areas', 'Areas & locks', async () => {
    const [locks, rollbacks] = await Promise.all([call('/api/map/locks'), call('/api/map/rollbacks')]);
    areaLocks = locks.locks;
    drawMap();
    $('lock-meta').textContent = locks.locks.length + ' on ' + locks.canvas;
    fill($('lock-list'), locks.locks.map((l) => tr(
      '#' + l.id, areaText(l.area), el('td', { class: 'dim' }, l.until === null ? 'until unlocked' : at(l.until)),
      l.note, acts(btn('Select', 'ghost', () => setArea(l.area)), btn('Unlock', 'secondary', () => unlock(l))),
    )), 'No area is locked.');
    $('applied-meta').textContent = rollbacks.rollbacks.length + ' on ' + rollbacks.canvas;
    fill($('applied-list'), rollbacks.rollbacks.map((r) => tr(
      r.from + ' to ' + r.to,
      r.player ? idLink(r.player) : 'any',
      r.area ? areaText(r.area) : 'whole map',
      el('td', { class: 'num' }, String(r.cells)),
      el('td', { class: 'dim' }, at(r.appliedAt)),
    )), 'None applied.');
  });
`;
