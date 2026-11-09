// Accounts in D1 (ADR 0008, 0016): users, their linked provider identities and bans.
// Schema: workers/gateway/migrations. All times are ms since the epoch.

import type { ProviderId, ProviderIdentity } from './providers.ts';
import { openTeamNamed, teamsOnDeletion } from './teams.ts';
import { base64url, type KeyRing } from './token.ts';

export interface User {
  readonly id: string;
  readonly email: string | null;
  readonly nickname: string | null;
  readonly nickname_changed_at: number | null;
  readonly created_at: number;
  readonly sessions_valid_after: number;
}

export interface Identity {
  readonly provider: ProviderId;
  readonly display_name: string | null;
  readonly created_at: number;
}

/**
 * The columns of a User from `users` aliased as `t`. A nickname a moderator reset to a
 * placeholder reads as none (ADR 0023): the account only watches until it chooses a new one,
 * and that choice skips the 30-day limit.
 */
const USER_COLUMNS =
  't.id AS id, t.email AS email, ' +
  'CASE WHEN t.nickname_reset_at IS NULL THEN t.nickname END AS nickname, ' +
  't.nickname_changed_at AS nickname_changed_at, t.created_at AS created_at, ' +
  't.sessions_valid_after AS sessions_valid_after';

export async function userById(db: D1Database, id: string): Promise<User | null> {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users t WHERE id = ?`).bind(id).first<User>();
}

export async function userByIdentity(
  db: D1Database,
  provider: ProviderId,
  subject: string,
): Promise<User | null> {
  return db
    .prepare(
      `SELECT ${USER_COLUMNS} FROM identities i ` +
        'JOIN users t ON t.id = i.user_id WHERE i.provider = ? AND i.subject = ?',
    )
    .bind(provider, subject)
    .first<User>();
}

export async function identitiesOf(db: D1Database, user: string): Promise<Identity[]> {
  const { results } = await db
    .prepare(
      'SELECT provider, display_name, created_at FROM identities WHERE user_id = ? ' +
        'ORDER BY created_at',
    )
    .bind(user)
    .all<Identity>();
  return results;
}

/** A new account with its first identity, in one batch (one transaction). */
export async function createUser(
  db: D1Database,
  provider: ProviderId,
  identity: ProviderIdentity,
  now: number,
): Promise<User> {
  const id = crypto.randomUUID();
  await db.batch([
    db
      .prepare('INSERT INTO users (id, email, created_at, signed_in_at) VALUES (?, ?, ?, ?)')
      .bind(id, identity.email, now, now),
    insertIdentity(db, id, provider, identity, now),
  ]);
  return {
    id,
    email: identity.email,
    nickname: null,
    nickname_changed_at: null,
    created_at: now,
    sessions_valid_after: 0,
  };
}

function insertIdentity(
  db: D1Database,
  user: string,
  provider: ProviderId,
  identity: ProviderIdentity,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO identities (provider, subject, user_id, email, display_name, created_at, ' +
        'signed_in_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(provider, identity.subject, user, identity.email, identity.name, now, now);
}

/** Records a returning sign-in and refreshes what the provider says about the person. */
export async function recordSignIn(
  db: D1Database,
  user: string,
  provider: ProviderId,
  identity: ProviderIdentity,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        'UPDATE identities SET email = ?, display_name = ?, signed_in_at = ? ' +
          'WHERE provider = ? AND subject = ?',
      )
      .bind(identity.email, identity.name, now, provider, identity.subject),
    db
      .prepare('UPDATE users SET signed_in_at = ?, email = COALESCE(email, ?) WHERE id = ?')
      .bind(now, identity.email, user),
  ]);
}

export type LinkResult = 'linked' | 'already' | 'taken' | 'provider_taken';

/**
 * Links another provider account to this user. Never merges accounts: an identity that
 * already belongs to someone else stays theirs (`taken`), and an account has at most one
 * identity per provider (`provider_taken`).
 */
export async function linkIdentity(
  db: D1Database,
  user: string,
  provider: ProviderId,
  identity: ProviderIdentity,
  now: number,
): Promise<LinkResult> {
  const owner = await db
    .prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?')
    .bind(provider, identity.subject)
    .first<{ user_id: string }>();
  if (owner) return owner.user_id === user ? 'already' : 'taken';
  try {
    await db.batch([
      insertIdentity(db, user, provider, identity, now),
      db
        .prepare('UPDATE users SET email = COALESCE(email, ?) WHERE id = ?')
        .bind(identity.email, user),
    ]);
  } catch (error) {
    // UNIQUE (user_id, provider), or a race with another link of the same identity.
    if (String(error).includes('UNIQUE')) {
      const again = await db
        .prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?')
        .bind(provider, identity.subject)
        .first<{ user_id: string }>();
      if (again) return again.user_id === user ? 'already' : 'taken';
      return 'provider_taken';
    }
    throw error;
  }
  return 'linked';
}

/** Unlinks a provider, but never the last one: an account must stay reachable. */
export async function unlinkIdentity(
  db: D1Database,
  user: string,
  provider: ProviderId,
): Promise<'unlinked' | 'last' | 'missing'> {
  const result = await db
    .prepare(
      'DELETE FROM identities WHERE user_id = ? AND provider = ? ' +
        'AND (SELECT COUNT(*) FROM identities WHERE user_id = ?) > 1',
    )
    .bind(user, provider, user)
    .run();
  if (result.meta.changes > 0) return 'unlinked';
  const exists = await db
    .prepare('SELECT 1 AS one FROM identities WHERE user_id = ? AND provider = ?')
    .bind(user, provider)
    .first();
  return exists ? 'last' : 'missing';
}

/** True while a ban that is neither lifted nor expired applies. */
export async function banned(db: D1Database, user: string, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      'SELECT 1 AS one FROM bans WHERE user_id = ? AND lifted_at IS NULL ' +
        'AND (expires_at IS NULL OR expires_at > ?) LIMIT 1',
    )
    .bind(user, now)
    .first();
  return row !== null;
}

/**
 * Sets the nickname: the first one any time, the one after a moderator's reset any time (ADR
 * 0023), otherwise a new one only if the last change was at least `renameEvery` ms ago. The
 * limit is part of the UPDATE, so two renames racing cannot both pass it (`too_soon`);
 * `taken` when another account holds the name in any letter case, or an open team does (a
 * player may not pass for a team, ADR 0020; also a condition of the UPDATE, so a team created
 * at the same moment cannot slip past it); `blocked` for the name a moderator's last reset
 * removed from this account.
 */
export async function setNickname(
  db: D1Database,
  user: string,
  nickname: string,
  key: string,
  now: number,
  renameEvery: number,
): Promise<'ok' | 'taken' | 'too_soon' | 'blocked'> {
  try {
    const result = await db
      .prepare(
        'UPDATE users SET nickname = ?1, nickname_key = ?2, nickname_changed_at = ?3, ' +
          'nickname_reset_at = NULL WHERE id = ?4 AND (nickname IS NULL OR ' +
          'nickname_reset_at IS NOT NULL OR COALESCE(nickname_changed_at, 0) <= ?5) ' +
          'AND (nickname_reset_key IS NULL OR nickname_reset_key <> ?2) ' +
          `AND NOT EXISTS (${openTeamNamed('?2')})`,
      )
      .bind(nickname, key, now, user, now - renameEvery)
      .run();
    if (result.meta.changes > 0) return 'ok';
    const removed = await db
      .prepare('SELECT 1 AS one FROM users WHERE id = ? AND nickname_reset_key = ?')
      .bind(user, key)
      .first();
    if (removed) return 'blocked';
    const team = await db.prepare(openTeamNamed('?')).bind(key).first();
    return team ? 'taken' : 'too_soon';
  } catch (error) {
    if (String(error).includes('UNIQUE')) return 'taken';
    throw error;
  }
}

/** Ends every session of this user at its next renewal ("sign out everywhere"). */
export async function revokeSessions(db: D1Database, user: string, now: number): Promise<void> {
  await db.prepare('UPDATE users SET sessions_valid_after = ? WHERE id = ?').bind(now, user).run();
}

/**
 * The account holding this nickname (any letter case), if any. A moderator's placeholder
 * names nobody: a reset account has no nickname until it chooses one (ADR 0023).
 */
export async function userByNickname(
  db: D1Database,
  key: string,
): Promise<{ id: string; nickname: string } | null> {
  return db
    .prepare('SELECT id, nickname FROM users WHERE nickname_key = ? AND nickname_reset_at IS NULL')
    .bind(key)
    .first<{ id: string; nickname: string }>();
}

/**
 * Everything D1 holds about one account, for the data download (ADR 0008, 0019). Provider
 * access tokens are never stored, so there are none to leave out; bans say what and when,
 * not which moderator; reports filed name the nickname as reported, not the other account.
 */
export async function accountData(db: D1Database, user: string) {
  const [account, identities, bans, reports, team] = await db.batch([
    db
      .prepare(
        'SELECT id, email, nickname, nickname_changed_at, nickname_reset_at, ' +
          'nickname_reset_key, created_at, signed_in_at, sessions_valid_after FROM users ' +
          'WHERE id = ?',
      )
      .bind(user),
    db
      .prepare(
        'SELECT provider, subject, email, display_name, created_at, signed_in_at ' +
          'FROM identities WHERE user_id = ? ORDER BY created_at',
      )
      .bind(user),
    db
      .prepare(
        'SELECT reason, created_at, expires_at, lifted_at FROM bans WHERE user_id = ? ' +
          'ORDER BY created_at',
      )
      .bind(user),
    db
      .prepare(
        'SELECT target_nickname, reason, created_at, status, resolved_at FROM reports ' +
          'WHERE reporter_id = ? ORDER BY created_at',
      )
      .bind(user),
    // Teams (ADR 0020): the current one, and the times the joining and creating rules use.
    db
      .prepare(
        'SELECT t.name AS team_name, CASE WHEN t.owner_id = p.user_id THEN 1 ELSE 0 END AS ' +
          'team_owner, p.joined_at, p.created_team_at FROM team_players p ' +
          'LEFT JOIN teams t ON t.id = p.team_id WHERE p.user_id = ?',
      )
      .bind(user),
  ]);
  return {
    user: (account?.results[0] ?? null) as Record<string, unknown> | null,
    identities: (identities?.results ?? []) as Record<string, unknown>[],
    bans: (bans?.results ?? []) as Record<string, unknown>[],
    reportsFiled: (reports?.results ?? []) as Record<string, unknown>[],
    team: (team?.results[0] ?? null) as Record<string, unknown> | null,
  };
}

/**
 * Keyed hashes of a provider identity, one per session key, the signing key's first: what
 * `deleted_identities` holds instead of the provider's id. Every key is tried on lookup, so a
 * key rotation during the hold-off does not open it early.
 */
export async function identityHashes(
  ring: KeyRing,
  provider: string,
  subject: string,
): Promise<string[]> {
  const input = new TextEncoder().encode(`deleted-identity\n${provider}\n${subject}`);
  const keys = [ring.signer.key, ...[...ring.keys.values()].filter((k) => k !== ring.signer.key)];
  return Promise.all(
    keys.map(async (key) =>
      base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, input))),
    ),
  );
}

/**
 * True while a new account may not be made from this provider identity: an account holding
 * it was deleted less than `holdOff` ms ago.
 */
export async function recentlyDeleted(
  db: D1Database,
  ring: KeyRing,
  provider: string,
  subject: string,
  now: number,
  holdOff: number,
): Promise<boolean> {
  const hashes = await identityHashes(ring, provider, subject);
  // Expired rows are dropped here too, so none outlives the hold-off for long even when no
  // account is deleted for a while (only new sign-ups get here: rare, unlike sign-ins).
  const [, found] = await db.batch([
    db.prepare('DELETE FROM deleted_identities WHERE deleted_at <= ?').bind(now - holdOff),
    db
      .prepare(
        `SELECT 1 AS one FROM deleted_identities WHERE deleted_at > ? AND hash IN (${hashes
          .map(() => '?')
          .join(', ')}) LIMIT 1`,
      )
      .bind(now - holdOff, ...hashes),
  ]);
  return (found?.results.length ?? 0) > 0;
}

/**
 * Deletes an account in one batch (one transaction): its bans move to an audit table with no
 * link to anyone, its reports (filed and received), identities and user row go, and its id
 * joins `deleted_accounts`, which a trigger keeps from ever being inserted again. Freeing the
 * row frees the nickname. Its identities are kept as keyed hashes in `deleted_identities`
 * (rows older than `holdOff` are pruned here). Returns false when there was no such account.
 */
export async function deleteAccount(
  db: D1Database,
  ring: KeyRing,
  user: string,
  now: number,
  holdOff: number,
): Promise<boolean> {
  const { results: linked } = await db
    .prepare('SELECT provider, subject FROM identities WHERE user_id = ?')
    .bind(user)
    .all<{ provider: string; subject: string }>();
  const hashes = await Promise.all(
    linked.map(async (i) => (await identityHashes(ring, i.provider, i.subject))[0]!),
  );
  const results = await db.batch([
    db.prepare('DELETE FROM deleted_identities WHERE deleted_at <= ?').bind(now - holdOff),
    ...hashes.map((hash) =>
      db
        .prepare('INSERT OR REPLACE INTO deleted_identities (hash, deleted_at) VALUES (?, ?)')
        .bind(hash, now),
    ),
    db
      .prepare(
        'INSERT INTO bans_of_deleted_accounts (reason, created_by, created_at, expires_at, ' +
          'lifted_at, account_deleted_at) SELECT reason, created_by, created_at, expires_at, ' +
          'lifted_at, ? FROM bans WHERE user_id = ?',
      )
      .bind(now, user),
    db.prepare('DELETE FROM bans WHERE user_id = ?').bind(user),
    db.prepare('DELETE FROM reports WHERE reporter_id = ? OR target_id = ?').bind(user, user),
    // A team the account owns closes (its members may join another at once); its membership
    // goes. Cells it placed stay on the map and keep counting for the team (ADR 0020).
    ...teamsOnDeletion(db, user, now),
    db.prepare('DELETE FROM identities WHERE user_id = ?').bind(user),
    db.prepare('DELETE FROM users WHERE id = ?').bind(user),
    db
      .prepare('INSERT OR IGNORE INTO deleted_accounts (id, deleted_at) VALUES (?, ?)')
      .bind(user, now),
  ]);
  // The user row's DELETE is the second-to-last statement.
  return (results.at(-2)?.meta.changes ?? 0) > 0;
}
