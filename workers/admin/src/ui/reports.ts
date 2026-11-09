// Reports: the open report queue, grouped by what each is about (ADR 0023), as a list beside
// the chosen entry's details and actions, and the accounts the live map flagged as moving like
// a script (ADR 0026). Player and team actions live in players.ts.

export const REPORTS_HTML = `
<section class="view" data-view="reports" hidden>
  <p class="lead">Reports on one player or team are grouped, oldest first. Acting from here closes
    every open report on them as actioned; dismissing closes them with no action. Nobody acts on
    an account with their own email address.</p>
  <div class="row">
    <section class="card narrow-col" aria-labelledby="rep-title">
      <div class="card-head"><h2 id="rep-title">Open</h2><span class="meta" id="rep-meta"></span></div>
      <ul class="picks" id="rep-list"></ul>
    </section>
    <section class="card wide-col" aria-labelledby="rep-det-title">
      <div class="card-head"><h2 id="rep-det-title">Report</h2><span id="rep-det-pills"></span></div>
      <div class="card-body" id="rep-detail"></div>
    </section>
  </div>
  <section class="card" aria-labelledby="sig-title">
    <div class="card-head">
      <h2 id="sig-title">Bot signals</h2>
      <span class="meta" id="sig-meta"></span>
    </div>
    <div class="card-body"><p class="note">Moves outside what the player's page shows, or at the
      exact moment an item arrives, and accounts held until they pass a Turnstile. Hints, never
      proof: nothing here bans anyone. Counts reset when the realtime service restarts.</p></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th scope="col">Account</th><th scope="col">Score</th>
          <th scope="col">Outside view</th><th scope="col">No view</th>
          <th scope="col">On cooldown</th><th scope="col">Turnstile</th>
          <th scope="col">Passed</th><th scope="col" class="acts">Action</th></tr></thead>
        <tbody id="sig-list"></tbody>
      </table>
    </div>
  </section>
</section>
`;

export const REPORTS_JS = `
  // ---- Reports ------------------------------------------------------------------------------

  const REASON_TONE = { hateful: 'red', personal_info: 'blue', offensive: 'yellow' };
  /** The entry shown on the right: kind and id, kept across reloads. */
  let reportPick = null;

  function reasonPills(reasons) {
    return el('span', { class: 'pills' }, reasons.map((r) => pill(r.replace(/_/g, ' '), REASON_TONE[r])));
  }

  /** A player or team: a coloured initial, the name (opens its details) and lines under it. */
  function whoCell(kind, name, lines, open) {
    const initial = (Array.from((name || '').trim())[0] || '?').toUpperCase();
    const title = el('strong', null, name || '(no name)');
    return el('td', null, el('span', { class: 'who-cell' },
      el('span', { class: 'badge ' + kind, 'aria-hidden': 'true' }, initial),
      el('span', { class: 'lines' }, open ? btn(title, 'link', open) : title,
        lines.filter(Boolean).map((line) => (line instanceof Node ? line : el('span', null, line)))
          .map((line) => { line.classList.add('sub'); return line; }))));
  }

  const keyOf = (e) => e.kind + ':' + e.id;

  function reportActions(e) {
    const player = e.kind === 'player';
    return player
      ? [
          btn('Roll back their moves', 'primary big', () => rollBack(e.id)),
          !e.reset && e.current !== null && btn('Reset name', 'secondary big', () => resetNickname(e.id, true, e.current)),
          !e.banned && btn('Ban', 'danger big', () => ban(e.id, true, e.current)),
          btn('Open account', 'secondary big', () => showPlayer(e.id)),
          btn('Dismiss', 'ghost big', () => dismiss(e)),
        ]
      : [
          !e.reset && !e.closed && btn('Reset name', 'secondary big', () => resetTeam(e.id, true)),
          !e.closed && btn('Close team', 'danger big', () => closeTeam(e.id, true)),
          btn('Open team', 'secondary big', () => showTeam(String(e.id))),
          btn('Dismiss', 'ghost big', () => dismiss(e)),
        ];
  }

  function showReport(e) {
    if (!e) {
      $('rep-det-title').textContent = 'Report';
      $('rep-det-pills').replaceChildren();
      $('rep-detail').replaceChildren(el('p', { class: 'note' }, 'The queue is empty.'));
      return;
    }
    const player = e.kind === 'player';
    const reported = e.reported.filter((n) => n !== e.current);
    $('rep-det-title').textContent = e.current || '(no name)';
    $('rep-det-pills').replaceChildren(reasonPills(e.reasons));
    const flags = [
      e.reset && 'name reset',
      e.banned && 'banned',
      e.closed && 'closed',
    ].filter(Boolean);
    const stats = el('div', { class: 'stat-grid' },
      [['Reports', String(e.reports)], ['First', ago(e.firstAt)], ['Last', ago(e.lastAt)],
        player ? ['Bans in all', String(e.priorBans)] : ['Kind', 'team']]
        .map(([label, value]) => el('span', { class: 'stat' }, el('span', null, label), el('strong', null, value))));
    $('rep-detail').replaceChildren(
      el('dl', { class: 'facts' }, el('div', null, el('dt', null, player ? 'Player' : 'Team'),
        el('dd', null, player ? idLink(e.id) : 'team ' + e.id)),
        reported.length > 0 ? el('div', null, el('dt', null, 'Reported as'), el('dd', null, reported.join(', '))) : '',
        flags.length > 0 ? el('div', null, el('dt', null, 'Already'), el('dd', null, flags.join(' · '))) : ''),
      stats,
      el('div', { class: 'buttons-row' }, reportActions(e).filter(Boolean)),
      el('p', { class: 'note' }, 'Every action asks for a reason and lands in the audit log. Reporters are never shown.'),
    );
  }

  function renderQueue(entries) {
    const reports = entries.reduce((n, e) => n + e.reports, 0);
    $('rep-meta').textContent = entries.length + ' · ' + reports + ' report(s)';
    const picked = entries.find((e) => keyOf(e) === reportPick) || entries[0] || null;
    reportPick = picked ? keyOf(picked) : null;
    $('rep-list').replaceChildren(...(entries.length > 0 ? entries.map((e) => el('li', null,
      choice('pick', [
        el('span', { class: 'badge ' + e.kind, 'aria-hidden': 'true' }, (Array.from((e.current || '').trim())[0] || '?').toUpperCase()),
        el('span', { class: 'lines' }, el('strong', null, e.current || '(no name)'),
          el('span', null, e.reports + ' report(s) · first ' + ago(e.firstAt))),
        reasonPills(e.reasons.slice(0, 2)),
      ], keyOf(e) === reportPick, () => {
        reportPick = keyOf(e);
        renderQueue(entries);
      }))) : [el('li', { class: 'notice info' }, 'Nothing open.')]));
    showReport(picked);
  }

  async function dismiss(e) {
    const got = await ask({
      title: 'Dismiss ' + e.reports + ' report(s)?',
      text: 'The reports on ' + e.kind + ' ' + e.id + ' close with no action. A report filed ' +
        'after this list loaded stays open.',
      confirm: 'Dismiss',
    });
    if (!got) return;
    const target = e.kind === 'player' ? { player: e.id } : { team: e.id };
    act('Dismiss', () => call('/api/moderation/reports/dismiss', { ...target, reason: got.reason, upTo: e.lastAt }));
  }

  async function loadSignals() {
    const body = $('sig-list');
    let data;
    try {
      data = await call('/api/moderation/signals');
    } catch (error) {
      $('sig-meta').textContent = 'unavailable right now (' + error.message + ')';
      fill(body, [], 'Bot signals could not be read.');
      return;
    }
    $('sig-meta').textContent = data.players.length + ' flagged' +
      (data.partial ? '; some shards did not answer, the list may be short' : '');
    fill(body, data.players.map((s) => tr(
      idLink(s.player),
      el('td', { class: 'num' }, String(s.score)),
      String(s.offView), String(s.noView), String(s.onCooldown),
      s.challengedAt ? pill('pending ' + ago(s.challengedAt), 'yellow') : '',
      String(s.passed),
      acts(btn('Roll back', 'secondary', () => rollBack(s.player))),
    )), 'No account flagged.');
  }

  view('reports', 'Reports', async () => {
    const [entries] = await Promise.all([queue(), loadSignals()]);
    renderQueue(entries);
  });
`;
