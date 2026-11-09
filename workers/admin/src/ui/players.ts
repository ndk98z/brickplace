// Players and teams: find accounts and teams and act on them (ADR 0023): bans, name resets,
// closing a team. Results on the left, the chosen one's details and actions on the right. The
// report queue calls the same actions with closeReports set, so acting there closes the
// reports it acted on.

export const PLAYERS_HTML = `
<section class="view" data-view="players" hidden>
  <form id="pl-find" class="view-bar">
    <div class="chips" role="group" aria-label="Find" id="pl-kinds"></div>
    <label class="field grow">Search<input name="q" required maxlength="128" autocomplete="off"
      id="pl-q" placeholder="Nickname (its start) or account id"></label>
    <button type="submit" class="primary big">Find</button>
  </form>
  <div class="row">
    <section class="card narrow-col" aria-labelledby="pl-title">
      <div class="card-head"><h2 id="pl-title">Results</h2><span class="meta" id="pl-meta"></span></div>
      <ul class="picks" id="pl-list"></ul>
    </section>
    <section class="card wide-col" aria-labelledby="pl-det-title">
      <div class="card-head"><h2 id="pl-det-title">Details</h2><span id="pl-det-pill"></span></div>
      <div class="card-body" id="pl-detail"></div>
    </section>
  </div>
</section>
`;

export const PLAYERS_JS = `
  // ---- Players and teams --------------------------------------------------------------------

  /** What is being looked for: players or teams, the query, and the one shown on the right. */
  const pl = { kind: 'players', query: null, pick: null };
  const BAN_LENGTHS = [['1', '1 day'], ['7', '7 days'], ['30', '30 days'], ['', 'For good']];

  function warnIfNotKicked(result) {
    if (result && result.kicked === false) {
      say('Done, but the open sockets could not be closed: they stop playing within the hour.', true);
    }
  }

  /** How a dialog names an account: its nickname when it has one, the id always. */
  function named(id, name) {
    return name ? name + ' (account ' + id + ')' : 'account ' + id;
  }

  async function ban(id, closeReports, name, days) {
    const got = await ask({
      title: 'Ban ' + (name || 'this account') + '?',
      text: 'Bans ' + named(id, name) + '. Its open sockets close at once. The player reads the ' +
        'reason, and it outlives the account.',
      fields: [{ name: 'days', label: 'Days', type: 'number', min: '0', step: 'any', value: days || '',
        hint: 'Above 0 (0.5 is 12 hours). Empty for a permanent ban, which only an owner can lift.' }],
      reasonHint: 'Write what happened, never who: no names, emails or numbers.',
      confirm: 'Ban',
      danger: true,
    });
    if (!got) return;
    let expiresAt = null;
    if (got.days !== '') {
      const n = Number(got.days);
      if (!(n > 0)) return say('The number of days must be above 0.', true);
      expiresAt = Date.now() + Math.round(n * DAY_MS);
    }
    act('Ban', () => call('/api/moderation/players/' + encodeURIComponent(id) + '/ban',
      { reason: got.reason, expiresAt, closeReports })).then(warnIfNotKicked);
  }

  async function unban(id, name) {
    const got = await ask({ title: 'Lift the ban on ' + (name || 'this account') + '?',
      text: 'Lifts the ban on ' + named(id, name) + '.', confirm: 'Lift ban' });
    if (got) act('Unban', () => call('/api/moderation/players/' + encodeURIComponent(id) + '/unban', { reason: got.reason }));
  }

  async function resetNickname(id, closeReports, name) {
    const got = await ask({
      title: 'Reset the nickname ' + (name ? '"' + name + '"' : 'of this account') + '?',
      text: 'The nickname of ' + named(id, name) + ' becomes a placeholder; the player chooses a ' +
        'new one before playing again.',
      reasonHint: 'Say which rule it broke (e.g. "sexual word"), never the nickname itself.',
      confirm: 'Reset nickname',
    });
    if (!got) return;
    act('Nickname reset', () => call('/api/moderation/players/' + encodeURIComponent(id) + '/reset-nickname',
      { reason: got.reason, closeReports })).then(warnIfNotKicked);
  }

  async function resetTeam(id, closeReports) {
    const got = await ask({
      title: 'Reset the name of team ' + id + '?',
      text: 'It becomes a placeholder; its owner may choose a new one.',
      reasonHint: 'Say which rule it broke, never the name itself.',
      confirm: 'Reset name',
    });
    if (got) act('Team name reset', () => call('/api/moderation/teams/' + id + '/reset-name', { reason: got.reason, closeReports }));
  }

  async function closeTeam(id, closeReports) {
    const got = await ask({
      title: 'Close team ' + id + '?',
      text: 'Its members leave it; its cells stay on the map. This cannot be undone.',
      fields: [{ name: 'resetName', type: 'checkbox', label: 'Also reset its name (an offensive name)' }],
      confirm: 'Close team',
      danger: true,
    });
    if (got) {
      act('Close team', () => call('/api/moderation/teams/' + id + '/close',
        { reason: got.reason, resetName: got.resetName, closeReports }));
    }
  }

  function banLine(b) {
    return (b.liftedAt !== null ? 'Ban lifted ' + when(b.liftedAt)
      : b.expiresAt === null ? 'Banned for good' : 'Banned until ' + when(b.expiresAt)) + ': ' + b.reason;
  }

  function stats(pairs) {
    return el('div', { class: 'stat-grid' }, pairs.map(([label, value]) =>
      el('span', { class: 'stat' }, el('span', null, label), el('strong', null, value))));
  }

  function playerDetail(p) {
    const active = p.bans.find((b) => b.active);
    const banned = active !== undefined;
    // Only an owner lifts a permanent ban; the server refuses anyone else.
    const liftable = banned && (isOwner() || active.expiresAt !== null);
    $('pl-det-title').textContent = p.nickname || '(no nickname)';
    $('pl-det-pill').replaceChildren(banned ? pill('banned', 'red') : pill('active', 'green'));
    const history = p.bans.map((b) => [b.createdAt, banLine(b)]);
    history.push([p.createdAt, 'Signed up']);
    $('pl-detail').replaceChildren(
      el('dl', { class: 'facts' },
        el('div', null, el('dt', null, 'Account'), el('dd', null, el('span', { title: p.id }, p.id))),
        el('div', null, el('dt', null, 'Team'), el('dd', null, p.team
          ? btn(p.team.name + (p.team.owner ? ' (owner)' : ''), 'link', () => showTeam(String(p.team.id))) : 'none'))),
      stats([['Joined', ago(p.createdAt)], ['Open reports', String(p.openReports)], ['Bans in all', String(p.bans.length)],
        ['Name', p.nicknameReset ? 'reset' : 'own']]),
      el('div', { class: 'box' },
        el('strong', null, banned ? 'Banned' : 'Ban'),
        banned ? el('p', { class: 'note' }, banLine(active))
          : el('div', { class: 'chips' }, BAN_LENGTHS.map(([days, label]) =>
              btn(label, 'chip big', () => ban(p.id, false, p.nickname, days)))),
        el('span', { class: 'note' }, 'Closes their open sockets at once; asks for a reason.'),
        el('div', { class: 'buttons-row' },
          liftable && btn('Unban', 'secondary big', () => unban(p.id, p.nickname)),
          p.nickname !== null && !p.nicknameReset && btn('Reset name', 'secondary big', () => resetNickname(p.id, false, p.nickname)),
          btn('Roll back their moves', 'secondary big', () => rollBack(p.id)))),
      el('div', null, el('h3', null, 'History'), el('ol', { class: 'history' },
        history.sort((a, b) => b[0] - a[0]).map(([t, what]) =>
          el('li', null, el('span', { class: 'when' }, ago(t)), el('span', null, what))))),
    );
  }

  function teamDetail(t) {
    const open = t.closedAt === null;
    $('pl-det-title').textContent = t.name || '(no name)';
    $('pl-det-pill').replaceChildren(open ? pill('open', 'green') : pill('closed'));
    $('pl-detail').replaceChildren(
      el('dl', { class: 'facts' },
        el('div', null, el('dt', null, 'Team'), el('dd', null, 'team ' + t.id)),
        el('div', null, el('dt', null, 'Owner'), el('dd', null, t.ownerId ? idLink(t.ownerId) : 'none'))),
      stats([['Members', String(t.members)], ['Open reports', String(t.openReports)],
        ['Since', ago(t.createdAt)], ['Name', t.nameReset ? 'reset' : 'own']]),
      open ? el('div', { class: 'buttons-row' },
        !t.nameReset && btn('Reset team name', 'secondary big', () => resetTeam(t.id, false)),
        btn('Close team', 'danger big', () => closeTeam(t.id, false)))
        : el('p', { class: 'note' }, 'Closed ' + ago(t.closedAt) + '.'),
    );
  }

  function renderKinds() {
    $('pl-kinds').replaceChildren(...[['players', 'Players'], ['teams', 'Teams']].map(([kind, label]) =>
      choice('chip big', label, pl.kind === kind, () => {
        pl.kind = kind;
        pl.query = null;
        pl.pick = null;
        $('pl-q').value = '';
        $('pl-q').placeholder = kind === 'players' ? 'Nickname (its start) or account id' : 'Team name (its start) or id';
        loadPlayers().catch((error) => say(error.message, true));
      })));
  }

  async function loadPlayers() {
    renderKinds();
    const players = pl.kind === 'players';
    if (pl.query === null) {
      $('pl-meta').textContent = '';
      $('pl-list').replaceChildren(el('li', { class: 'notice info' }, players ? 'Search for a nickname or an account id.'
        : 'Search for a team name or id.'));
      $('pl-det-title').textContent = 'Details';
      $('pl-det-pill').replaceChildren();
      $('pl-detail').replaceChildren(el('p', { class: 'note' }, 'Pick a result on the left.'));
      return;
    }
    const data = players
      ? (await call('/api/moderation/players?q=' + encodeURIComponent(pl.query))).players
      : (await call('/api/moderation/teams?q=' + encodeURIComponent(pl.query))).teams;
    $('pl-meta').textContent = data.length + ' for "' + pl.query + '"';
    const keyOf = (x) => String(x.id);
    const picked = data.find((x) => keyOf(x) === pl.pick) || data[0] || null;
    pl.pick = picked ? keyOf(picked) : null;
    $('pl-list').replaceChildren(...(data.length > 0 ? data.map((x) => {
      const name = players ? x.nickname : x.name;
      const banned = players && x.bans.some((b) => b.active);
      return el('li', null, choice('pick', [
        el('span', { class: 'badge ' + (players ? 'player' : 'team'), 'aria-hidden': 'true' },
          (Array.from((name || '').trim())[0] || '?').toUpperCase()),
        el('span', { class: 'lines' }, el('strong', null, name || '(no name)'),
          el('span', null, players ? shortId(x.id) + ' · ' + x.openReports + ' open report(s)'
            : 'team ' + x.id + ' · ' + x.members + ' member(s)')),
        players ? (banned ? pill('banned', 'red') : '') : (x.closedAt !== null ? pill('closed') : ''),
      ], keyOf(x) === pl.pick, () => {
        pl.pick = keyOf(x);
        loadPlayers().catch((error) => say(error.message, true));
      }));
    }) : [el('li', { class: 'notice info' }, 'Nothing matches.')]));
    if (!picked) {
      $('pl-det-title').textContent = 'Details';
      $('pl-det-pill').replaceChildren();
      $('pl-detail').replaceChildren();
    } else if (players) playerDetail(picked);
    else teamDetail(picked);
  }

  /** Opens Players with this account looked up. */
  function showPlayer(id) {
    pl.kind = 'players';
    pl.query = id;
    pl.pick = String(id);
    $('pl-q').value = id;
    go('players');
  }

  function showTeam(id) {
    pl.kind = 'teams';
    pl.query = id;
    pl.pick = String(id);
    $('pl-q').value = id;
    go('players');
  }

  $('pl-find').addEventListener('submit', (event) => {
    event.preventDefault();
    pl.query = $('pl-q').value.trim();
    pl.pick = null;
    loadPlayers().catch((error) => say(error.message, true));
  });

  view('players', 'Players & teams', loadPlayers);
`;
