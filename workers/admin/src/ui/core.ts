// The shared part of the admin page script: helpers every view uses, the confirm dialog, the
// toast, and the router that shows one view at a time. page.ts wraps this and the views in
// one closure. Plain browser JavaScript in a string: no backticks and no template holes in it.
// Every element is built with el(), which sets text with textContent and never parses HTML, so
// nothing an admin or a player typed can run as code.

export const CORE_JS = `
  const $ = (id) => document.getElementById(id);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WHAT_NOT_WHO = 'Kept in the audit log for good. Say what happened, never who: ' +
    'no names, emails or numbers.';
  /** GET /api/me: email, role, environment, dev, auditPage. */
  let me = null;
  const views = {};
  let current = 'overview';

  // ---- Elements -----------------------------------------------------------------------------

  /** An element: attributes (on* adds a listener; null, undefined and false are skipped). */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'class') node.className = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(2)) {
      if (child === null || child === undefined || child === false || child === '') continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  function btn(label, kind, onClick, attrs) {
    return el('button', Object.assign({ type: 'button', class: kind, onclick: onClick }, attrs), label);
  }

  /** An account id, cut to its first 8 characters; the whole id on hover. */
  function shortId(id) {
    const text = String(id);
    return text.length > 12 ? text.slice(0, 8) + '…' : text;
  }

  /** An account id that opens the account under Players. */
  function idLink(id) {
    return btn(shortId(id), 'link', () => showPlayer(id), { title: id });
  }

  function pill(text, tone) {
    return el('span', { class: tone ? 'pill ' + tone : 'pill' }, text);
  }

  /** Sets sizes through the CSSOM: the CSP refuses style attributes, not this. */
  function css(node, props) {
    for (const [key, value] of Object.entries(props)) node.style[key] = value;
    return node;
  }

  /** One button of a group where aria-pressed marks the chosen one. */
  function choice(cls, label, on, onClick, attrs) {
    return el('button', Object.assign({ type: 'button', class: cls, 'aria-pressed': on ? 'true' : 'false',
      onclick: onClick }, attrs), label);
  }

  /** A field's look: changed from what is in force, or invalid. */
  function markField(input, changed, bad) {
    input.classList.toggle('changed', changed && !bad);
    input.classList.toggle('bad', bad);
    input.setAttribute('aria-invalid', bad ? 'true' : 'false');
  }

  /** A whole number from min to max (max optional), or null. */
  function wholeIn(value, min, max) {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= min && (max === undefined || n <= max) ? n : null;
  }

  /** A table row; plain values become cells, td elements are kept as they are. */
  function tr(...cells) {
    return el('tr', null, cells.map((c) => (c instanceof Node && c.tagName === 'TD' ? c : el('td', null, c))));
  }

  function acts(...buttons) {
    return el('td', { class: 'acts' }, el('span', { class: 'acts-in' }, buttons));
  }

  /** Puts rows in a tbody, or one muted line saying it is empty. */
  function fill(body, rows, emptyText) {
    const cols = body.closest('table').querySelectorAll('thead th').length || 1;
    if (rows.length === 0) rows = [el('tr', null, el('td', { class: 'empty', colspan: cols }, emptyText))];
    body.replaceChildren(...rows);
  }

  function facts(list, pairs) {
    list.replaceChildren(...pairs.filter(Boolean).map(([term, value]) =>
      el('div', null, el('dt', null, term), el('dd', null, value))));
  }

  function tile(label, value, sub, alert) {
    return el('div', { class: alert ? 'tile alert' : 'tile' },
      el('div', { class: 'tile-label' }, label),
      el('div', { class: 'tile-value' }, value),
      sub && el('div', { class: 'tile-sub' }, sub));
  }

  // ---- Time ---------------------------------------------------------------------------------

  function when(ms) {
    if (ms === null || ms === undefined) return 'never';
    return new Date(ms).toLocaleString();
  }

  /** A time as text, with the exact UTC time on hover. */
  function at(ms) {
    if (ms === null || ms === undefined) return 'never';
    return el('span', { title: new Date(ms).toISOString() }, when(ms));
  }

  function ago(ms) {
    if (ms === null || ms === undefined) return '';
    const diff = Date.now() - ms;
    const future = diff < 0;
    const s = Math.abs(diff) / 1000;
    if (s < 60 && !future) return 'just now';
    const text = s < 60 ? 'under a minute'
      : s < 3600 ? Math.floor(s / 60) + ' min'
      : s < 2 * 86400 ? Math.floor(s / 3600) + ' h'
      : Math.floor(s / 86400) + ' days';
    return future ? 'in ' + text : text + ' ago';
  }

  /** A datetime-local value (the admin's own time zone) as ms; null when empty, NaN if bad. */
  function localMs(value) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }

  /** ms as a datetime-local value in the admin's own time zone. */
  function toLocal(ms) {
    const date = new Date(ms);
    return new Date(ms - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function intOrNull(value) {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isInteger(n) ? n : NaN;
  }

  // ---- Talking to the API -------------------------------------------------------------------

  async function call(path, body) {
    const init = body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BrickPlace-Admin': '1' },
      body: JSON.stringify(body),
    };
    const response = await fetch(path, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data.detail ? ' (' + data.detail + ')' : '';
      throw new Error((data.error || 'HTTP ' + response.status) + detail);
    }
    return data;
  }

  /** Runs a change, says how it went, then reloads the view. The result, or null on failure. */
  async function act(label, run) {
    try {
      const result = await run();
      say(label + ': done.');
      await reload();
      return result;
    } catch (error) {
      say(label + ' failed: ' + error.message, true);
      await reload();
      return null;
    }
  }

  const isOwner = () => me !== null && me.role === 'owner';

  // ---- Toast --------------------------------------------------------------------------------

  let toastTimer = 0;

  /** A message in the corner: errors stay until closed, the rest go after a few seconds. */
  function say(text, error) {
    const box = $('toast');
    box.className = error ? 'toast error' : 'toast';
    box.setAttribute('role', error ? 'alert' : 'status');
    $('toast-text').textContent = text;
    box.hidden = false;
    clearTimeout(toastTimer);
    if (!error) toastTimer = setTimeout(() => { box.hidden = true; }, 6000);
  }

  $('toast-close').addEventListener('click', () => { $('toast').hidden = true; });

  // ---- The confirm dialog -------------------------------------------------------------------

  let answer = null;

  function askField(f) {
    if (f.type === 'checkbox') {
      return el('label', { class: 'check' },
        el('input', { type: 'checkbox', name: f.name, checked: f.value === true }), f.label);
    }
    const input = f.type === 'select'
      ? el('select', { name: f.name }, f.options.map(([value, label]) =>
          el('option', { value, selected: value === f.value }, label)))
      : el('input', {
          type: f.type || 'text', name: f.name, value: f.value, required: f.required === true,
          min: f.min, step: f.step, placeholder: f.placeholder, maxlength: f.maxlength,
        });
    return el('label', { class: 'field' }, f.label, input, f.hint && el('span', { class: 'hint' }, f.hint));
  }

  /**
   * Asks before a change: a title, what will happen, any extra fields and (unless reason is
   * false) the reason for the audit log. Resolves to the values by field name, reason
   * included, or null when the admin backs out.
   */
  function ask(o) {
    if (answer) answer(null);
    const dialog = $('ask');
    const form = $('ask-form');
    $('ask-title').textContent = o.title;
    $('ask-text').textContent = o.text || '';
    $('ask-text').hidden = !o.text;
    $('ask-fields').replaceChildren(...(o.fields || []).map(askField));
    const withReason = o.reason !== false;
    $('ask-reason').hidden = !withReason;
    form.elements.reason.required = withReason;
    form.elements.reason.value = '';
    $('ask-reason-hint').textContent = o.reasonHint || WHAT_NOT_WHO;
    $('ask-ok').textContent = o.confirm || 'Confirm';
    $('ask-ok').className = o.danger ? 'danger solid big' : 'primary big';
    dialog.className = o.danger ? 'danger-ask' : '';
    dialog.showModal();
    const first = $('ask-fields').querySelector('input, select') ||
      (withReason ? form.elements.reason : $('ask-ok'));
    first.focus();
    return new Promise((resolve) => {
      answer = (values) => {
        answer = null;
        resolve(values);
      };
    });
  }

  $('ask-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = {};
    for (const node of event.currentTarget.elements) {
      if (!node.name) continue;
      values[node.name] = node.type === 'checkbox' ? node.checked : node.value.trim();
    }
    const done = answer;
    answer = null;
    $('ask').close();
    if (done) done(values);
  });
  $('ask-cancel').addEventListener('click', () => $('ask').close());
  $('ask').addEventListener('close', () => { if (answer) answer(null); });

  // ---- Views --------------------------------------------------------------------------------

  /** A view: its title and how it loads; its markup is the section with data-view="name". */
  function view(name, title, load) {
    views[name] = { title, load };
  }

  async function reload() {
    try {
      await Promise.all([views[current].load(), current === 'overview' || current === 'reports'
        ? null : queue(), seasonPill()]);
    } catch (error) {
      say('Could not load ' + views[current].title + ': ' + error.message, true);
    }
  }

  function show(name) {
    // Admins and the audit log share one view now; old #admins links land there.
    if (name === 'admins') name = 'audit';
    if (!views[name]) name = 'overview';
    current = name;
    for (const section of document.querySelectorAll('[data-view]')) {
      section.hidden = section.dataset.view !== name;
    }
    for (const link of document.querySelectorAll('.nav a')) {
      if (link.getAttribute('href') === '#' + name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    $('title').textContent = views[name].title;
    document.title = views[name].title + ' · BrickPlace admin';
    window.scrollTo(0, 0);
    return reload();
  }

  /** Opens a view (or reloads it when open); resolves once it is shown and loaded. */
  function go(name) {
    // Set first, so the hashchange that follows finds the view current and does nothing.
    current = name;
    if (location.hash !== '#' + name) location.hash = name;
    return show(name);
  }

  window.addEventListener('hashchange', () => {
    const name = location.hash.slice(1);
    if (name !== current) show(name);
  });
  $('refresh').addEventListener('click', () => reload().then(() => say('Up to date.')));

  // ---- What every view shows: the open reports badge and the season pill ---------------------

  /** The open report queue; keeps the sidebar's count in step. */
  async function queue() {
    const data = await call('/api/moderation/reports');
    const count = $('nav-count');
    count.textContent = String(data.entries.length);
    count.hidden = data.entries.length === 0;
    return data.entries;
  }

  /** The canvas players are on, read-only or not, beside the view's title. */
  async function seasonPill() {
    const box = $('season-pill');
    const data = await call('/api/emergency/read-only').catch(() => null);
    if (!data) {
      box.replaceChildren(pill('Canvas unreachable', 'red'));
      return;
    }
    const s = data.status;
    const name = s.canvas === 'canvas' ? 'Stage 0' : 'Season ' + s.canvas;
    box.replaceChildren(s.readOnly ? pill(name + ' · read-only', 'red') : pill(name + ' · live', 'green'));
  }
`;
