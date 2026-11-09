// Admins and the audit log, one view. Owners see and change roles: owners change config,
// seasons, sponsors and roles; moderators may pull the emergency switches, and only owners
// reopen a read-only map. Nobody changes their own role. The audit log is append-only: nothing
// in it can be edited or deleted. Each entry opens to show what it changed, field by field.

export const ADMINS_HTML = `
<section class="view" data-view="audit" hidden>
  <section class="card" aria-labelledby="ad-title" data-owner>
    <div class="card-head"><h2 id="ad-title">Admins</h2><span class="meta" id="ad-meta"></span></div>
    <div class="card-body"><p class="note">Owners only. Sign-in itself goes through Cloudflare
      Access; this sets the role. Owners change config, seasons, sponsors and roles; moderators act
      on reports, players and the map, and may pull the emergency switches. Nobody changes their
      own role.</p></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Granted by</th>
          <th scope="col">Since</th><th scope="col" class="acts">Action</th></tr></thead>
        <tbody id="ad-list"></tbody>
      </table>
    </div>
    <div class="card-foot">
      <form id="ad-form" class="inline">
        <label class="field">Email<input name="email" type="email" required autocomplete="off"></label>
        <label class="field short">Role<select name="role"><option value="moderator">moderator</option>
          <option value="owner">owner</option></select></label>
        <button type="submit" class="primary big">Add admin</button>
      </form>
    </div>
  </section>
  <section class="card" aria-labelledby="au-title">
    <div class="card-head"><h2 id="au-title">Audit log</h2>
      <span class="meta">Every change, who made it and why. Never edited.</span></div>
    <div class="card-body"><div class="chips" role="group" aria-label="Show" id="au-filters"></div></div>
    <ul class="picks" id="au-list"></ul>
    <div class="card-foot"><button type="button" id="au-more" class="secondary big">Older entries</button></div>
  </section>
</section>
`;

export const ADMINS_JS = `
  // ---- Admins -------------------------------------------------------------------------------

  async function setRole(email, role) {
    const got = await ask(role
      ? { title: 'Make ' + email + ' ' + (role === 'owner' ? 'an owner' : 'a moderator') + '?',
          text: role === 'owner' ? 'Owners change config, seasons, sponsors and roles.' : '', confirm: 'Grant role' }
      : { title: 'Revoke the role of ' + email + '?', text: 'They lose access to this page at once.',
          confirm: 'Revoke', danger: true });
    if (!got) return null;
    return act('Role', () => call('/api/roles', { email, role, reason: got.reason }));
  }

  $('ad-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const done = await setRole(form.elements.email.value.trim(), form.elements.role.value);
    if (done) form.reset();
  });

  async function loadAdmins() {
    if (!isOwner()) return;
    const data = await call('/api/roles');
    $('ad-meta').textContent = data.roles.length + ' with a role';
    fill($('ad-list'), data.roles.map((r) => {
      const self = r.email === me.email;
      const other = r.role === 'owner' ? 'moderator' : 'owner';
      return tr(
        el('td', null, el('strong', null, r.email), self ? el('div', { class: 'sub' }, 'you') : ''),
        pill(r.role, r.role === 'owner' ? 'yellow' : 'blue'),
        r.grantedBy,
        el('td', { class: 'dim' }, at(r.grantedAt)),
        acts(
          !self && btn('Make ' + other, 'secondary', () => setRole(r.email, other)),
          !self && btn('Revoke', 'danger', () => setRole(r.email, null)),
        ),
      );
    }), 'Nobody has a role.');
  }

  // ---- Audit log ----------------------------------------------------------------------------

  let auditBefore = null;
  let auditEntries = [];
  let auditFilter = 'all';
  const auditOpen = new Set();
  const OUTCOME_TONE = { ok: 'green', requested: 'blue', error: 'red', forbidden: 'red' };
  /** Which actions each filter shows, by the start of their name. */
  const AUDIT_GROUPS = [
    ['all', 'All', []],
    ['config', 'Config', ['config.', 'emergency.']],
    ['sponsors', 'Sponsors', ['sponsor.', 'links.']],
    ['map', 'Map', ['map.', 'archive.']],
    ['players', 'Players', ['player.', 'team.', 'reports.']],
    ['season', 'Season', ['season.']],
    ['access', 'Access', ['role.', 'access.']],
  ];
  const GROUP_TONE = { config: 'blue', sponsors: 'yellow', map: 'green', players: 'red', season: '', access: '' };

  function groupOf(action) {
    const found = AUDIT_GROUPS.find((g) => g[2].some((prefix) => action.startsWith(prefix)));
    return found ? found : ['other', 'Other', []];
  }

  /** A logged value as text: times as dates, objects as compact JSON. */
  function shown(value) {
    if (value === null || value === undefined) return '–';
    if (typeof value === 'number' && value > 1e12 && value < 1e13) return when(value);
    if (typeof value === 'string') return value;
    const text = JSON.stringify(value);
    return text.length > 240 ? text.slice(0, 240) + '…' : text;
  }

  /** Before and after, field by field; only the fields that differ (all of them when new). */
  function diffRows(before, after) {
    const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!isObject(before) && !isObject(after)) {
      return before === null && after === null ? [] : [['value', shown(before), shown(after)]];
    }
    const a = isObject(before) ? before : {};
    const b = isObject(after) ? after : {};
    const keys = Array.from(new Set(Object.keys(a).concat(Object.keys(b))));
    return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .map((k) => [k, shown(a[k]), shown(b[k])]);
  }

  function auditItem(e) {
    const [key, label] = groupOf(e.action);
    const open = auditOpen.has(e.id);
    const rows = diffRows(e.before, e.after);
    const item = el('li', null, el('button', {
      type: 'button', class: 'audit-row', 'aria-expanded': open ? 'true' : 'false',
      onclick: () => {
        if (auditOpen.has(e.id)) auditOpen.delete(e.id);
        else auditOpen.add(e.id);
        renderAudit();
      },
    },
      el('span', { class: 'when', title: new Date(e.at).toISOString() }, ago(e.at), el('div', { class: 'sub' }, '#' + e.id)),
      el('span', { class: 'group' }, pill(label, GROUP_TONE[key] || '')),
      el('span', { class: 'lines' }, el('strong', null, e.action + (e.target ? ' · ' + e.target : '')),
        el('span', null, e.actor + (e.reason ? ' · "' + e.reason + '"' : ''))),
      pill(e.outcome, OUTCOME_TONE[e.outcome] || ''),
      rows.length > 0 ? el('span', { 'aria-hidden': 'true' }, open ? '▴' : '▾') : ''));
    if (open && rows.length > 0) {
      item.append(el('div', { class: 'audit-diff' }, el('table', null,
        el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Field'), el('th', { scope: 'col' }, 'Before'),
          el('th', { scope: 'col' }, 'After'))),
        el('tbody', null, rows.map(([field, before, after]) => el('tr', null, el('td', null, field),
          el('td', { class: 'before' }, before), el('td', { class: 'after' }, after)))))));
    }
    return item;
  }

  function renderAudit() {
    $('au-filters').replaceChildren(...AUDIT_GROUPS.map(([key, label]) => choice('chip big', label, auditFilter === key, () => {
      auditFilter = key;
      renderAudit();
    })));
    const shownEntries = auditEntries.filter((e) => auditFilter === 'all' || groupOf(e.action)[0] === auditFilter);
    $('au-list').replaceChildren(...(shownEntries.length > 0 ? shownEntries.map(auditItem)
      : [el('li', { class: 'notice info' }, 'Nothing logged here yet.')]));
  }

  async function loadAudit(more) {
    const data = await call('/api/audit' + (more && auditBefore !== null ? '?before=' + auditBefore : ''));
    auditEntries = more ? auditEntries.concat(data.entries) : data.entries;
    if (data.entries.length > 0) auditBefore = data.entries[data.entries.length - 1].id;
    $('au-more').parentElement.hidden = data.entries.length < me.auditPage;
    renderAudit();
  }

  $('au-more').addEventListener('click', () => loadAudit(true).catch((error) => say(error.message, true)));

  view('audit', 'Admins & audit', () => Promise.all([loadAdmins(), loadAudit(false)]));
`;
