// Sponsors and site links (ADR 0038): per season, each with a window inside it, one featured,
// in an order owners set. A preview shows what the game screen would show at a chosen time
// (at most five, featured first). Logos are uploaded here, checked by the Worker and stored in
// the private bucket; the gateway serves them to players. Moderators see all of it, change
// nothing.

export const SPONSORS_HTML = `
<section class="view" data-view="sponsors" hidden>
  <div class="view-bar">
    <div class="seg" role="group" aria-label="Season" id="sp-seasons"></div>
    <button type="button" id="sp-add" class="primary big push" data-owner>Add sponsor</button>
  </div>
  <section class="card" aria-labelledby="sp-pv-title">
    <div class="card-head"><h2 id="sp-pv-title">What players see</h2>
      <span class="meta">Up to 5 at a time, the featured one first. Changes show within a few
        minutes, with no redeploy.</span></div>
    <div class="card-body"><div class="row">
      <div class="num-field narrow-col">
        <label class="field">Preview at<input type="datetime-local" id="sp-day" step="60"></label>
        <p class="notice warn" id="sp-overflow" hidden></p>
        <p class="notice warn" id="sp-nofeature" hidden>No featured sponsor at that time.</p>
      </div>
      <div class="preview-col">
        <span class="caps">Sponsored by</span>
        <div class="shown" id="sp-shown"></div>
        <span class="note" id="sp-empty" hidden>Nothing shown: the block is hidden.</span>
      </div>
    </div></div>
  </section>
  <div class="row">
    <section class="card wide-col" aria-labelledby="sp-list-title">
      <div class="card-head"><h2 id="sp-list-title">Sponsors</h2>
        <span class="meta">Order sets the place after the featured one.</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th scope="col">Order</th><th scope="col">Sponsor</th><th scope="col">Shown</th>
            <th scope="col">Featured</th>
            <th scope="col" class="acts">Edit</th></tr></thead>
          <tbody id="sp-list"></tbody>
        </table>
      </div>
    </section>
    <section class="card narrow-col" aria-labelledby="sp-ed-title" data-owner>
      <div class="card-head"><h2 id="sp-ed-title">New sponsor</h2></div>
      <form class="card-body" id="sp-form" novalidate>
        <label class="field">Name<input name="name" maxlength="40" autocomplete="off" required></label>
        <label class="field">Link<input name="href" type="url" maxlength="500" placeholder="https://"
          autocomplete="off" required>
          <span class="hint">https only. Opens in a new tab, marked as sponsored.</span></label>
        <div class="num-field">
          <span class="label">Logo</span>
          <div class="num-row">
            <span class="mark-logo big none" id="sp-logo-mark" aria-hidden="true"></span>
            <button type="button" class="drop" id="sp-drop">Drop a PNG or WebP here, or choose a file</button>
            <input type="file" id="sp-file" accept="image/png,image/webp" hidden>
          </div>
          <span class="note" id="sp-logo-rules"></span>
          <button type="button" class="link" id="sp-logo-clear" hidden>Remove the logo (show the name)</button>
        </div>
        <label class="field">Season<select name="canvas" id="sp-canvas"></select></label>
        <div class="two">
          <label class="field">Show from<input name="from" type="datetime-local" step="60" required></label>
          <label class="field">Until<input name="until" type="datetime-local" step="60" required></label>
        </div>
        <div><button type="button" id="sp-whole" class="secondary">Whole season</button></div>
        <button type="button" class="switch" role="switch" aria-checked="false" id="sp-featured">
          <span class="track" aria-hidden="true"></span>
          <span class="lines"><strong>Featured</strong><span>Shown first and larger; one per season.</span></span>
        </button>
        <button type="button" class="switch" role="switch" aria-checked="false" id="sp-hidden">
          <span class="track" aria-hidden="true"></span>
          <span class="lines"><strong>Hidden</strong><span>Kept in the list, never shown.</span></span>
        </button>
        <ul class="errors" id="sp-errors"></ul>
        <div class="buttons-row">
          <button type="submit" class="primary big" id="sp-save">Add sponsor</button>
          <button type="button" class="danger big" id="sp-delete" hidden>Delete</button>
          <button type="button" class="ghost big" id="sp-new">New sponsor</button>
        </div>
        <span class="note">Saving asks for a reason and writes the change to the audit log.</span>
      </form>
    </section>
  </div>
  <section class="card" aria-labelledby="sp-links-title">
    <div class="card-head"><h2 id="sp-links-title">Site links</h2>
      <span class="meta">Shown in the tool column and on the contributors page. Empty falls back to
        the deploy setting, or hides the link. The operator's name, address and contact stay in
        the deploy settings.</span></div>
    <form class="card-body" id="sp-links">
      <div class="fields3">
        <label class="field">"Become a sponsor" page<input name="sponsorInfo" type="url" maxlength="500"
          placeholder="https://" autocomplete="off"></label>
        <label class="field">Donate (Ko-fi) page<input name="kofi" type="url" maxlength="500"
          placeholder="https://" autocomplete="off"></label>
      </div>
      <div data-owner><button type="submit" class="primary big">Save links</button></div>
    </form>
  </section>
</section>
`;

export const SPONSORS_JS = `
  // ---- Sponsors and site links --------------------------------------------------------------

  const STAGE0 = 'canvas';
  const SP_SHOWN = 5;
  const sp = { sponsors: [], links: { sponsorInfo: null, kofi: null }, seasons: [], canvas: null,
    editing: null, draft: null, rules: null, at: null, touched: false };

  const seasonName = (canvas) => canvas === STAGE0 ? 'Stage 0' : 'Season ' + canvas;
  const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const domainOf = (href) => { try { return new URL(href).host; } catch { return href; } };
  const initials = (name) => name.split(/\\s+/).map((w) => Array.from(w)[0] || '').join('').slice(0, 2).toUpperCase();

  function windowOf(canvas) {
    const s = sp.seasons.find((x) => x.canvas === canvas);
    return s && s.startsAt !== null ? { startsAt: s.startsAt, endsAt: s.endsAt } : null;
  }

  function stateAt(s, t) {
    if (s.hidden) return ['Hidden', ''];
    if (s.showsUntil <= t) return ['Ended', ''];
    if (s.showsFrom > t) return ['Scheduled', 'blue'];
    return ['Live', 'green'];
  }

  /** A logo, or the initials when there is none. */
  function logoMark(s, big) {
    const box = el('span', { class: 'mark-logo' + (big ? ' big' : '') + (s.logo ? '' : ' none'), 'aria-hidden': 'true' });
    if (s.logo) box.append(el('img', { src: '/api/sponsors/' + s.logo, alt: '' }));
    else box.append(initials(s.name || '?'));
    return box;
  }

  function emptyDraft(canvas) {
    const w = windowOf(canvas);
    const now = Date.now();
    return { name: '', href: '', logo: null, canvas, featured: false, hidden: false,
      showsFrom: w ? w.startsAt : now, showsUntil: w ? w.endsAt : now + 30 * DAY_MS };
  }

  // ---- The season buttons, the preview and the list ----

  function renderSeasons() {
    $('sp-seasons').replaceChildren(...sp.seasons.map((s) => choice('seg-btn',
      [el('strong', null, seasonName(s.canvas)), el('span', null, s.state + (s.startsAt ? ' · ' + new Date(s.startsAt).toLocaleDateString() + ' – ' + new Date(s.endsAt).toLocaleDateString() : ''))],
      s.canvas === sp.canvas, () => {
        sp.canvas = s.canvas;
        sp.at = null;
        if (sp.editing === null) sp.draft = emptyDraft(s.canvas);
        renderSponsors();
      })));
  }

  function renderPreview() {
    const t = sp.at === null ? Date.now() : sp.at;
    const live = sp.sponsors.filter((s) => s.canvas === sp.canvas && stateAt(s, t)[0] === 'Live');
    const ordered = live.filter((s) => s.featured).concat(live.filter((s) => !s.featured));
    const shown = ordered.slice(0, SP_SHOWN);
    $('sp-shown').replaceChildren(...shown.map((s) => el('span', { class: 'shown-one' + (s.featured ? ' featured' : '') },
      logoMark(s, false), s.name)));
    $('sp-empty').hidden = shown.length > 0;
    $('sp-overflow').hidden = live.length <= SP_SHOWN;
    $('sp-overflow').textContent = live.length + ' sponsors are live then; only the first ' + SP_SHOWN + ' in order are shown.';
    $('sp-nofeature').hidden = live.length === 0 || live.some((s) => s.featured);
  }

  function renderList() {
    const now = Date.now();
    const list = sp.sponsors.filter((s) => s.canvas === sp.canvas);
    $('sp-list-title').textContent = seasonName(sp.canvas || STAGE0) + ' · ' + list.length + ' sponsor(s)';
    const owner = isOwner();
    fill($('sp-list'), list.map((s, i) => {
      const [state, tone] = stateAt(s, now);
      const row = tr(
        el('td', null, el('span', { class: 'order' },
          btn('↑', 'secondary', () => move(s, -1), { 'aria-label': 'Move ' + s.name + ' up', disabled: !owner || i === 0 }),
          btn('↓', 'secondary', () => move(s, 1), { 'aria-label': 'Move ' + s.name + ' down', disabled: !owner || i === list.length - 1 }))),
        el('td', null, el('span', { class: 'who-cell' }, logoMark(s, false),
          el('span', { class: 'lines' }, el('strong', null, s.name), el('span', { class: 'sub nowrap' }, domainOf(s.href))))),
        el('td', { title: when(s.showsFrom) + ' until ' + when(s.showsUntil) }, pill(state, tone),
          el('div', { class: 'sub nowrap' }, day(s.showsFrom) + ' – ' + day(s.showsUntil))),
        el('td', null, choice('chip big featured-btn', s.featured ? '★ Featured' : '☆', s.featured,
          () => toggleFeatured(s), { 'aria-label': (s.featured ? 'Unfeature ' : 'Feature ') + s.name, disabled: !owner })),
        acts(owner && btn('Edit', 'secondary', () => edit(s))),
      );
      if (sp.editing === s.id) row.classList.add('on');
      return row;
    }), 'No sponsor for this season yet.' + (owner ? ' Add one; it shows from the time you set.' : ''));
  }

  // ---- The editor ----

  function fillEditor() {
    sp.touched = false;
    const d = sp.draft;
    const f = $('sp-form').elements;
    $('sp-ed-title').textContent = sp.editing === null ? 'New sponsor' : 'Edit ' + (d.name || 'sponsor');
    f.name.value = d.name;
    f.href.value = d.href;
    $('sp-canvas').replaceChildren(...sp.seasons.map((s) => el('option', { value: s.canvas, selected: s.canvas === d.canvas },
      seasonName(s.canvas))));
    f.from.value = toLocal(d.showsFrom);
    f.until.value = toLocal(d.showsUntil);
    $('sp-save').textContent = sp.editing === null ? 'Add sponsor' : 'Save changes';
    $('sp-delete').hidden = sp.editing === null;
    renderEditor();
  }

  /** Reads the form into the draft and shows what is wrong; true when it may be saved. */
  function renderEditor() {
    const d = sp.draft;
    const f = $('sp-form').elements;
    d.name = f.name.value.trim();
    d.href = f.href.value.trim();
    d.canvas = $('sp-canvas').value || d.canvas;
    d.showsFrom = localMs(f.from.value);
    d.showsUntil = localMs(f.until.value);
    $('sp-featured').setAttribute('aria-checked', d.featured ? 'true' : 'false');
    $('sp-hidden').setAttribute('aria-checked', d.hidden ? 'true' : 'false');
    const mark = $('sp-logo-mark');
    mark.replaceWith(Object.assign(logoMark(d, true), { id: 'sp-logo-mark' }));
    $('sp-logo-clear').hidden = d.logo === null;
    const errors = [];
    if (d.name.length < 1) errors.push('Give it a name (up to 40 characters).');
    let url = null;
    try { url = new URL(d.href); } catch { url = null; }
    if (!url || url.protocol !== 'https:' || !url.hostname.includes('.')) errors.push('The link must start with https:// and name a site.');
    const w = windowOf(d.canvas);
    // The time fields hold whole minutes: a start typed as the season's own lands up to a
    // minute before it, so it is taken as the season's start.
    if (w && Number.isFinite(d.showsFrom) && d.showsFrom < w.startsAt && w.startsAt - d.showsFrom < 60000) {
      d.showsFrom = w.startsAt;
    }
    if (!Number.isFinite(d.showsFrom) || !Number.isFinite(d.showsUntil) || d.showsFrom >= d.showsUntil) {
      errors.push('"Show from" must come before "Until".');
    } else if (w && (d.showsFrom < w.startsAt || d.showsUntil > w.endsAt)) {
      errors.push('The dates must fall inside ' + seasonName(d.canvas) + ' (' + when(w.startsAt) + ' to ' + when(w.endsAt) + ').');
    }
    markField(f.href, false, d.href !== '' && (!url || url.protocol !== 'https:'));
    const notes = [];
    if (d.logo === null) notes.push('No logo: the name is shown in its place.');
    const other = d.featured && sp.sponsors.find((s) => s.canvas === d.canvas && s.featured && s.id !== sp.editing);
    if (other) notes.push(other.name + ' stops being featured when you save.');
    // A new, untouched form says nothing yet; its save button stays off until it is valid.
    const quiet = sp.editing === null && !sp.touched;
    $('sp-errors').replaceChildren(...(quiet ? [] : errors).map((e) => el('li', { role: 'alert' }, e)),
      ...notes.map((n) => el('li', { class: 'notice warn' }, n)));
    $('sp-save').disabled = errors.length > 0;
    return errors.length === 0;
  }

  function edit(s) {
    sp.editing = s.id;
    sp.draft = Object.assign({}, s);
    fillEditor();
    renderList();
    $('sp-form').elements.name.focus();
  }

  function startNew() {
    sp.editing = null;
    sp.draft = emptyDraft(sp.canvas || STAGE0);
    fillEditor();
    renderList();
  }

  async function saveSponsor() {
    if (!renderEditor()) return;
    const d = sp.draft;
    const got = await ask({
      title: (sp.editing === null ? 'Add ' : 'Save ') + d.name + '?',
      text: seasonName(d.canvas) + ', shown from ' + when(d.showsFrom) + ' until ' + when(d.showsUntil) +
        (d.featured ? ', featured' : '') + (d.hidden ? ', hidden' : '') + '. Players see it within a few minutes.',
      confirm: sp.editing === null ? 'Add sponsor' : 'Save changes',
      reasonHint: 'Kept in the audit log for good, e.g. "contract signed" or "logo update".',
    });
    if (!got) return;
    const body = { canvas: d.canvas, name: d.name, href: d.href, logo: d.logo, showsFrom: d.showsFrom,
      showsUntil: d.showsUntil, featured: d.featured, hidden: d.hidden, reason: got.reason };
    if (sp.editing !== null) body.id = sp.editing;
    const done = await act(sp.editing === null ? 'Add sponsor' : 'Save sponsor', () => call('/api/sponsors', body));
    if (done && done.sponsor) {
      sp.canvas = done.sponsor.canvas;
      edit(done.sponsor);
    }
  }

  async function deleteSponsor() {
    const s = sp.sponsors.find((x) => x.id === sp.editing);
    if (!s) return;
    const got = await ask({ title: 'Delete ' + s.name + '?', text: 'It leaves the game screen within a few ' +
      'minutes. Its logo file is kept.', confirm: 'Delete', danger: true,
      reasonHint: 'Kept in the audit log for good, e.g. "contract ended".' });
    if (!got) return;
    const done = await act('Delete sponsor', () => call('/api/sponsors/' + s.id + '/delete', { reason: got.reason }));
    if (done) startNew();
  }

  async function toggleFeatured(s) {
    const on = !s.featured;
    const got = await ask({ title: (on ? 'Feature ' : 'Unfeature ') + s.name + '?',
      text: on ? 'It is shown first and larger; any other featured sponsor of the season stops being featured.' : '',
      confirm: on ? 'Feature' : 'Unfeature' });
    if (!got) return;
    act('Featured', () => call('/api/sponsors', { id: s.id, canvas: s.canvas, name: s.name, href: s.href, logo: s.logo,
      showsFrom: s.showsFrom, showsUntil: s.showsUntil, featured: on, hidden: s.hidden, reason: got.reason }));
  }

  async function move(s, by) {
    try {
      await call('/api/sponsors/' + s.id + '/move', { by, reason: '' });
    } catch (error) {
      say('Move failed: ' + error.message, true);
    }
    await reload();
  }

  // ---- Logos ----

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  async function uploadLogo(file) {
    if (!file) return;
    const rules = sp.rules;
    if (rules && !rules.types.includes(file.type)) return say('Logos must be PNG or WebP.', true);
    if (rules && file.size > rules.maxBytes) return say('That file is larger than ' + rules.maxBytes / 1024 + ' KB.', true);
    $('sp-drop').textContent = 'Uploading ' + file.name + '...';
    try {
      const done = await call('/api/sponsors/logo', { data: toBase64(await file.arrayBuffer()) });
      sp.draft.logo = done.logo;
      $('sp-drop').textContent = file.name + ' · ' + Math.ceil(done.bytes / 1024) + ' KB · ' + done.width + ' × ' +
        done.height + '. Choose another to replace it.';
    } catch (error) {
      $('sp-drop').textContent = 'Drop a PNG or WebP here, or choose a file';
      say('Logo refused: ' + error.message, true);
    }
    renderEditor();
  }

  $('sp-drop').addEventListener('click', () => $('sp-file').click());
  $('sp-file').addEventListener('change', (event) => {
    uploadLogo(event.currentTarget.files[0]);
    event.currentTarget.value = '';
  });
  $('sp-drop').addEventListener('dragover', (event) => {
    event.preventDefault();
    $('sp-drop').classList.add('over');
  });
  $('sp-drop').addEventListener('dragleave', () => $('sp-drop').classList.remove('over'));
  $('sp-drop').addEventListener('drop', (event) => {
    event.preventDefault();
    $('sp-drop').classList.remove('over');
    uploadLogo(event.dataTransfer.files[0]);
  });
  $('sp-logo-clear').addEventListener('click', () => {
    sp.draft.logo = null;
    renderEditor();
  });

  // ---- Wiring ----

  $('sp-form').addEventListener('input', () => {
    sp.touched = true;
    renderEditor();
  });
  $('sp-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveSponsor();
  });
  $('sp-canvas').addEventListener('change', () => {
    const w = windowOf($('sp-canvas').value);
    if (w) {
      $('sp-form').elements.from.value = toLocal(w.startsAt);
      $('sp-form').elements.until.value = toLocal(w.endsAt);
    }
    renderEditor();
  });
  $('sp-whole').addEventListener('click', () => {
    const w = windowOf(sp.draft.canvas);
    if (!w) return say('Stage 0 has no end: set the dates by hand.', true);
    $('sp-form').elements.from.value = toLocal(w.startsAt);
    $('sp-form').elements.until.value = toLocal(w.endsAt);
    renderEditor();
  });
  $('sp-featured').addEventListener('click', () => {
    sp.draft.featured = !sp.draft.featured;
    renderEditor();
  });
  $('sp-hidden').addEventListener('click', () => {
    sp.draft.hidden = !sp.draft.hidden;
    renderEditor();
  });
  $('sp-delete').addEventListener('click', deleteSponsor);
  $('sp-new').addEventListener('click', startNew);
  $('sp-add').addEventListener('click', () => {
    startNew();
    $('sp-form').elements.name.focus();
  });
  $('sp-day').addEventListener('input', () => {
    const t = localMs($('sp-day').value);
    sp.at = Number.isFinite(t) ? t : null;
    renderPreview();
  });

  $('sp-links').addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = event.currentTarget.elements;
    const body = { sponsorInfo: f.sponsorInfo.value.trim() || null, kofi: f.kofi.value.trim() || null };
    const got = await ask({ title: 'Save the site links?', text: '"Become a sponsor": ' + (body.sponsorInfo || 'the deploy setting') +
      '\\nDonate: ' + (body.kofi || 'the deploy setting'), confirm: 'Save links' });
    if (got) act('Site links', () => call('/api/site-links', Object.assign(body, { reason: got.reason })));
  });

  function renderSponsors() {
    renderSeasons();
    if (sp.at === null) {
      const s = sp.seasons.find((x) => x.canvas === sp.canvas);
      const t = s && s.startsAt > Date.now() ? s.startsAt : Date.now();
      $('sp-day').value = toLocal(t);
      sp.at = t;
    }
    renderPreview();
    renderList();
  }

  view('sponsors', 'Sponsors & links', async () => {
    const [data, seasons] = await Promise.all([call('/api/sponsors'), call('/api/seasons').then((d) => d.seasons)]);
    sp.sponsors = data.sponsors;
    sp.links = data.links;
    sp.rules = data.logoRules;
    const list = seasons.slice().sort((a, b) => a.startsAt - b.startsAt)
      .map((s) => ({ canvas: s.canvas, state: s.state, startsAt: s.startsAt, endsAt: s.endsAt }));
    // Stage 0 plays until the first season starts, with no end of its own: listed while it
    // plays, or while it still has sponsors.
    const started = seasons.some((s) => s.state !== 'scheduled');
    if (!started || sp.sponsors.some((s) => s.canvas === STAGE0)) {
      list.unshift({ canvas: STAGE0, state: started ? 'ended' : 'running', startsAt: null, endsAt: null });
    }
    sp.seasons = list;
    if (!sp.seasons.some((s) => s.canvas === sp.canvas)) {
      const running = sp.seasons.find((s) => s.state === 'running');
      sp.canvas = running ? running.canvas : (sp.seasons[0] ? sp.seasons[0].canvas : STAGE0);
      sp.at = null;
    }
    const r = sp.rules;
    $('sp-logo-rules').textContent = 'PNG or WebP, up to ' + r.maxBytes / 1024 + ' KB, ' + r.minSide + ' to ' + r.maxSide +
      ' px a side. Stored on our own storage and served from this site, so players never load anything from the ' +
      'sponsor\\'s server. Still images only; no SVG.';
    const f = $('sp-links').elements;
    f.sponsorInfo.value = sp.links.sponsorInfo || '';
    f.kofi.value = sp.links.kofi || '';
    f.sponsorInfo.disabled = !isOwner();
    f.kofi.disabled = !isOwner();
    const still = sp.editing !== null && sp.sponsors.find((s) => s.id === sp.editing);
    if (still) sp.draft = Object.assign({}, still);
    else if (sp.editing !== null || sp.draft === null) {
      sp.editing = null;
      sp.draft = emptyDraft(sp.canvas);
    }
    fillEditor();
    renderSponsors();
  });
`;
