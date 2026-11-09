import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Account } from '../game/account.ts';
import type { Game } from '../game/game.ts';
import type { PrefKey } from '../game/prefs.ts';
import {
  confirmsDeletion,
  DELETE_WORD,
  deleteMessage,
  type NicknameError,
  nicknameMessage,
  nicknameProblem,
  PROVIDER_NAMES,
  type ProviderId,
  REPORT_REASONS,
  type ReportError,
  type ReportReason,
  reportMessage,
  type SeasonNumbers,
  seasonTiles,
} from '../net/account.ts';
import { count } from '../net/teams.ts';
import { useModalFocus } from './focus.ts';
import { LogoMark } from './Logo.tsx';
import { LEGAL } from './links.ts';
import { useSelector } from './observable.ts';
import { ProviderLogo } from './ProviderLogo.tsx';

interface TurnstileApi {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  remove(widget: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let turnstileLoading: Promise<TurnstileApi> | null = null;

/** Loads Turnstile only when the sign-in dialog opens, so the game page stays light. */
function loadTurnstile(): Promise<TurnstileApi> {
  turnstileLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error()));
    script.onerror = () => {
      turnstileLoading = null;
      reject(new Error('turnstile did not load'));
    };
    document.head.append(script);
  });
  return turnstileLoading;
}

type Check = { state: 'waiting' } | { state: 'passed'; token: string } | { state: 'failed' };

/**
 * The Cloudflare Turnstile widget; the server checks its token before creating an account
 * (action `signin`) or lifting a challenge (action `challenge`, ADR 0026).
 */
function HumanCheck({
  siteKey,
  onChange,
  action = 'signin',
}: {
  siteKey: string;
  onChange: (c: Check) => void;
  action?: 'signin' | 'challenge';
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let widget: string | null = null;
    let api: TurnstileApi | null = null;
    let live = true;
    loadTurnstile()
      .then((loaded) => {
        if (!live || !box.current) return;
        api = loaded;
        widget = loaded.render(box.current, {
          sitekey: siteKey,
          // The server accepts only tokens from this widget (see gateway turnstile.ts).
          action,
          theme: 'light',
          callback: (token: string) => onChange({ state: 'passed', token }),
          'expired-callback': () => onChange({ state: 'waiting' }),
          'error-callback': () => onChange({ state: 'failed' }),
        });
      })
      .catch(() => live && onChange({ state: 'failed' }));
    return () => {
      live = false;
      if (api && widget) api.remove(widget);
    };
  }, [siteKey, onChange, action]);
  return <div ref={box} class="human-check" />;
}

/** Copy for a challenge the server did not lift. */
function challengeMessage(error: string): string {
  if (error === 'turnstile') return 'We could not confirm that. Finish the check and try again.';
  if (error === 'signed_out' || error === 'csrf') return 'Your session ended. Reload to sign in.';
  return 'The server could not take it just now. Try again in a moment.';
}

/**
 * "Confirm you are human" (ADR 0026): the server saw this account move like a script and
 * holds its moves until a fresh Turnstile passes. The move the page sent waits and goes
 * through once it does. No way to dismiss it: the map keeps updating behind it.
 */
export function ChallengeDialog({ game, account }: { game: Game; account: Account }) {
  const open = useSelector(game.ui, (s) => s.challenge);
  const siteKey = useSelector(account.state, (s) => s.me.config.turnstileSiteKey);
  const [check, setCheck] = useState<Check>({ state: 'waiting' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  // Without a widget (not configured) the server still decides; in local dev it lets it pass.
  const token = check.state === 'passed' ? check.token : null;
  const ready = !busy && (!siteKey || token !== null);
  const submit = async () => {
    setBusy(true);
    const problem = await account.passChallenge(token);
    setBusy(false);
    setError(problem);
    if (problem) setCheck({ state: 'waiting' });
  };
  return (
    <Dialog label="Confirm you are human">
      <div class="dialog-head">
        <h1 class="dialog-title">Quick check</h1>
        <p class="dialog-copy">
          Your last moves looked automated, so we need to check you are a person before the next
          one. Your move is waiting and goes through once you pass.
        </p>
      </div>
      {siteKey && (
        <HumanCheck key={error ?? ''} siteKey={siteKey} onChange={setCheck} action="challenge" />
      )}
      {error && (
        <span class="field-error" role="status">
          {challengeMessage(error)}
        </span>
      )}
      <button type="button" class="btn-primary" disabled={!ready} onClick={() => void submit()}>
        {busy ? 'Checking…' : 'Continue'}
      </button>
    </Dialog>
  );
}

export function Dialog({
  label,
  wide,
  onClose,
  children,
}: {
  label: string;
  wide?: boolean;
  onClose?: () => void;
  children: ComponentChildren;
}) {
  const box = useRef<HTMLElement>(null);
  useModalFocus(box, onClose);
  return (
    <div class="dialog-backdrop">
      <section
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        class={`dialog${wide ? ' dialog-wide' : ''}`}
      >
        {children}
      </section>
    </div>
  );
}

function SignInDialog({ account }: { account: Account }) {
  const config = useSelector(account.state, (s) => s.me.config);
  const [check, setCheck] = useState<Check>({ state: 'waiting' });
  const siteKey = config.turnstileSiteKey;
  // Without a widget (not configured, or it failed to load) the server still decides: a
  // returning player signs in, a new account needs the check to have passed.
  const ready = !siteKey || check.state !== 'waiting';
  const close = () => account.close();
  return (
    <Dialog label="Sign in" onClose={close}>
      <div class="dialog-head">
        <LogoMark size={40} />
        <h1 class="dialog-title">Sign in to place bricks</h1>
        <p class="dialog-copy">
          Your items, cooldown and team follow your account. Anyone can look around without one.
        </p>
      </div>
      {config.providers.length === 0 ? (
        <p class="dialog-note">Sign-in is not open on this server yet. You can still watch.</p>
      ) : (
        <div class="provider-list">
          {config.providers.map((provider) => (
            <button
              key={provider}
              type="button"
              class="provider-btn"
              disabled={!ready}
              onClick={() =>
                account.signIn(provider, check.state === 'passed' ? check.token : null)
              }
            >
              <ProviderLogo provider={provider} />
              Continue with {PROVIDER_NAMES[provider]}
            </button>
          ))}
        </div>
      )}
      {siteKey && config.providers.length > 0 && (
        <HumanCheck siteKey={siteKey} onChange={setCheck} />
      )}
      <p class="dialog-fine">
        We read your account name and, where the provider shares it, your verified email. By
        continuing you agree to the{' '}
        <a href={LEGAL.terms} target="_blank" rel="noopener">
          Terms
        </a>{' '}
        and{' '}
        <a href={LEGAL.privacy} target="_blank" rel="noopener">
          Privacy Policy
        </a>
        .
      </p>
      <button type="button" class="link-btn" onClick={close}>
        Just looking? Explore the map
      </button>
    </Dialog>
  );
}

function NicknameField({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial: string;
  submitLabel: string;
  onSubmit: (nickname: string) => Promise<{ error: NicknameError; retryAt?: number } | null>;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: Event) => {
    event.preventDefault();
    const local = nicknameProblem(value);
    if (local) {
      setError(nicknameMessage(local));
      return;
    }
    setBusy(true);
    const problem = await onSubmit(value);
    setBusy(false);
    setError(problem ? nicknameMessage(problem.error, problem.retryAt) : null);
  };
  return (
    <form class="nickname-form" onSubmit={submit}>
      <label class="field">
        <span class="field-label">Nickname</span>
        <input
          class="field-input"
          value={value}
          maxLength={20}
          autoComplete="nickname"
          spellcheck={false}
          aria-invalid={error !== null}
          aria-describedby="nickname-hint"
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
        <span id="nickname-hint" class={error ? 'field-error' : 'field-hint'} role="status">
          {error ?? '3–20 letters, numbers or _. Unique, and you can change it every 30 days.'}
        </span>
      </label>
      <button type="submit" class="btn-primary" disabled={busy}>
        {busy ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}

function NicknameDialog({ account }: { account: Account }) {
  const user = useSelector(account.state, (s) => s.me.user);
  if (!user) return null;
  return (
    <Dialog label="Pick a nickname" onClose={() => account.close()}>
      <div class="dialog-head">
        <LogoMark size={40} />
        <h1 class="dialog-title">Pick a nickname</h1>
        <p class="dialog-copy">
          This is how other players see you on teams and in the ranking. The map never shows who
          placed what.
        </p>
      </div>
      <NicknameField
        initial={user.suggestedNickname}
        submitLabel="Start playing"
        onSubmit={async (nickname) => {
          const result = await account.chooseNickname(nickname);
          return result.ok ? null : result;
        }}
      />
      <button type="button" class="link-btn" onClick={() => void account.signOut()}>
        Sign out
      </button>
      <button type="button" class="link-btn" onClick={() => account.open('profile')}>
        Download or delete this account
      </button>
    </Dialog>
  );
}

const LINKABLE: readonly ProviderId[] = ['google', 'reddit', 'discord', 'dev'];

const PREF_ROWS: readonly { key: PrefKey; label: string; hint: string }[] = [
  { key: 'grid', label: 'Grid lines', hint: 'Show cell borders when zoomed in' },
  { key: 'coords', label: 'Coordinates', hint: 'Show x and y under the cursor' },
  { key: 'sound', label: 'Sound effects', hint: 'Clicks when you place, clear or shield' },
  { key: 'reduceMotion', label: 'Reduce motion', hint: 'Turn off map animations' },
];

/** What the switches need from the game: the preferences, and setting one from a click. */
export type Settings = Pick<Game, 'prefs' | 'setPreference'>;

/** The Profile design's switches, kept in this browser (prefs.ts). */
function PreferenceSwitches({ settings }: { settings: Settings }) {
  const values = useSelector(settings.prefs.state, (p) => p);
  return (
    <section class="profile-section" aria-labelledby="prefs-title">
      <h2 id="prefs-title" class="section-title">
        Preferences
      </h2>
      {PREF_ROWS.map(({ key, label, hint }) => (
        <div key={key} class="profile-row">
          <span class="profile-row-main pref-text">
            <span class="pref-label">{label}</span>
            <span id={`pref-${key}`} class="dialog-fine">
              {hint}
            </span>
          </span>
          <button
            type="button"
            role="switch"
            class="switch"
            aria-checked={values[key]}
            aria-label={label}
            aria-describedby={`pref-${key}`}
            onClick={() => settings.setPreference(key, !values[key])}
          >
            <span class="switch-knob" />
          </button>
        </div>
      ))}
      <span class="dialog-fine">Saved in this browser only.</span>
    </section>
  );
}

/**
 * "Your season" (ADR 0031): this account's moves on the current map, read once each time the
 * profile opens. Still shown while a season is finalizing; the seal empties them.
 */
function SeasonCard({ account }: { account: Account }) {
  // undefined while asking, null when they cannot be read.
  const [numbers, setNumbers] = useState<SeasonNumbers | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void account.seasonNumbers().then((answer) => {
      if (live) setNumbers(answer);
    });
    return () => {
      live = false;
    };
  }, [account]);
  return (
    <section
      class="profile-section"
      aria-labelledby="season-title"
      aria-busy={numbers === undefined}
    >
      <h2 id="season-title" class="section-title">
        Your season
      </h2>
      {numbers === null ? (
        <span class="dialog-fine">Your numbers cannot be shown right now. Try again later.</span>
      ) : (
        <>
          <div class="team-stats">
            {seasonTiles(
              numbers ?? { season: null, bricks: 0, hammers: 0, shields: 0, days: 0 },
            ).map(([label, value]) => (
              <div key={label} class="team-stat season-stat">
                <span class="field-label">{label}</span>
                <span class="team-stat-value">{numbers ? count(value) : '–'}</span>
              </div>
            ))}
          </div>
          <span class="dialog-fine">Only you can see these numbers.</span>
        </>
      )}
    </section>
  );
}

function ProfileDialog({ account, settings }: { account: Account; settings: Settings }) {
  const me = useSelector(account.state, (s) => s.me);
  const [message, setMessage] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const user = me.user;
  if (!user) return null;
  const linked = new Set(user.identities.map((i) => i.provider));
  const rows = LINKABLE.filter((p) => linked.has(p) || me.config.providers.includes(p));
  const changeable = user.nicknameChangeableAt;
  const canRename = changeable === null || changeable <= Date.now();
  const unlink = async (provider: ProviderId) => {
    const error = await account.unlink(provider);
    setMessage(
      error === 'last_identity'
        ? 'Keep at least one account connected.'
        : error
          ? 'That did not work. Try again in a minute.'
          : null,
    );
  };
  return (
    <Dialog label="Profile" wide onClose={() => account.close()}>
      <div class="profile-head">
        <span class="avatar" aria-hidden="true">
          {(user.nickname ?? '?')[0]!.toUpperCase()}
        </span>
        <div class="profile-name">
          <h1 class="dialog-title">{user.nickname ?? 'No nickname yet'}</h1>
          {user.email && <span class="dialog-fine">{user.email}</span>}
        </div>
        <button
          type="button"
          class="toast-close profile-close"
          aria-label="Close"
          onClick={() => account.close()}
        >
          ×
        </button>
      </div>

      <SeasonCard account={account} />

      <section class="profile-section" aria-labelledby="nickname-title">
        <h2 id="nickname-title" class="section-title">
          Nickname
        </h2>
        {renaming ? (
          <NicknameField
            initial={user.nickname ?? user.suggestedNickname}
            submitLabel="Save nickname"
            onSubmit={async (nickname) => {
              const result = await account.chooseNickname(nickname);
              if (result.ok) setRenaming(false);
              return result.ok ? null : result;
            }}
          />
        ) : (
          <div class="profile-row">
            <span class="profile-row-main">
              {canRename || changeable === null
                ? 'You can change it now. After that, once every 30 days.'
                : `Next change possible on ${new Date(changeable).toLocaleDateString()}.`}
            </span>
            <button
              type="button"
              class="btn btn-light btn-small"
              disabled={!canRename}
              onClick={() => setRenaming(true)}
            >
              Change
            </button>
          </div>
        )}
      </section>

      <section class="profile-section" aria-labelledby="accounts-title">
        <h2 id="accounts-title" class="section-title">
          Sign-in accounts
        </h2>
        {rows.map((provider) => (
          <div key={provider} class="profile-row">
            <span class="profile-row-main profile-provider">
              <ProviderLogo provider={provider} size={18} />
              {PROVIDER_NAMES[provider]}
            </span>
            {linked.has(provider) ? (
              <>
                <span class="connected">Connected</span>
                <button
                  type="button"
                  class="btn btn-light btn-small"
                  disabled={linked.size < 2}
                  onClick={() => void unlink(provider)}
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                class="btn btn-outline btn-small"
                onClick={() => {
                  // The server links only from a recent sign-in; say so instead of bouncing.
                  if (Date.now() < user.linkUntil) account.link(provider);
                  else
                    setMessage(
                      'For safety, connecting needs a sign-in from the last 10 minutes. Sign out, sign in again, then connect.',
                    );
                }}
              >
                Connect
              </button>
            )}
          </div>
        ))}
        <span class="dialog-fine">
          {message ??
            'Keep at least one account connected. Linking more does not give extra items.'}
        </span>
      </section>

      <PreferenceSwitches settings={settings} />

      {user.nickname && (
        <section class="profile-section" aria-labelledby="report-title">
          <h2 id="report-title" class="section-title">
            Report a nickname
          </h2>
          <div class="profile-row">
            <span class="profile-row-main">
              Seen a nickname that is offensive or pretends to be someone? Tell the moderators.
            </span>
            <button
              type="button"
              class="btn btn-light btn-small"
              onClick={() => account.openReport()}
            >
              Report
            </button>
          </div>
        </section>
      )}

      <YourData account={account} nickname={user.nickname} linkUntil={user.linkUntil} />

      <div class="profile-actions">
        <button type="button" class="btn btn-light" onClick={() => void account.signOut(true)}>
          Sign out everywhere
        </button>
        <button type="button" class="btn btn-dark" onClick={() => void account.signOut()}>
          Sign out
        </button>
      </div>
    </Dialog>
  );
}

/** Data download and account deletion (ADR 0008, 0019). */
function YourData({
  account,
  nickname,
  linkUntil,
}: {
  account: Account;
  nickname: string | null;
  linkUntil: number;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState('');
  const download = async () => {
    setBusy(true);
    const error = await account.downloadData();
    setBusy(false);
    setMessage(error ? deleteMessage(error) : null);
  };
  const remove = async (event: Event) => {
    event.preventDefault();
    if (!confirmsDeletion(typed, nickname)) {
      setMessage(deleteMessage('confirm'));
      return;
    }
    setBusy(true);
    const error = await account.deleteAccount(typed);
    setBusy(false);
    if (error) setMessage(deleteMessage(error));
  };
  const word = nickname ?? DELETE_WORD;
  return (
    <section class="profile-section" aria-labelledby="data-title">
      <h2 id="data-title" class="section-title">
        Your data
      </h2>
      <div class="profile-row">
        <span class="profile-row-main">
          A file with your account, sign-ins, bans and the reports you sent.
        </span>
        <button
          type="button"
          class="btn btn-light btn-small"
          disabled={busy}
          onClick={() => void download()}
        >
          Download
        </button>
      </div>
      {deleting ? (
        Date.now() < linkUntil ? (
          <form class="nickname-form" onSubmit={remove}>
            <p class="dialog-fine">
              This deletes your account, sign-ins, nickname and reports for good. The cells you
              placed stay on the map, linked to no one. Open games stop playing within an hour, and
              a new account with the same sign-in can be made after that hour.
            </p>
            <label class="field">
              <span class="field-label">Type {word} to confirm</span>
              <input
                class="field-input"
                value={typed}
                autoComplete="off"
                spellcheck={false}
                onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
              />
            </label>
            <div class="profile-actions">
              <button
                type="button"
                class="btn btn-light btn-small"
                onClick={() => {
                  setDeleting(false);
                  setTyped('');
                  setMessage(null);
                }}
              >
                Keep my account
              </button>
              <button
                type="submit"
                class="btn btn-danger btn-small"
                disabled={busy || !confirmsDeletion(typed, nickname)}
              >
                Delete my account
              </button>
            </div>
          </form>
        ) : (
          <span class="dialog-fine">{deleteMessage('reauth')}</span>
        )
      ) : (
        <div class="profile-row">
          <span class="profile-row-main">Delete your account and everything linked to it.</span>
          <button type="button" class="btn btn-light btn-small" onClick={() => setDeleting(true)}>
            Delete account
          </button>
        </div>
      )}
      {message && (
        <span class="field-error" role="status">
          {message}
        </span>
      )}
    </section>
  );
}

function ReportDialog({ account }: { account: Account }) {
  const initial = useSelector(account.state, (s) => s.reportTarget);
  const [nickname, setNickname] = useState(initial);
  const [reason, setReason] = useState<ReportReason | ''>('');
  const [result, setResult] = useState<'sent' | ReportError | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => account.closeReport();
  const submit = async (event: Event) => {
    event.preventDefault();
    if (!reason) {
      setResult('reason');
      return;
    }
    if (nicknameProblem(nickname)) {
      setResult('not_found');
      return;
    }
    setBusy(true);
    setResult(await account.report(nickname, reason));
    setBusy(false);
  };
  return (
    <Dialog label="Report a nickname" onClose={close}>
      <div class="dialog-head">
        <h1 class="dialog-title">Report a nickname</h1>
        <p class="dialog-copy">
          Moderators read every report. The player is not told who reported them.
        </p>
      </div>
      {result === 'sent' ? (
        <p class="dialog-note" role="status">
          {reportMessage('sent')}
        </p>
      ) : (
        <form class="nickname-form" onSubmit={submit}>
          <label class="field">
            <span class="field-label">Nickname</span>
            <input
              class="field-input"
              value={nickname}
              maxLength={20}
              autoComplete="off"
              spellcheck={false}
              onInput={(e) => setNickname((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="field">
            <span class="field-label">Reason</span>
            <select
              class="field-input"
              value={reason}
              onChange={(e) => setReason((e.target as HTMLSelectElement).value as ReportReason)}
            >
              <option value="" disabled>
                Choose a reason
              </option>
              {(Object.keys(REPORT_REASONS) as ReportReason[]).map((key) => (
                <option key={key} value={key}>
                  {REPORT_REASONS[key]}
                </option>
              ))}
            </select>
          </label>
          {result && (
            <span class="field-error" role="status">
              {reportMessage(result)}
            </span>
          )}
          <button type="submit" class="btn-primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send report'}
          </button>
        </form>
      )}
      <button type="button" class="link-btn" onClick={close}>
        {result === 'sent' ? 'Close' : 'Cancel'}
      </button>
    </Dialog>
  );
}

/** Whichever account dialog is open. */
export function AccountDialogs({ account, settings }: { account: Account; settings: Settings }) {
  const dialog = useSelector(account.state, (s) => s.dialog);
  if (dialog === 'signin') return <SignInDialog account={account} />;
  if (dialog === 'nickname') return <NicknameDialog account={account} />;
  if (dialog === 'profile') return <ProfileDialog account={account} settings={settings} />;
  if (dialog === 'report') return <ReportDialog account={account} />;
  return null;
}

/** The header's account button: sign in, pick a nickname, or open the profile. */
export function AccountButton({ account }: { account: Account }) {
  const me = useSelector(account.state, (s) => s.me);
  if (!me.signedIn) {
    if (me.config.providers.length === 0) return null;
    return (
      <button type="button" class="btn btn-dark btn-small" onClick={() => account.open('signin')}>
        Sign in
      </button>
    );
  }
  const nickname = me.user?.nickname;
  if (!nickname) {
    return (
      <button type="button" class="btn btn-dark btn-small" onClick={() => account.open('nickname')}>
        Pick a nickname
      </button>
    );
  }
  return (
    <button type="button" class="account-chip" onClick={() => account.open('profile')}>
      <span class="avatar avatar-small" aria-hidden="true">
        {nickname[0]!.toUpperCase()}
      </span>
      {nickname}
    </button>
  );
}
