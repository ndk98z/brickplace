import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { fanoutName, PLAYER_HEADER, UNTIL_HEADER } from '@brickplace/realtime/player';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.ts';
import {
  activeBan,
  closeTeam,
  resetNickname,
  resetTeamName,
  unbanPlayer,
} from '../src/moderation.ts';
import { currentCanvas } from '../src/ports.ts';
import { call, claims, envIn, type FakeAccess, fakeAccess, grant, serveKeys } from './support.ts';

// Player moderation in the admin area (ADR 0023): the report queue, bans, resets, closing a
// team and kicking open sockets, on the gateway's accounts database.

const testEnv = env as unknown as Env;
const accounts = testEnv.ACCOUNTS;
const admin = testEnv.ADMIN_DB;
const OWNER = 'mod-owner@example.test';
const MOD = 'mod-moderator@example.test';
const DAY = 86_400_000;
let access: FakeAccess;
let count = 0;

beforeAll(async () => {
  access = await fakeAccess('moderation-key');
  await grant(OWNER, 'owner');
  await grant(MOD, 'moderator');
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function as(email: string, path: string, body?: unknown, extra: Partial<Env> = {}) {
  serveKeys(access.jwks);
  return call(envIn('staging', extra), path, {
    token: await access.sign(claims(email, Date.now())),
    body,
  });
}

/** A playing socket of `player` on the current canvas's fanout, with a token issued a while ago. */
async function openSocket(player: string, shard = 0): Promise<{ closed: Promise<number> }> {
  const canvas = await currentCanvas(testEnv, Date.now());
  const fanout = testEnv.FANOUT.get(testEnv.FANOUT.idFromName(fanoutName(canvas, shard)));
  const opened = await fanout.fetch('https://fanout/ws', {
    headers: {
      Upgrade: 'websocket',
      [PLAYER_HEADER]: player,
      [UNTIL_HEADER]: String(Date.now() + 20 * 60_000),
    },
  });
  expect(opened.status).toBe(101);
  const ws = opened.webSocket!;
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener('close', (event) => resolve(event.code));
  });
  ws.accept();
  // Wrapped: an async function returning the promise itself would wait for it.
  return { closed };
}

/**
 * The accounts database, with `sql` run just before each batch: another moderator's change
 * landing between an action's read and its write, so the statement's own guard decides.
 */
function racing(sql: string, ...values: unknown[]): D1Database {
  return new Proxy(accounts, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          await accounts
            .prepare(sql)
            .bind(...values)
            .run();
          return accounts.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A FANOUT binding whose fanout cannot be reached. */
const unreachableFanout = {
  idFromName: (name: string) => testEnv.FANOUT.idFromName(name),
  get: () => ({
    kick: async () => {
      throw new Error('fanout unreachable');
    },
  }),
} as unknown as Env['FANOUT'];

const errorOf = async (response: Response) =>
  ((await response.json()) as { error?: string; detail?: string }).error;

/** An account with a nickname, made `daysOld` days ago. */
async function player(prefix = 'Pl', daysOld = 3, email: string | null = null) {
  const id = crypto.randomUUID();
  const nickname = `${prefix}${Date.now() % 100_000}x${++count}`;
  const made = Date.now() - daysOld * DAY;
  await accounts
    .prepare(
      'INSERT INTO users (id, email, nickname, nickname_key, nickname_changed_at, created_at, ' +
        'signed_in_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, email ?? `${id}@players.test`, nickname, nickname.toLowerCase(), made, made, made)
    .run();
  return { id, nickname };
}

async function team(owner: string, members: readonly string[] = []) {
  const name = `Tm${Date.now() % 100_000}x${++count}`;
  const now = Date.now();
  const inserted = await accounts
    .prepare(
      'INSERT INTO teams (name, name_key, color, owner_id, created_at) VALUES (?, ?, 3, ?, ?)',
    )
    .bind(name, name.toLowerCase(), owner, now)
    .run();
  const id = Number(inserted.meta.last_row_id);
  for (const user of [owner, ...members]) {
    await accounts
      .prepare(
        'INSERT INTO team_players (user_id, team_id, joined_at, free_join) VALUES (?, ?, ?, 0)',
      )
      .bind(user, id, now)
      .run();
  }
  return { id, name };
}

async function report(
  reporter: string,
  target: { player: string; nickname: string } | { team: number; name: string },
  reason = 'offensive',
  at = Date.now(),
) {
  const isTeam = 'team' in target;
  await accounts
    .prepare(
      `INSERT INTO reports (reporter_id, ${isTeam ? 'target_team_id' : 'target_id'}, ` +
        'target_nickname, reason, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(
      reporter,
      isTeam ? target.team : target.player,
      isTeam ? target.name : target.nickname,
      isTeam ? 'team_name' : reason,
      at,
    )
    .run();
}

async function statuses(column: string, id: string | number) {
  const { results } = await accounts
    .prepare(`SELECT status FROM reports WHERE ${column} = ? ORDER BY id`)
    .bind(id)
    .all<{ status: string }>();
  return results.map((r) => r.status);
}

async function audits(target: string) {
  const { results } = await admin
    .prepare(
      'SELECT actor, action, outcome, reason, before, after FROM audit_log WHERE target = ? ORDER BY id',
    )
    .bind(target)
    .all<Record<string, string | null>>();
  return results;
}

interface QueueBody {
  entries: {
    kind: string;
    id: string | number;
    reports: number;
    reasons: string[];
    reported: string[];
    current: string | null;
    createdAt: number;
    lastAt: number;
    priorBans: number;
    banned: boolean;
    ownerId: string | null;
  }[];
}

describe('the report queue', () => {
  it('groups open reports by target, with what moderators need and nothing on reporters', async () => {
    const target = await player('Rude', 10);
    const reporters = [await player('R'), await player('R'), await player('R')];
    await report(reporters[0]!.id, { player: target.id, nickname: target.nickname }, 'offensive');
    await report(reporters[1]!.id, { player: target.id, nickname: target.nickname }, 'hateful');
    // A ban long gone still counts as a prior one.
    await accounts
      .prepare(
        "INSERT INTO bans (user_id, reason, created_by, created_at, expires_at) VALUES (?, 'spam', 'x', 1, 2)",
      )
      .bind(target.id)
      .run();
    const owner = await player('Own');
    const squad = await team(owner.id);
    await report(reporters[2]!.id, { team: squad.id, name: squad.name });

    const response = await as(MOD, '/api/moderation/reports');
    expect(response.status).toBe(200);
    const { entries } = (await response.json()) as QueueBody;
    const mine = entries.find((e) => e.id === target.id)!;
    expect(mine).toMatchObject({
      kind: 'player',
      reports: 2,
      reported: [target.nickname],
      current: target.nickname,
      priorBans: 1,
      banned: false,
    });
    expect(mine.reasons.sort()).toEqual(['hateful', 'offensive']);
    expect(Date.now() - mine.createdAt).toBeGreaterThanOrEqual(10 * DAY - 60_000);
    expect(JSON.stringify(entries)).not.toContain(reporters[0]!.id);
    expect(entries.find((e) => e.id === squad.id)).toMatchObject({
      kind: 'team',
      reports: 1,
      reasons: ['team_name'],
      current: squad.name,
      ownerId: owner.id,
    });
  });

  it('dismisses every open report on a target, audited before and after', async () => {
    const target = await player('Fine');
    await report((await player('R')).id, { player: target.id, nickname: target.nickname });
    await report((await player('R')).id, { player: target.id, nickname: target.nickname });
    const response = await as(MOD, '/api/moderation/reports/dismiss', {
      player: target.id,
      reason: 'a normal word in another language',
    });
    expect(await response.json()).toEqual({ dismissed: 2 });
    expect(await statuses('target_id', target.id)).toEqual(['dismissed', 'dismissed']);
    const rows = await audits(`player:${target.id}`);
    expect(rows.map((a) => a.outcome)).toEqual(['requested', 'ok']);
    // Without `upTo`, every open report: the row says so.
    expect(JSON.parse(rows[1]!.after!)).toEqual({ dismissed: 2, upTo: null });
    const again = await as(MOD, '/api/moderation/reports/dismiss', {
      player: target.id,
      reason: 'again',
    });
    expect(again.status).toBe(404);
    // A reason is required, and a target.
    expect((await as(MOD, '/api/moderation/reports/dismiss', { player: target.id })).status).toBe(
      400,
    );
    expect((await as(MOD, '/api/moderation/reports/dismiss', { reason: 'x' })).status).toBe(400);
  });
});

describe('a renewed report', () => {
  it('comes back after a dismissal, and a dismissal of what the queue showed leaves it open', async () => {
    const target = await player('Again');
    const on = { player: target.id, nickname: target.nickname };
    const first = await player('R');
    const second = await player('R');
    const t = Date.now() - 60_000;
    await report(first.id, on, 'offensive', t);
    await report(second.id, on, 'hateful', t + 1_000);
    expect(
      (
        await as(MOD, '/api/moderation/reports/dismiss', {
          player: target.id,
          reason: 'fine',
          upTo: t + 1_000,
        })
      ).status,
    ).toBe(200);
    // The first reporter renews: one open report again, and the queue shows it.
    await report(first.id, on, 'impersonation', t + 2_000);
    const queue = (await (await as(MOD, '/api/moderation/reports')).json()) as QueueBody;
    const shown = queue.entries.find((e) => e.id === target.id)!;
    expect(shown).toMatchObject({ reports: 1, reasons: ['impersonation'], lastAt: t + 2_000 });
    // Another renewal lands while the moderator still looks at that row.
    await report(second.id, on, 'offensive', t + 3_000);
    const dismissed = await as(MOD, '/api/moderation/reports/dismiss', {
      player: target.id,
      reason: 'still fine',
      upTo: shown.lastAt,
    });
    expect(await dismissed.json()).toEqual({ dismissed: 1 });
    // The one filed after the row was read stays open for a moderator to see.
    expect(await statuses('target_id', target.id)).toEqual([
      'dismissed',
      'dismissed',
      'dismissed',
      'open',
    ]);
    // The audit row says how far the dismissal reached.
    const rows = await audits(`player:${target.id}`);
    expect(JSON.parse(rows.at(-1)!.after!)).toEqual({ dismissed: 1, upTo: shown.lastAt });
    expect(JSON.parse(rows[1]!.after!)).toEqual({ dismissed: 2, upTo: t + 1_000 });
    expect(
      (
        await as(MOD, '/api/moderation/reports/dismiss', {
          player: target.id,
          reason: 'x',
          upTo: 'soon',
        })
      ).status,
    ).toBe(400);
  });
});

describe('bans', () => {
  it('bans with a reason and an expiry, closes the reports and kicks open sockets', async () => {
    const target = await player('Grief');
    await report((await player('R')).id, { player: target.id, nickname: target.nickname });
    // An open socket of the player, with a token issued a while ago.
    const canvas = await currentCanvas(testEnv, Date.now());
    const fanout = testEnv.FANOUT.get(testEnv.FANOUT.idFromName(fanoutName(canvas)));
    const opened = await fanout.fetch('https://fanout/ws', {
      headers: {
        Upgrade: 'websocket',
        [PLAYER_HEADER]: target.id,
        [UNTIL_HEADER]: String(Date.now() + 20 * 60_000),
      },
    });
    expect(opened.status).toBe(101);
    const ws = opened.webSocket!;
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (event) => resolve(event.code));
    });
    ws.accept();

    const expiresAt = Date.now() + 7 * DAY;
    const response = await as(MOD, `/api/moderation/players/${target.id}/ban`, {
      reason: 'griefing art repeatedly',
      expiresAt,
      closeReports: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kicked: true });
    expect(await closed).toBe(4403);
    const kicked = await runInDurableObject(fanout, (_, state) =>
      state.storage.kv.get<number>(`kick:${target.id}`),
    );
    expect(kicked).toBeGreaterThan(Date.now());
    const ban = await accounts
      .prepare('SELECT reason, created_by, expires_at, lifted_at FROM bans WHERE user_id = ?')
      .bind(target.id)
      .first();
    expect(ban).toEqual({
      reason: 'griefing art repeatedly',
      created_by: `access:sub-${MOD}`,
      expires_at: expiresAt,
      lifted_at: null,
    });
    expect(await statuses('target_id', target.id)).toEqual(['actioned']);
    const rows = await audits(`player:${target.id}`);
    expect(rows.map((r) => [r.action, r.outcome])).toEqual([
      ['player.ban', 'requested'],
      ['player.ban', 'ok'],
    ]);
    // Accounts by id only: neither the nickname nor the email reaches the append-only log.
    expect(JSON.stringify(rows)).not.toContain(target.nickname);
    expect(JSON.stringify(rows)).not.toContain('@players.test');

    // A ban that does not take closes no report, even when asked to.
    await report((await player('R')).id, { player: target.id, nickname: target.nickname });
    const again = await as(MOD, `/api/moderation/players/${target.id}/ban`, {
      reason: 'twice',
      closeReports: true,
    });
    expect(await errorOf(again)).toBe('already_banned');
    expect(await statuses('target_id', target.id)).toEqual(['actioned', 'open']);
  });

  it('refuses reasons with personal data, bad expiries and unknown accounts', async () => {
    const target = await player('Who');
    const ban = (body: Record<string, unknown>) =>
      as(MOD, `/api/moderation/players/${target.id}/ban`, body);
    for (const reason of [
      'contact me at someone@example.com',
      `the name ${target.nickname.toLowerCase()} is rude`,
      'phone 0912345678',
      'x'.repeat(201),
    ]) {
      expect((await ban({ reason })).status, reason).toBe(400);
    }
    for (const expiresAt of [Date.now() - 1, 'tomorrow', Date.now() + 6 * 365 * DAY]) {
      expect((await ban({ reason: 'spam', expiresAt })).status).toBe(400);
    }
    const missing = await as(MOD, `/api/moderation/players/${crypto.randomUUID()}/ban`, {
      reason: 'spam',
    });
    expect(missing.status).toBe(404);
    expect(await audits(`player:${target.id}`)).toEqual([]);
  });

  it('lets moderators lift a temporary ban, and only owners a permanent one', async () => {
    const temporary = await player('Tmp');
    await as(MOD, `/api/moderation/players/${temporary.id}/ban`, {
      reason: 'spam',
      expiresAt: Date.now() + DAY,
    });
    const lifted = await as(MOD, `/api/moderation/players/${temporary.id}/unban`, {
      reason: 'appeal accepted',
    });
    expect(await lifted.json()).toEqual({ lifted: 1 });

    const permanent = await player('Perm');
    await as(MOD, `/api/moderation/players/${permanent.id}/ban`, { reason: 'hate speech' });
    const refused = await as(MOD, `/api/moderation/players/${permanent.id}/unban`, {
      reason: 'appeal',
    });
    expect(refused.status).toBe(403);
    const refusal = await admin
      .prepare(
        "SELECT outcome FROM audit_log WHERE action = 'access.refused' AND actor = ? AND target = ?",
      )
      .bind(MOD, `POST /api/moderation/players/${permanent.id}/unban`)
      .first();
    expect(refusal).toEqual({ outcome: 'forbidden' });
    expect(
      (await as(OWNER, `/api/moderation/players/${permanent.id}/unban`, { reason: 'appeal' }))
        .status,
    ).toBe(200);
    expect(
      (await as(OWNER, `/api/moderation/players/${permanent.id}/unban`, { reason: 'appeal' }))
        .status,
    ).toBe(404);
  });
});

describe('resets', () => {
  it('resets a nickname to a placeholder the player must replace, and kicks', async () => {
    const target = await player('Bad');
    await report((await player('R')).id, { player: target.id, nickname: target.nickname });
    const response = await as(MOD, `/api/moderation/players/${target.id}/reset-nickname`, {
      reason: 'offensive nickname',
      closeReports: true,
    });
    expect(response.status).toBe(200);
    const { nickname } = (await response.json()) as { nickname: string };
    expect(nickname).toMatch(/^player_\d+$/);
    const row = await accounts
      .prepare(
        'SELECT nickname, nickname_key, nickname_reset_at, nickname_reset_key FROM users ' +
          'WHERE id = ?',
      )
      .bind(target.id)
      .first<{
        nickname: string;
        nickname_key: string;
        nickname_reset_at: number | null;
        nickname_reset_key: string;
      }>();
    // The removed name is kept so the player cannot choose it straight back (gateway).
    expect(row).toMatchObject({
      nickname,
      nickname_key: nickname,
      nickname_reset_key: target.nickname.toLowerCase(),
    });
    expect(row!.nickname_reset_at).toBeGreaterThan(0);
    expect(await statuses('target_id', target.id)).toEqual(['actioned']);
    const rows = await audits(`player:${target.id}`);
    expect(rows.map((r) => r.outcome)).toEqual(['requested', 'ok']);
    expect(JSON.stringify(rows)).not.toContain(target.nickname);
    // A reset that does not take closes no report, even when asked to.
    await report((await player('R')).id, { player: target.id, nickname: target.nickname });
    const again = await as(MOD, `/api/moderation/players/${target.id}/reset-nickname`, {
      reason: 'again',
      closeReports: true,
    });
    expect(await errorOf(again)).toBe('already_reset');
    expect(await statuses('target_id', target.id)).toEqual(['actioned', 'open']);
  });

  it('falls back to a suffixed placeholder when the plain one is taken', async () => {
    const target = await player('Clash');
    const squad = await team((await player('Own')).id);
    const { rowid } = (await accounts
      .prepare('SELECT rowid FROM users WHERE id = ?')
      .bind(target.id)
      .first<{ rowid: number }>())!;
    // Names chosen before the placeholders were reserved.
    const holder = await player('Hold');
    await accounts
      .prepare('UPDATE users SET nickname = ?1, nickname_key = ?1 WHERE id = ?2')
      .bind(`player_${rowid}`, holder.id)
      .run();
    await team(holder.id).then((t) =>
      accounts
        .prepare('UPDATE teams SET name = ?1, name_key = ?1 WHERE id = ?2')
        .bind(`team_${squad.id}`, t.id)
        .run(),
    );
    const reset = await as(MOD, `/api/moderation/players/${target.id}/reset-nickname`, {
      reason: 'offensive nickname',
    });
    expect(((await reset.json()) as { nickname: string }).nickname).toMatch(
      new RegExp(`^player_${rowid}_\\d{4}$`),
    );
    const renamed = await as(MOD, `/api/moderation/teams/${squad.id}/reset-name`, {
      reason: 'offensive team name',
    });
    expect(((await renamed.json()) as { name: string }).name).toMatch(
      new RegExp(`^team_${squad.id}_\\d{4}$`),
    );
  });

  it("resets a team's name and closes a team, members out, cells kept", async () => {
    const owner = await player('Own');
    const members = [await player('M'), await player('M')];
    const squad = await team(
      owner.id,
      members.map((m) => m.id),
    );
    await report(members[0]!.id, { team: squad.id, name: squad.name });
    const reset = await as(MOD, `/api/moderation/teams/${squad.id}/reset-name`, {
      reason: 'offensive team name',
      closeReports: true,
    });
    expect(await reset.json()).toEqual({ name: `team_${squad.id}` });
    expect(await statuses('target_team_id', squad.id)).toEqual(['actioned']);
    const closing = await as(MOD, `/api/moderation/teams/${squad.id}/close`, {
      reason: 'owner gone for good',
    });
    expect(await closing.json()).toEqual({ name: `team_${squad.id}`, members: 3 });
    const row = await accounts
      .prepare('SELECT owner_id, closed_at FROM teams WHERE id = ?')
      .bind(squad.id)
      .first<{ owner_id: string | null; closed_at: number | null }>();
    expect(row!.owner_id).toBeNull();
    expect(row!.closed_at).toBeGreaterThan(0);
    const { results } = await accounts
      .prepare('SELECT user_id, team_id, free_join FROM team_players WHERE user_id IN (?, ?, ?)')
      .bind(owner.id, members[0]!.id, members[1]!.id)
      .all<{ user_id: string; team_id: number | null; free_join: number }>();
    const byUser = new Map(results.map((r) => [r.user_id, r]));
    expect(byUser.get(owner.id)).toMatchObject({ team_id: null, free_join: 0 });
    expect(byUser.get(members[0]!.id)).toMatchObject({ team_id: null, free_join: 1 });
    // A close that does not take closes no report, even when asked to.
    await report(members[1]!.id, { team: squad.id, name: squad.name });
    expect(
      (
        await as(MOD, `/api/moderation/teams/${squad.id}/close`, {
          reason: 'again',
          closeReports: true,
        })
      ).status,
    ).toBe(409);
    expect(await statuses('target_team_id', squad.id)).toEqual(['actioned', 'open']);
    // Nor does a name reset of a closed team.
    expect(
      (
        await as(MOD, `/api/moderation/teams/${squad.id}/reset-name`, {
          reason: 'again',
          closeReports: true,
        })
      ).status,
    ).toBe(409);
    expect(await statuses('target_team_id', squad.id)).toEqual(['actioned', 'open']);
    expect((await audits(`team:${squad.id}`)).map((a) => `${a.action} ${a.outcome}`)).toEqual([
      'team.reset_name requested',
      'team.reset_name ok',
      'team.close requested',
      'team.close ok',
      'team.close requested',
      'team.close closed',
      'team.reset_name requested',
      'team.reset_name closed',
    ]);
  });

  it('closes a team and resets its name in one go', async () => {
    const owner = await player('Own');
    const squad = await team(owner.id);
    const closing = await as(MOD, `/api/moderation/teams/${squad.id}/close`, {
      reason: 'offensive name',
      resetName: true,
    });
    expect(await closing.json()).toEqual({ name: `team_${squad.id}`, members: 1 });
  });
});

describe('no acting on yourself', () => {
  it('refuses any action on an account that has the admin email, and records the attempt', async () => {
    // The provider's address in another letter case, on a linked identity only.
    const self = await player('Me');
    await accounts
      .prepare(
        "INSERT INTO identities (provider, subject, user_id, email, created_at, signed_in_at) VALUES ('discord', ?, ?, ?, 0, 0)",
      )
      .bind(self.id, self.id, MOD.toUpperCase())
      .run();
    const squad = await team(self.id);
    await report((await player('R')).id, { player: self.id, nickname: self.nickname });
    await report((await player('R')).id, { team: squad.id, name: squad.name });
    for (const [path, body] of [
      [`/api/moderation/players/${self.id}/ban`, { reason: 'x' }],
      [`/api/moderation/players/${self.id}/reset-nickname`, { reason: 'x' }],
      [`/api/moderation/teams/${squad.id}/reset-name`, { reason: 'x' }],
      [`/api/moderation/teams/${squad.id}/close`, { reason: 'x' }],
      ['/api/moderation/reports/dismiss', { player: self.id, reason: 'x' }],
      ['/api/moderation/reports/dismiss', { team: squad.id, reason: 'x' }],
    ] as const) {
      const response = await as(MOD, path, body);
      expect(response.status, path).toBe(409);
      expect(await errorOf(response)).toBe('self');
    }
    expect(await statuses('target_id', self.id)).toEqual(['open']);
    expect(await statuses('target_team_id', squad.id)).toEqual(['open']);
    // Not even lifting a ban another admin placed.
    expect(
      (await as(OWNER, `/api/moderation/players/${self.id}/ban`, { reason: 'spam' })).status,
    ).toBe(200);
    const unban = await as(MOD, `/api/moderation/players/${self.id}/unban`, { reason: 'x' });
    expect(await errorOf(unban)).toBe('self');
    expect(
      (await audits(`player:${self.id}`)).filter((a) => a.actor === MOD).map((a) => a.outcome),
    ).toEqual(['self', 'self', 'self', 'self']);
    expect((await audits(`team:${squad.id}`)).map((a) => a.outcome)).toEqual([
      'self',
      'self',
      'self',
    ]);
    // Another admin may.
    expect(
      (await as(OWNER, `/api/moderation/players/${self.id}/reset-nickname`, { reason: 'x' }))
        .status,
    ).toBe(200);
  });

  it('looks players and teams up by nickname, team name or id', async () => {
    const target = await player('Look');
    const squad = await team(target.id);
    const byName = await as(MOD, `/api/moderation/players?q=${target.nickname.toLowerCase()}`);
    const { players } = (await byName.json()) as { players: { id: string; team: unknown }[] };
    expect(players.map((p) => p.id)).toEqual([target.id]);
    expect(players[0]!.team).toEqual({ id: squad.id, name: squad.name, owner: true });
    const byId = await as(MOD, `/api/moderation/players/${target.id}`);
    expect(byId.status).toBe(200);
    const teams = await as(MOD, `/api/moderation/teams?q=${squad.id}`);
    expect(((await teams.json()) as { teams: { name: string }[] }).teams[0]!.name).toBe(squad.name);
    expect((await as(MOD, '/api/moderation/players?q=%27%3B')).status).toBe(200);
  });

  it("recognises the admin by the account's own email, the common case", async () => {
    const self = await player('Mine', 3, MOD);
    const response = await as(MOD, `/api/moderation/players/${self.id}/ban`, { reason: 'spam' });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('self');
    expect(await activeBan(accounts, self.id, Date.now())).toBeNull();
  });
});

describe('guards', () => {
  it('keeps names, addresses and numbers out of every reason', async () => {
    const target = await player('Named');
    await report((await player('R')).id, { player: target.id, nickname: target.nickname });
    const owner = await player('Boss');
    const squad = await team(owner.id);
    const quoting = `the name ${target.nickname} is rude`;
    for (const [path, body] of [
      [`/api/moderation/players/${target.id}/reset-nickname`, { reason: quoting }],
      ['/api/moderation/reports/dismiss', { player: target.id, reason: quoting }],
      [`/api/moderation/teams/${squad.id}/reset-name`, { reason: `${squad.name} is rude` }],
      [`/api/moderation/teams/${squad.id}/close`, { reason: `${owner.nickname} left` }],
      [`/api/moderation/teams/${squad.id}/close`, { reason: 'mail me at a@b.example' }],
    ] as const) {
      const response = await as(MOD, path, body);
      expect(response.status, `${path} ${body.reason}`).toBe(400);
    }
    // After a reset, the removed name is still the player's: an unban may not quote it.
    expect(
      (
        await as(MOD, `/api/moderation/players/${target.id}/reset-nickname`, {
          reason: 'sexual word',
        })
      ).status,
    ).toBe(200);
    await as(MOD, `/api/moderation/players/${target.id}/ban`, {
      reason: 'evading a ban',
      expiresAt: Date.now() + DAY,
    });
    const unban = await as(MOD, `/api/moderation/players/${target.id}/unban`, {
      reason: `was ${target.nickname.toUpperCase()}, appeal accepted`,
    });
    expect(unban.status).toBe(400);
    expect(await activeBan(accounts, target.id, Date.now())).not.toBeNull();
    expect(JSON.stringify(await audits(`player:${target.id}`))).not.toContain(
      target.nickname.toLowerCase(),
    );
  });

  it('says so when open sockets could not be closed, and keeps the change', async () => {
    const target = await player('NoKick');
    const response = await as(
      MOD,
      `/api/moderation/players/${target.id}/reset-nickname`,
      { reason: 'sexual word' },
      { FANOUT: unreachableFanout },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kicked: false });
    expect((await audits(`player:${target.id}`)).map((a) => a.outcome)).toEqual([
      'requested',
      'ok_not_kicked',
    ]);
  });

  it('kicks open sockets on a nickname reset', async () => {
    const target = await player('Kick');
    const { closed } = await openSocket(target.id);
    const response = await as(MOD, `/api/moderation/players/${target.id}/reset-nickname`, {
      reason: 'sexual word',
    });
    expect(await response.json()).toMatchObject({ kicked: true });
    expect(await closed).toBe(4403);
  });

  it('kicks sockets on every shard there may be (ADR 0028)', async () => {
    const target = await player('KickAll');
    // Shard 63: the last one FANOUT_SHARDS can name, from when it was set that high.
    const { closed } = await openSocket(target.id, 63);
    const response = await as(MOD, `/api/moderation/players/${target.id}/reset-nickname`, {
      reason: 'sexual word',
    });
    expect(await response.json()).toMatchObject({ kicked: true });
    expect(await closed).toBe(4403);
  });

  it('lifts no permanent ban for a moderator, even past the route check', async () => {
    const target = await player('Perm');
    await as(OWNER, `/api/moderation/players/${target.id}/ban`, { reason: 'hate speech' });
    expect(await unbanPlayer(accounts, target.id, false, Date.now())).toEqual({
      ok: false,
      reason: 'owner_only',
    });
    expect(await activeBan(accounts, target.id, Date.now())).toEqual({
      permanent: true,
      expiresAt: null,
    });
  });

  it('closes no report when a racing change wins inside the statement', async () => {
    const target = await player('Race');
    await report((await player('R')).id, { player: target.id, nickname: target.nickname });
    const now = Date.now();
    const reset = await resetNickname(
      racing('UPDATE users SET nickname_reset_at = 1 WHERE id = ?', target.id),
      target.id,
      true,
      now,
    );
    expect(reset).toEqual({ ok: false, reason: 'already_reset' });
    expect(await statuses('target_id', target.id)).toEqual(['open']);

    const owner = await player('Own');
    const squad = await team(owner.id);
    await report((await player('R')).id, { team: squad.id, name: squad.name });
    const renamed = await resetTeamName(
      racing('UPDATE teams SET name_reset_at = 1 WHERE id = ?', squad.id),
      squad.id,
      true,
      now,
    );
    expect(renamed).toEqual({ ok: false, reason: 'already_reset' });
    const closed = await closeTeam(
      racing('UPDATE teams SET closed_at = 1, owner_id = NULL WHERE id = ?', squad.id),
      squad.id,
      { resetName: false, closeReports: true },
      now,
    );
    expect(closed).toEqual({ ok: false, reason: 'closed' });
    expect(await statuses('target_team_id', squad.id)).toEqual(['open']);
  });
});

describe('bot signals over fanout shards (ADR 0028)', () => {
  /** FANOUT with the shards named in `down` unreachable, the others real. */
  function partlyDown(down: readonly string[]): Env['FANOUT'] {
    return {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: (id: { name: string }) => {
        if (down.includes(id.name)) {
          const fail = async () => {
            throw new Error('shard unreachable');
          };
          return { suspects: fail, kick: fail };
        }
        return testEnv.FANOUT.get(testEnv.FANOUT.idFromName(id.name));
      },
    } as unknown as Env['FANOUT'];
  }

  it('lists challenges held on any shard, challenged accounts first, and says when partial', async () => {
    const suspect = await player('Sus3');
    const canvas = await currentCanvas(testEnv, Date.now());
    const since = Date.now() - 60_000;
    // Held by shard 3 (the account plays there), not shard 0.
    const fanout = testEnv.FANOUT.get(testEnv.FANOUT.idFromName(fanoutName(canvas, 3)));
    await runInDurableObject(fanout, (instance: unknown, state) => {
      state.storage.kv.put(`challenge:${suspect.id}`, since);
      (instance as { challenges: unknown }).challenges = null;
    });
    const all = await as(MOD, '/api/moderation/signals');
    const listed = (await all.json()) as {
      players: { player: string; challengedAt?: number }[];
      partial: boolean;
    };
    expect(listed.partial).toBe(false);
    expect(listed.players.find((p) => p.player === suspect.id)?.challengedAt).toBe(since);
    expect(listed.players[0]?.challengedAt).toBeDefined();
    // One shard unreachable: the others' lists, said to be partial.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const partial = await as(MOD, '/api/moderation/signals', undefined, {
      FANOUT: partlyDown([fanoutName(canvas, 5)]),
    });
    expect(partial.status).toBe(200);
    const body = (await partial.json()) as { players: { player: string }[]; partial: boolean };
    expect(body.partial).toBe(true);
    expect(body.players.map((p) => p.player)).toContain(suspect.id);
  });

  it('kicks on every other shard when one cannot be reached, and says it failed', async () => {
    const target = await player('KickSome');
    const canvas = await currentCanvas(testEnv, Date.now());
    const { closed } = await openSocket(target.id, 9);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await as(
      MOD,
      `/api/moderation/players/${target.id}/reset-nickname`,
      { reason: 'sexual word' },
      { FANOUT: partlyDown([fanoutName(canvas, 2)]) },
    );
    expect(await response.json()).toMatchObject({ kicked: false });
    expect(await closed).toBe(4403);
  });
});

describe('bot signals (ADR 0026)', () => {
  it('lists the accounts the fanout holds for a Turnstile, read only, to moderators', async () => {
    const suspect = await player('Sus');
    const canvas = await currentCanvas(testEnv, Date.now());
    const fanout = testEnv.FANOUT.get(testEnv.FANOUT.idFromName(fanoutName(canvas)));
    const since = Date.now() - 60_000;
    await runInDurableObject(fanout, (instance: unknown, state) => {
      state.storage.kv.put(`challenge:${suspect.id}`, since);
      // The object may have read its challenges before this test: start it over.
      (instance as { challenges: unknown }).challenges = null;
    });
    const response = await as(MOD, '/api/moderation/signals');
    expect(response.status).toBe(200);
    const { players } = (await response.json()) as { players: { player: string }[] };
    expect(players).toContainEqual({
      player: suspect.id,
      score: 0,
      offView: 0,
      noView: 0,
      onCooldown: 0,
      passed: 0,
      challengedAt: since,
    });
    // Unreachable: says so rather than showing an empty list.
    const down = {
      idFromName: (name: string) => testEnv.FANOUT.idFromName(name),
      get: () => ({
        suspects: async () => {
          throw new Error('fanout unreachable');
        },
      }),
    } as unknown as Env['FANOUT'];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await as(MOD, '/api/moderation/signals', undefined, { FANOUT: down });
    expect(failed.status).toBe(503);
    expect(await errorOf(failed)).toBe('unavailable');
  });
});
