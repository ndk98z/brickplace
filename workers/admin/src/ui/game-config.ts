// Game config: item config (cooldown, hold, drop rates) and the open-area growth rule, as
// versions (ADR 0022), edited as forms rather than JSON. The form starts from the settings in
// force on the chosen canvas (the current one, or the next season's before it starts); the
// review beside it lists what would change and refuses what the core would refuse
// (checkItemConfig, checkGrowth: the server checks again). A new version takes effect at its
// time, or now; versions are never edited or deleted, and one that has not taken effect can be
// cancelled.

export const CONFIG_HTML = `
<section class="view" data-view="config" hidden>
  <div class="view-bar">
    <div class="seg" role="group" aria-label="Which canvas" id="cf-targets"></div>
    <button type="button" id="cf-double" class="danger big push">Slow down: cooldown ×2</button>
  </div>
  <div class="row">
    <section class="card wide-col" aria-labelledby="cf-edit-title">
      <div class="card-head"><h2 id="cf-edit-title">Change settings</h2>
        <span class="meta" id="cf-now-meta"></span></div>
      <div class="tabs" role="tablist" aria-label="Settings group">
        <button type="button" role="tab" class="tab" id="cf-tab-items" aria-selected="true"
          aria-controls="cf-items">Items &amp; drop rates</button>
        <button type="button" role="tab" class="tab" id="cf-tab-growth" aria-selected="false"
          aria-controls="cf-growth">Open area growth</button>
      </div>
      <div class="panel" id="cf-items" role="tabpanel" aria-labelledby="cf-tab-items">
        <div class="fields3">
          <div class="num-field">
            <label for="cf-cooldown">Cooldown</label>
            <div class="num-row"><input id="cf-cooldown" class="num" type="number" min="0.001"
              step="any" inputmode="decimal"><span class="unit">seconds</span></div>
            <div class="chips" id="cf-chips"></div>
            <span class="note">One item per cooldown while the hold has room.</span>
          </div>
          <div class="num-field">
            <label for="cf-hold">Hold size</label>
            <div class="num-row">
              <button type="button" class="step-btn" id="cf-hold-down" aria-label="One less">−</button>
              <input id="cf-hold" class="num short" type="number" min="1" max="255" step="1">
              <button type="button" class="step-btn" id="cf-hold-up" aria-label="One more">+</button>
            </div>
            <span class="note">Most items a player holds, 1 to 255.</span>
          </div>
          <div class="num-field">
            <label for="cf-start">Items at start</label>
            <div class="num-row">
              <button type="button" class="step-btn" id="cf-start-down" aria-label="One less">−</button>
              <input id="cf-start" class="num short" type="number" min="0" step="1">
              <button type="button" class="step-btn" id="cf-start-up" aria-label="One more">+</button>
            </div>
            <span class="note">What a new player gets at once.</span>
          </div>
        </div>
        <div class="num-field">
          <h3>Drop rates</h3>
          <span class="note">Weights, not percents: each row is divided by its own total. The
            share each item gets is shown under it.</span>
          <div class="rates">
            <table>
              <thead><tr><th scope="col">Phase</th>
                <th scope="col"><span class="swatch k-brick" aria-hidden="true"></span>Brick</th>
                <th scope="col"><span class="swatch k-single" aria-hidden="true"></span>Single</th>
                <th scope="col"><span class="swatch k-hammer" aria-hidden="true"></span>Hammer</th>
                <th scope="col"><span class="swatch k-shield" aria-hidden="true"></span>Shield</th>
                <th scope="col">Mix</th></tr></thead>
              <tbody id="cf-rates"></tbody>
            </table>
          </div>
        </div>
        <div class="buttons-row">
          <button type="button" id="cf-items-reset" class="secondary big">Back to the settings in force</button>
        </div>
      </div>
      <div class="panel" id="cf-growth" role="tabpanel" aria-labelledby="cf-tab-growth" hidden>
        <div class="fields3">
          <div class="num-field">
            <label for="cf-at">Grow when the open area is</label>
            <div class="num-row"><input id="cf-at" class="num" type="number" min="1" max="100"
              step="1"><span class="unit">% filled</span></div>
            <span class="note">1 to 100.</span>
          </div>
          <div class="num-field">
            <label for="cf-step">Cells added on each side</label>
            <div class="num-row"><input id="cf-step" class="num" type="number" min="1"
              step="1"><span class="unit">cells</span></div>
            <span class="note">A positive whole number.</span>
          </div>
        </div>
        <div class="soft">
          <strong>How the open area grows on the 1024² map</strong>
          <div class="grow-steps" id="cf-grow-steps" aria-hidden="true"></div>
          <span class="note" id="cf-grow-note"></span>
        </div>
        <div class="buttons-row">
          <button type="button" id="cf-growth-reset" class="secondary big">Back to the settings in force</button>
        </div>
      </div>
    </section>
    <section class="card narrow-col" aria-labelledby="cf-review-title">
      <div class="card-head"><h2 id="cf-review-title">Review</h2><span id="cf-next-version"></span></div>
      <div class="card-body">
        <span class="note" id="cf-target-line"></span>
        <p class="notice info" id="cf-none">No change yet. Edit a value; what changes shows here.</p>
        <ul class="changes" id="cf-changes"></ul>
        <ul class="errors" id="cf-errors"></ul>
        <p class="notice warn" id="cf-other" hidden></p>
        <fieldset class="plain">
          <legend class="label">Takes effect</legend>
          <div class="chips">
            <button type="button" class="chip big" id="cf-when-now" aria-pressed="true">Now</button>
            <button type="button" class="chip big" id="cf-when-at" aria-pressed="false">At a set time</button>
          </div>
          <label class="field" id="cf-at-box" hidden>Date and time, your local time
            <input type="datetime-local" id="cf-at-time" step="1"></label>
        </fieldset>
        <button type="button" id="cf-submit" class="primary full">Schedule</button>
        <p class="note" id="cf-owner-note" hidden>Only owners change the game config.</p>
      </div>
    </section>
  </div>
  <section class="card" aria-labelledby="cf-ver-title">
    <div class="card-head"><h2 id="cf-ver-title">Versions</h2><span class="meta">newest first ·
      never edited or deleted; one that has not taken effect can be cancelled</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th scope="col">Version</th><th scope="col">State</th><th scope="col">Effective</th>
          <th scope="col">What changed</th><th scope="col">By · reason</th>
          <th scope="col" class="acts">Action</th></tr></thead>
        <tbody id="cf-versions"></tbody>
      </table>
    </div>
  </section>
</section>
`;

export const CONFIG_JS = `
  // ---- Game config --------------------------------------------------------------------------

  /** The current canvas's config state (items, growth, current, versions), once loaded. */
  let configState = null;
  const PHASE_NAMES = ['settling', 'contested', 'saturated'];
  const PHASE_LABEL = {
    settling: ['Settling', 'open area filling up'],
    contested: ['Contested', 'most room taken'],
    saturated: ['Saturated', 'map nearly full'],
  };
  const KIND_NAMES = ['Brick', 'Single', 'Hammer', 'Shield'];
  const KIND_CLASS = ['k-brick', 'k-single', 'k-hammer', 'k-shield'];
  /** The core's limits (packages/core items.ts): a u32 of ms, and a rate total of 2^20. */
  const MAX_COOLDOWN_MS = 4294967295;
  const MAX_RATE_TOTAL = 1048576;
  const COOLDOWN_CHIPS = [30, 45, 60, 90, 120];

  /**
   * The form: which canvas (null: the current one), the next scheduled season, that canvas's
   * state and versions, the open tab, when the version takes effect, and what the form was
   * last filled from (it is refilled only when that changes, so a failed save keeps the edits).
   */
  const cf = { target: null, next: null, base: null, versions: [], canvas: '', tab: 'items',
    when: 'now', rates: {}, filledKey: null };

  /** Keeps the config read from /api/config, and warns when the canvas holds damaged versions. */
  function keepConfig(state) {
    configState = state;
    if (state && state.unreadable && state.unreadable.length > 0) {
      say('The canvas holds damaged config versions it ignores: ' + state.unreadable.join(', ') +
        '. Their numbers stay taken; tell the operator.', true);
    }
    return state;
  }

  async function loadConfig() {
    return keepConfig((await call('/api/config')).state);
  }

  async function doubleCooldown() {
    const now = configState ? configState.items.cooldown / 1000 + ' s' : 'the current cooldown';
    const got = await ask({
      title: 'Double the cooldown now?',
      text: 'From ' + now + ', for every player, starting now.',
      confirm: 'Double cooldown',
      danger: true,
    });
    if (!got) return;
    const result = await act('Cooldown ×2', () => call('/api/emergency/cooldown-double', { reason: got.reason }));
    if (result && result.pending && result.pending.length > 0) {
      say('Cooldown doubled. ' + result.pending.length + ' later item version(s) will still take ' +
        'over at their time; cancel them under Game config if needed.', true);
    }
  }

  // ---- What a version says, in words ----

  function itemLines(c) {
    return [
      ['Cooldown', c.cooldown / 1000 + ' s'],
      ['Hold size', String(c.hold)],
      ['Items at start', String(c.startItems)],
    ].concat(PHASE_NAMES.map((p) => [PHASE_LABEL[p][0] + ' rates', c.rates[p].join(' · ')]));
  }

  function growthLines(g) {
    return [['Grow at', g.atPercent + '% filled'], ['Cells per side', String(g.step)]];
  }

  function linesOf(scope, c) {
    return scope === 'items' ? itemLines(c) : growthLines(c);
  }

  /** What differs between two settings of one scope: label, from, to. */
  function changesBetween(scope, a, b) {
    const before = linesOf(scope, a);
    return linesOf(scope, b).map((line, i) => ({ label: line[0], from: before[i][1], to: line[1] }))
      .filter((c) => c.from !== c.to);
  }

  // ---- The form ----

  function buildRates() {
    $('cf-rates').replaceChildren(...PHASE_NAMES.map((phase) => {
      const inputs = KIND_NAMES.map((kind) => el('input', {
        type: 'number', class: 'num short', min: '0', step: '1',
        'aria-label': PHASE_LABEL[phase][0] + ' ' + kind, oninput: renderReview,
      }));
      const pcts = inputs.map(() => el('span', { class: 'pct' }));
      const bar = el('span', { class: 'bar', 'aria-hidden': 'true' }, KIND_CLASS.map((k) => el('span', { class: k })));
      const total = el('span', { class: 'pct' });
      cf.rates[phase] = { inputs, pcts, bar, total };
      return el('tr', null,
        el('th', { scope: 'row' }, el('strong', null, PHASE_LABEL[phase][0]),
          el('div', { class: 'sub' }, PHASE_LABEL[phase][1])),
        inputs.map((input, i) => el('td', null, input, pcts[i])),
        el('td', null, bar, total));
    }));
  }

  function fillForm() {
    const s = cf.base;
    if (!s) return renderReview();
    $('cf-cooldown').value = String(s.items.cooldown / 1000);
    $('cf-hold').value = String(s.items.hold);
    $('cf-start').value = String(s.items.startItems);
    for (const p of PHASE_NAMES) {
      cf.rates[p].inputs.forEach((input, i) => { input.value = String(s.items.rates[p][i]); });
    }
    $('cf-at').value = String(s.growth.atPercent);
    $('cf-step').value = String(s.growth.step);
    renderReview();
  }

  /** The items form as a config, what is wrong with it, and which fields are bad. */
  function readItems() {
    const errors = [];
    const raw = $('cf-cooldown').value;
    const seconds = Number(raw);
    const cooldown = Math.round(seconds * 1000);
    const cdOk = raw !== '' && Number.isFinite(seconds) && Math.abs(seconds * 1000 - cooldown) < 1e-6 &&
      cooldown >= 1 && cooldown <= MAX_COOLDOWN_MS;
    if (!cdOk) errors.push('Cooldown: more than 0 s and at most 49 days, in whole milliseconds.');
    const hold = wholeIn($('cf-hold').value, 1, 255);
    if (hold === null) errors.push('Hold size: a whole number from 1 to 255.');
    const startItems = wholeIn($('cf-start').value, 0);
    if (startItems === null) errors.push('Items at start: a whole number, 0 or more.');
    const rates = {};
    const badRates = {};
    for (const p of PHASE_NAMES) {
      const values = cf.rates[p].inputs.map((input) => wholeIn(input.value, 0));
      const total = values.reduce((sum, v) => sum + (v || 0), 0);
      badRates[p] = values.map((v) => v === null);
      if (values.some((v) => v === null) || total < 1 || total > MAX_RATE_TOTAL) {
        errors.push(PHASE_LABEL[p][0] + ' rates: whole numbers, 0 or more, with a total above 0.');
      }
      rates[p] = values.map((v) => v || 0);
    }
    const config = {
      version: cf.base ? cf.base.items.version : 1,
      hold: hold === null ? 0 : hold,
      cooldown: cdOk ? cooldown : 0,
      startItems: startItems === null ? 0 : startItems,
      rates,
    };
    return { config, errors, bad: { cooldown: !cdOk, hold: hold === null, start: startItems === null, rates: badRates } };
  }

  function readGrowth() {
    const errors = [];
    const atPercent = wholeIn($('cf-at').value, 1, 100);
    const step = wholeIn($('cf-step').value, 1);
    if (atPercent === null) errors.push('Grow at: a whole number from 1 to 100.');
    if (step === null) errors.push('Cells per side: a whole number above 0.');
    return { config: { atPercent: atPercent === null ? 0 : atPercent, step: step === null ? 0 : step },
      errors, bad: { at: atPercent === null, step: step === null } };
  }

  function showItemFields(items) {
    const base = cf.base.items;
    markField($('cf-cooldown'), items.config.cooldown !== base.cooldown, items.bad.cooldown);
    markField($('cf-hold'), items.config.hold !== base.hold, items.bad.hold);
    markField($('cf-start'), items.config.startItems !== base.startItems, items.bad.start);
    const seconds = Number($('cf-cooldown').value);
    $('cf-chips').replaceChildren(...COOLDOWN_CHIPS.map((s) => choice('chip', s + ' s', seconds === s, () => {
      $('cf-cooldown').value = String(s);
      renderReview();
    }, { disabled: !isOwner() })));
    for (const p of PHASE_NAMES) {
      const row = cf.rates[p];
      const values = items.config.rates[p];
      const total = values.reduce((a, b) => a + b, 0);
      row.inputs.forEach((input, i) => {
        markField(input, values[i] !== base.rates[p][i], items.bad.rates[p][i]);
        row.pcts[i].textContent = total > 0 ? Math.round((values[i] / total) * 1000) / 10 + '%' : '–';
        css(row.bar.children[i], { width: (total > 0 ? (values[i] / total) * 100 : 0) + '%' });
      });
      row.total.textContent = 'total ' + total;
    }
  }

  function showGrowthFields(growth) {
    const base = cf.base.growth;
    markField($('cf-at'), growth.config.atPercent !== base.atPercent, growth.bad.at);
    markField($('cf-step'), growth.config.step !== base.step, growth.bad.step);
    const sizes = [512];
    if (!growth.bad.step) {
      while (sizes[sizes.length - 1] < 1024 && sizes.length < 8) {
        sizes.push(Math.min(1024, sizes[sizes.length - 1] + 2 * growth.config.step));
      }
    }
    $('cf-grow-steps').replaceChildren(...sizes.map((size) => {
      const side = Math.max(8, Math.round((size / 1024) * 96)) + 'px';
      return el('span', { class: 'grow-step' }, css(el('span', { class: 'grow-box' }), { width: side, height: side }),
        size + '²');
    }));
    $('cf-grow-note').textContent = growth.errors.length > 0 ? ''
      : 'Starting from a 512² open area: it grows by ' + growth.config.step + ' cells a side each time it is ' +
        growth.config.atPercent + '% filled.';
  }

  /** Redraws the fields' marks, the shares, and the review: what would change and why not. */
  function renderReview() {
    const owner = isOwner();
    const ready = cf.base !== null;
    for (const node of document.querySelectorAll('#cf-items input, #cf-growth input, #cf-items .step-btn')) {
      node.disabled = !owner || !ready;
    }
    for (const id of ['cf-items-reset', 'cf-growth-reset', 'cf-when-now', 'cf-when-at', 'cf-at-time']) {
      $(id).disabled = !owner || !ready;
    }
    $('cf-owner-note').hidden = owner;
    if (!ready) {
      $('cf-target-line').textContent = 'The canvas could not be read: nothing can be scheduled now.';
      $('cf-changes').replaceChildren();
      $('cf-errors').replaceChildren();
      $('cf-submit').disabled = true;
      return;
    }
    const items = readItems();
    const growth = readGrowth();
    showItemFields(items);
    showGrowthFields(growth);
    const scope = cf.tab;
    const draft = scope === 'items' ? items : growth;
    const changes = changesBetween(scope, cf.base[scope], draft.config);
    const other = scope === 'items' ? changesBetween('growth', cf.base.growth, growth.config)
      : changesBetween('items', cf.base.items, items.config);
    const version = scope + '@' + (cf.base.latest[scope] + 1);
    $('cf-next-version').replaceChildren(pill(version, 'blue'));
    $('cf-target-line').textContent = 'On ' + (cf.target ? 'the next season (' + cf.target + ')'
      : 'the current canvas (' + (cf.canvas === 'canvas' ? 'Stage 0' : cf.canvas) + ')') +
      ', effective ' + (cf.when === 'now' ? 'now' : 'at the time below') + '.';
    $('cf-none').hidden = changes.length > 0;
    $('cf-changes').replaceChildren(...changes.map((c) => el('li', null,
      el('span', { class: 'what' }, c.label),
      el('span', { class: 'fromto' }, el('s', null, c.from), el('span', { 'aria-hidden': 'true' }, '→'),
        el('strong', null, c.to)))));
    $('cf-errors').replaceChildren(...draft.errors.map((e) => el('li', { role: 'alert' }, e)));
    $('cf-other').hidden = other.length === 0;
    $('cf-other').textContent = (scope === 'items' ? 'Open area growth' : 'Items') + ' also has ' + other.length +
      ' unsaved change(s). Each group is scheduled as its own version.';
    $('cf-submit').textContent = 'Schedule ' + version;
    $('cf-submit').disabled = !owner || changes.length === 0 || draft.errors.length > 0;
  }

  function showTab(tab) {
    cf.tab = tab;
    $('cf-tab-items').setAttribute('aria-selected', tab === 'items' ? 'true' : 'false');
    $('cf-tab-growth').setAttribute('aria-selected', tab === 'growth' ? 'true' : 'false');
    $('cf-items').hidden = tab !== 'items';
    $('cf-growth').hidden = tab !== 'growth';
    renderReview();
  }

  function setWhen(when) {
    cf.when = when;
    $('cf-when-now').setAttribute('aria-pressed', when === 'now' ? 'true' : 'false');
    $('cf-when-at').setAttribute('aria-pressed', when === 'at' ? 'true' : 'false');
    $('cf-at-box').hidden = when !== 'at';
    renderReview();
  }

  function stepper(id, by, min) {
    const input = $(id);
    const n = Number(input.value);
    input.value = String(Math.max(min, (Number.isFinite(n) ? Math.round(n) : min) + by));
    renderReview();
  }

  async function submitConfig() {
    const scope = cf.tab;
    const draft = scope === 'items' ? readItems() : readGrowth();
    const changes = changesBetween(scope, cf.base[scope], draft.config);
    if (draft.errors.length > 0 || changes.length === 0) return;
    let effectiveAt = null;
    if (cf.when === 'at') {
      effectiveAt = localMs($('cf-at-time').value);
      if (!Number.isFinite(effectiveAt)) return say('Pick the date and time it takes effect.', true);
    }
    const canvas = cf.target;
    const got = await ask({
      title: 'Schedule a new ' + scope + ' version?',
      text: changes.map((c) => c.label + ': ' + c.from + ' → ' + c.to).join('\\n') + '\\n\\nOn ' +
        (canvas ? 'the next season (' + canvas + ')' : 'the current canvas') + ', effective ' +
        (effectiveAt === null ? 'now' : when(effectiveAt)) + '.',
      confirm: 'Schedule version',
    });
    if (!got) return;
    try {
      await call('/api/config', { scope, config: draft.config, effectiveAt, canvas, reason: got.reason });
      say('New ' + scope + ' version: done.');
      cf.filledKey = null;
      setWhen('now');
    } catch (error) {
      say('New version failed: ' + error.message, true);
    }
    await reload();
  }

  // ---- Versions ----

  function versionState(v, now, current) {
    if (v.cancelledAt !== null) return ['cancelled', ''];
    if (v.deliveredAt === null) return ['not delivered', 'red'];
    if (current && current[v.scope] === v.version) return ['in force', 'green'];
    return v.effectiveAt > now ? ['scheduled', 'blue'] : ['superseded', ''];
  }

  async function cancelVersion(v) {
    const got = await ask({ title: 'Cancel ' + v.scope + ' version ' + v.version + '?',
      text: 'It never takes effect. Its number stays taken.', confirm: 'Cancel version' });
    if (got) act('Cancel', () => call('/api/config/' + v.id + '/cancel', { reason: got.reason, canvas: cf.target }));
  }

  async function redeliver(v) {
    const got = await ask({ title: 'Send ' + v.scope + ' version ' + v.version + ' to the canvas again?',
      confirm: 'Retry delivery' });
    if (got) act('Delivery', () => call('/api/config/' + v.id + '/deliver', { reason: got.reason, canvas: cf.target }));
  }

  /** Each version in words: what it changed from the version of its scope before it. */
  function versionChanges(versions) {
    const byScope = { items: [], growth: [] };
    for (const v of versions) if (byScope[v.scope]) byScope[v.scope].push(v);
    const out = new Map();
    for (const scope of Object.keys(byScope)) {
      const list = byScope[scope].slice().sort((a, b) => a.version - b.version);
      list.forEach((v, i) => {
        const prev = list.slice(0, i).reverse().find((p) => p.cancelledAt === null);
        const changes = prev ? changesBetween(scope, prev.config, v.config) : [];
        out.set(v.id, prev
          ? (changes.length === 0 ? 'no change' : changes.map((c) => c.label + ' ' + c.from + ' → ' + c.to).join('; '))
          : linesOf(scope, v.config).map((l) => l[0] + ' ' + l[1]).join('; '));
      });
    }
    return out;
  }

  function renderVersions() {
    const now = Date.now();
    const words = versionChanges(cf.versions);
    fill($('cf-versions'), cf.versions.map((v) => {
      const [state, tone] = versionState(v, now, cf.base && cf.base.current);
      const open = v.cancelledAt === null && (v.effectiveAt > now || v.deliveredAt === null);
      return tr(
        el('td', null, el('strong', null, v.scope + '@' + v.version)),
        el('td', null, pill(state, tone), v.cancelledAt !== null ? el('div', { class: 'sub' }, 'by ' + v.cancelledBy) : ''),
        el('td', { class: 'dim' }, at(v.effectiveAt)),
        words.get(v.id) || '',
        el('td', null, v.note, el('div', { class: 'sub' }, v.createdBy)),
        acts(
          isOwner() && v.cancelledAt === null && v.deliveredAt === null && btn('Retry delivery', 'secondary', () => redeliver(v)),
          isOwner() && open && btn('Cancel', 'ghost', () => cancelVersion(v)),
        ),
      );
    }), 'No version yet.');
  }

  function renderTargets() {
    const switchTo = (canvas) => {
      cf.target = canvas;
      cf.filledKey = null;
      reload();
    };
    $('cf-targets').replaceChildren(
      choice('seg-btn', [el('strong', null, 'Current canvas'),
        el('span', null, cf.canvas === 'canvas' ? 'Stage 0' : cf.canvas || 'unknown')],
        cf.target === null, () => switchTo(null)),
      cf.next
        ? choice('seg-btn', [el('strong', null, 'Next season'),
            el('span', null, cf.next.canvas + ' · starts ' + when(cf.next.startsAt))],
          cf.target === cf.next.canvas, () => switchTo(cf.next.canvas))
        : el('span', { class: 'note' }, 'No next season yet: create one under Season to set its settings before it starts.'),
    );
  }

  buildRates();
  for (const id of ['cf-cooldown', 'cf-hold', 'cf-start', 'cf-at', 'cf-step']) {
    $(id).addEventListener('input', renderReview);
  }
  $('cf-hold-down').addEventListener('click', () => stepper('cf-hold', -1, 1));
  $('cf-hold-up').addEventListener('click', () => stepper('cf-hold', 1, 1));
  $('cf-start-down').addEventListener('click', () => stepper('cf-start', -1, 0));
  $('cf-start-up').addEventListener('click', () => stepper('cf-start', 1, 0));
  $('cf-tab-items').addEventListener('click', () => showTab('items'));
  $('cf-tab-growth').addEventListener('click', () => showTab('growth'));
  $('cf-when-now').addEventListener('click', () => setWhen('now'));
  $('cf-when-at').addEventListener('click', () => setWhen('at'));
  $('cf-items-reset').addEventListener('click', fillForm);
  $('cf-growth-reset').addEventListener('click', fillForm);
  $('cf-submit').addEventListener('click', submitConfig);
  $('cf-double').addEventListener('click', doubleCooldown);

  view('config', 'Game config', async () => {
    const [data, seasons] = await Promise.all([
      call('/api/config'),
      call('/api/seasons').then((d) => d.seasons).catch(() => []),
    ]);
    keepConfig(data.state);
    cf.canvas = data.canvas;
    cf.next = seasons.filter((s) => s.state === 'scheduled').sort((a, b) => a.startsAt - b.startsAt)[0] || null;
    if (cf.target !== null && (!cf.next || cf.next.canvas !== cf.target)) cf.target = null;
    const chosen = cf.target === null ? data : await call('/api/config?canvas=' + encodeURIComponent(cf.target));
    cf.base = chosen.state;
    cf.versions = chosen.versions;
    $('cf-now-meta').textContent = cf.base ? 'in force: items@' + cf.base.current.items + ' · growth@' + cf.base.current.growth
      : 'canvas unreachable';
    renderTargets();
    renderVersions();
    const key = (cf.target || '') + JSON.stringify(cf.base ? [cf.base.current, cf.base.latest] : null);
    if (key !== cf.filledKey) {
      cf.filledKey = key;
      fillForm();
    } else {
      renderReview();
    }
  });
`;
