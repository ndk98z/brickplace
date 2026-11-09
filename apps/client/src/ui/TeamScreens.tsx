import { useState } from 'preact/hooks';
import type { Game } from '../game/game.ts';
import type { Teams } from '../game/teams.ts';
import {
  count,
  createNotice,
  inviteLink,
  joinLabel,
  memberCount,
  needsTeamName,
  placeholderTeamName,
  type RankedTeam,
  rankingCopy,
  switchNotice,
  type TeamDetail,
  type TeamSummary,
} from '../net/teams.ts';
import { PALETTE } from '../palette.ts';
import { Dialog } from './AccountDialogs.tsx';
import { TeamOnline } from './LiveStats.tsx';
import { useSelector } from './observable.ts';

// The team and ranking screens of the approved design, as dialogs over the map (ADR 0020).
// "Today" and "This week" rankings are not built: only the season's.

function Swatch({ color, size = 14 }: { color: number; size?: number }) {
  return (
    <span
      class="team-swatch"
      aria-hidden="true"
      style={{
        // Strings: Preact 11 adds no unit to numbers.
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: `${Math.round(size / 3)}px`,
        background: PALETTE[color] ?? '#b5bccb',
      }}
    />
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" class="toast-close profile-close" aria-label="Close" onClick={onClick}>
      ×
    </button>
  );
}

const PODIUM = ['podium-gold', 'podium-blue', 'podium-warm'];

function RankingDialog({ teams }: { teams: Teams }) {
  const { ranking, rankingFailed, season } = useSelector(teams.state, (s) => ({
    ranking: s.ranking,
    rankingFailed: s.rankingFailed,
    season: s.rankingSeason,
  }));
  const mine = useSelector(teams.account.state, (s) => s.me.user?.team?.id ?? null);
  const rows: readonly RankedTeam[] = ranking?.teams ?? [];
  const copy = rankingCopy(season, ranking?.over === true);
  return (
    <Dialog label="Team ranking" wide onClose={() => teams.close()}>
      <div class="profile-head">
        <div class="profile-name">
          <h1 class="dialog-title">Team ranking</h1>
          <span class="dialog-fine">{copy.sub}</span>
        </div>
        <CloseButton onClick={() => teams.close()} />
      </div>
      {rankingFailed && (
        <p class="dialog-note" role="status">
          The ranking cannot be read right now. Try again in a minute.
        </p>
      )}
      {ranking && rows.length === 0 && <p class="dialog-note">{copy.empty}</p>}
      {rows.length > 0 && (
        <div class="podium">
          {rows.slice(0, 3).map((team, i) => (
            <article key={team.id} class={`podium-card ${PODIUM[i]}`}>
              <div class="podium-name">
                <span class="podium-rank">#{team.rank}</span>
                <Swatch color={team.color} size={20} />
                <strong>{team.name}</strong>
              </div>
              <div class="podium-cells">{count(team.cells)}</div>
              <div class="dialog-fine">
                {team.closed ? 'cells standing' : `cells standing · ${memberCount(team.members)}`}
              </div>
            </article>
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <div class="ranking-scroll">
          <table class="ranking-table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Team</th>
                <th scope="col" class="num">
                  Cells standing
                </th>
                <th scope="col" class="num">
                  Built
                </th>
                <th scope="col" class="num">
                  Cleared
                </th>
                <th scope="col" class="num">
                  Shields placed
                </th>
                <th scope="col" class="num">
                  Members
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((team) => (
                <tr key={team.id} class={team.id === mine ? 'ranking-mine' : undefined}>
                  <td class="ranking-rank">{team.rank}</td>
                  <td>
                    <span class="ranking-team">
                      <Swatch color={team.color} />
                      {team.name}
                      {team.id === mine && <span class="badge-dark">Your team</span>}
                    </span>
                  </td>
                  <td class="num ranking-cells">{count(team.cells)}</td>
                  <td class="num">{count(team.built)}</td>
                  <td class="num">{count(team.cleared)}</td>
                  <td class="num">{count(team.shields)}</td>
                  <td class="num">{team.closed ? '–' : count(team.members)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p class="dialog-fine">
        Players who are not in a team still count toward the map, not toward the ranking. Each
        player's daily contribution is capped so no single account can carry a team.
      </p>
    </Dialog>
  );
}

function TeamCard({ teams, team }: { teams: Teams; team: TeamDetail }) {
  const user = useSelector(teams.account.state, (s) => s.me.user);
  const busy = useSelector(teams.state, (s) => s.busy);
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);
  const owner = user?.team?.owner === true;
  const wait = switchNotice(user?.teamJoinableAt);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink(location.origin, team.id));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div class="team-card">
      <div class="team-card-head">
        <Swatch color={team.color} size={56} />
        <div class="profile-name">
          <span class="dialog-fine">Your team</span>
          <h2 class="dialog-title">{team.name}</h2>
        </div>
        {team.rank !== null && <span class="team-rank">#{team.rank} this season</span>}
      </div>
      <p class="dialog-copy team-meta">
        {team.owner && <>owner {team.owner} · </>}
        {memberCount(team.members)} · anyone can join
        {team.owner && team.owner !== user?.nickname && (
          <>
            {' · '}
            <button
              type="button"
              class="link-btn link-inline"
              onClick={() => teams.account.openReport(team.owner!)}
            >
              Report owner's nickname
            </button>
            {!placeholderTeamName(team.name) && (
              <>
                {' · '}
                <ReportName teams={teams} team={team.id} />
              </>
            )}
          </>
        )}
      </p>
      <div class="team-stats">
        {(
          [
            ['Cells standing', team.cells],
            ['Built', team.built],
            ['Cleared', team.cleared],
            ['Shields placed', team.shields],
          ] as const
        ).map(([label, value]) => (
          <div key={label} class="team-stat">
            <span class="field-label">{label}</span>
            <span class="team-stat-value">{count(value)}</span>
          </div>
        ))}
      </div>
      <div class="team-actions">
        <button type="button" class="btn btn-outline btn-small" onClick={() => void copy()}>
          {copied ? 'Link copied' : 'Invite link'}
        </button>
        {owner && !closing ? (
          <button
            type="button"
            class="btn btn-danger btn-small"
            disabled={busy}
            onClick={() => setClosing(true)}
          >
            Close team
          </button>
        ) : (
          <button
            type="button"
            class="btn btn-danger btn-small"
            disabled={busy}
            onClick={() => void teams.leave()}
          >
            {owner ? 'Close it for everyone' : 'Leave team'}
          </button>
        )}
        {wait && <span class="dialog-fine">{wait}</span>}
      </div>
    </div>
  );
}

/**
 * The owner's new team name after a moderator reset it (ADR 0023). Focused when the team
 * screen opens for it (`data-autofocus`, see useModalFocus).
 */
function RenameTeam({ teams }: { teams: Teams }) {
  const busy = useSelector(teams.state, (s) => s.busy);
  const [name, setName] = useState('');
  const submit = (event: Event) => {
    event.preventDefault();
    void teams.rename(name);
  };
  return (
    <form class="team-create" onSubmit={submit}>
      <p class="dialog-note" id="team-rename-note">
        A moderator reset your team's name. Choose a new one: players see the placeholder until you
        do.
      </p>
      <label class="field">
        <span class="field-label">New team name</span>
        <input
          class="field-input"
          value={name}
          maxLength={20}
          autoComplete="off"
          spellcheck={false}
          data-autofocus
          aria-describedby="team-rename-note"
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
        <span class="field-hint">
          3–20 letters, numbers or _. Not the name that was reset, and unique among open teams.
        </span>
      </label>
      <button type="submit" class="btn-primary" disabled={busy}>
        {busy ? 'Saving…' : 'Save team name'}
      </button>
    </form>
  );
}

/** Reports a team's name to moderators (ADR 0023), after a second click to confirm. */
function ReportName({ teams, team }: { teams: Teams; team: number }) {
  const busy = useSelector(teams.state, (s) => s.busy);
  const [confirming, setConfirming] = useState(false);
  const click = () => {
    if (!confirming) setConfirming(true);
    else void teams.reportName(team).then(() => setConfirming(false));
  };
  return (
    <button type="button" class="link-btn link-inline" disabled={busy} onClick={click}>
      {confirming ? 'Confirm: report this team name' : 'Report team name'}
    </button>
  );
}

function TeamRow({
  teams,
  team,
  mine,
  meta,
}: {
  teams: Teams;
  team: TeamSummary;
  mine: number | null;
  meta: string;
}) {
  const busy = useSelector(teams.state, (s) => s.busy);
  const [confirming, setConfirming] = useState(false);
  const label = joinLabel(mine, team.id, confirming);
  const click = () => {
    if (mine !== null && !confirming) setConfirming(true);
    else void teams.join(team.id).then(() => setConfirming(false));
  };
  return (
    <li class="team-row">
      <Swatch color={team.color} size={36} />
      <span class="team-row-main">
        <strong>{team.name}</strong>
        <span class="dialog-fine">{meta}</span>
        {mine !== team.id && !placeholderTeamName(team.name) && (
          <ReportName teams={teams} team={team.id} />
        )}
      </span>
      <button
        type="button"
        class={confirming ? 'btn btn-dark btn-small' : 'btn btn-light btn-small'}
        disabled={busy || mine === team.id}
        onClick={click}
      >
        {label}
      </button>
    </li>
  );
}

function CreateTeam({ teams }: { teams: Teams }) {
  const user = useSelector(teams.account.state, (s) => s.me.user);
  const busy = useSelector(teams.state, (s) => s.busy);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(16);
  const wait = createNotice(user?.teamCreatableAt);
  if (!open) {
    return (
      <div class="team-create">
        <button
          type="button"
          class="btn-primary"
          disabled={user?.team?.owner === true}
          onClick={() => setOpen(true)}
        >
          Create a team
        </button>
        <span class="dialog-fine">
          {wait ?? 'You can create one team every 7 days and own one team at a time.'}
        </span>
      </div>
    );
  }
  const submit = async (event: Event) => {
    event.preventDefault();
    if (await teams.create(name, color)) setOpen(false);
  };
  return (
    <form class="team-create" onSubmit={submit}>
      <label class="field">
        <span class="field-label">Team name</span>
        <input
          class="field-input"
          value={name}
          maxLength={20}
          autoComplete="off"
          spellcheck={false}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
        <span class="field-hint">3–20 letters, numbers or _. Unique among open teams.</span>
      </label>
      <fieldset class="team-colors">
        <legend class="field-label">Colour</legend>
        {PALETTE.map((hex, i) => (
          <button
            key={hex}
            type="button"
            class="team-color"
            style={{ background: hex }}
            aria-label={`Colour ${i + 1}`}
            aria-pressed={color === i}
            onClick={() => setColor(i)}
          />
        ))}
      </fieldset>
      <button type="submit" class="btn-primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create team'}
      </button>
      <button type="button" class="link-btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

function TeamDialog({ teams }: { teams: Teams }) {
  const state = useSelector(teams.state, (s) => s);
  const user = useSelector(teams.account.state, (s) => s.me.user);
  const signedIn = useSelector(teams.account.state, (s) => s.me.signedIn);
  const mine = user?.team?.id ?? null;
  const shown = state.invited && !state.list.some((t) => t.id === state.invited!.id);
  const list = shown ? [state.invited!, ...state.list] : state.list;
  return (
    <Dialog label="Team" wide onClose={() => teams.close()}>
      <div class="profile-head">
        <div class="profile-name">
          <h1 class="dialog-title">Team</h1>
          <button
            type="button"
            class="link-btn link-inline"
            onClick={() => void teams.openRanking()}
          >
            See the team ranking
          </button>
        </div>
        <CloseButton onClick={() => teams.close()} />
      </div>
      {/* From the account view, not the team's detail: it is there as the dialog opens, so
          the field takes focus at once. */}
      {needsTeamName(user) && <RenameTeam teams={teams} />}
      {state.mine && <TeamCard teams={teams} team={state.mine} />}
      {!signedIn && (
        <p class="dialog-note">Sign in and pick a nickname to join or create a team.</p>
      )}
      {state.message && (
        <p class="field-error" role="status">
          {state.message}
        </p>
      )}
      {state.invited && (
        <p class="dialog-note">
          You were invited to {state.invited.name}
          {state.invited.closedAt !== null ? ', which has closed.' : '.'}
        </p>
      )}
      <section class="profile-section" aria-labelledby="find-team">
        <h2 id="find-team" class="section-title">
          Find a team
        </h2>
        <label class="field">
          <span class="field-label">Search teams</span>
          <input
            class="field-input"
            type="search"
            placeholder="Team name"
            value={state.query}
            maxLength={20}
            onInput={(e) => void teams.search((e.target as HTMLInputElement).value)}
          />
        </label>
        <ul class="team-list">
          {list
            .filter((t) => !('closedAt' in t) || (t as TeamDetail).closedAt === null)
            .map((team) => (
              <TeamRow
                key={team.id}
                teams={teams}
                team={team}
                mine={mine}
                meta={`${memberCount(team.members)} · ${count(team.cells)} cells`}
              />
            ))}
        </ul>
        {list.length === 0 && <span class="dialog-fine">No open team matches.</span>}
        {signedIn && <CreateTeam teams={teams} />}
      </section>
      <p class="dialog-fine">
        Teams only count for the ranking: cells belong to nobody and the map never shows who built
        what. What you do counts for the team you are in at that moment. If the owner leaves, the
        team closes and members can join another team straight away.
      </p>
    </Dialog>
  );
}

/** Whichever team screen is open. */
export function TeamScreens({ teams }: { teams: Teams }) {
  const screen = useSelector(teams.state, (s) => s.screen);
  if (screen === 'team') return <TeamDialog teams={teams} />;
  if (screen === 'ranking') return <RankingDialog teams={teams} />;
  return null;
}

/** The pill over the map: the account's team, opening the team screen. */
export function TeamPill({ teams, game }: { teams: Teams; game?: Game }) {
  const team = useSelector(teams.account.state, (s) => s.me.user?.team ?? null);
  return (
    <button
      type="button"
      class={team ? 'pill pill-button' : 'pill pill-muted pill-button'}
      onClick={() => void teams.openTeam()}
    >
      {team ? (
        <Swatch color={team.color} size={10} />
      ) : (
        <span class="team-dot" aria-hidden="true" />
      )}
      {team ? team.name : 'No team yet'}
      {team && game && <TeamOnline game={game} />}
    </button>
  );
}
