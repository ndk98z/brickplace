// Account trust score in the session token (ADR 0026). The weights here are made up for the
// tests; the real ones live in KV.
import { env } from 'cloudflare:workers';
import { TRUST_HEADER } from '@brickplace/realtime/player';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index.ts';
import { forgetWordList, WORD_LIST_KEY } from '../src/nickname.ts';
import * as socket from '../src/socket.ts';
import { keyRing, unseal } from '../src/token.ts';
import {
  forgetWeights,
  parseWeights,
  scoreOf,
  TRUST_WEIGHTS_KEY,
  type TrustWeights,
} from '../src/trust.ts';
import { attachmentsAfter, Browser, devSignIn, envIn } from './support.ts';

const testEnv = env as unknown as Env;
const db = testEnv.ACCOUNTS;
const DAY = 24 * 60 * 60 * 1000;
let count = 0;

const WEIGHTS: TrustWeights = {
  base: 10,
  perDay: 1,
  maxAgeDays: 30,
  email: 5,
  perIdentity: 3,
  perOpenReport: -2,
  perActionedReport: -4,
  perBan: -6,
};

const FACTS = {
  ageMs: 0,
  email: false,
  identities: 1,
  openReports: 0,
  actionedReports: 0,
  bans: 0,
};

beforeEach(async () => {
  forgetWordList();
  forgetWeights();
  await testEnv.MODERATION.put(WORD_LIST_KEY, '# test list\nbadword\n');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await testEnv.MODERATION.delete(TRUST_WEIGHTS_KEY);
  forgetWeights();
});

async function sessionOf(browser: Browser) {
  const ring = (await keyRing(testEnv.SESSION_KEYS))!;
  return (await unseal<{ u: string; r?: number }>(
    ring,
    'session',
    browser.cookies.get('__Host-bp_session'),
  ))!;
}

/** Signs in a fresh account through the dev provider; its nickname is chosen by `name()`. */
async function signedIn() {
  const browser = new Browser(envIn('dev'));
  await devSignIn(browser, `trust-${Date.now()}-${++count}`);
  const { csrf } = await browser.me();
  const name = () =>
    browser.postJson(
      '/api/nickname',
      { nickname: `Trust${Date.now() % 1_000_000}x${++count}` },
      { 'X-CSRF-Token': csrf! },
    );
  return { browser, name, id: (await sessionOf(browser)).u };
}

describe('trust weights', () => {
  it('reads every weight, and refuses a missing, extra-large or non-numeric one', () => {
    expect(parseWeights(JSON.stringify(WEIGHTS))).toEqual(WEIGHTS);
    expect(parseWeights(null)).toBeNull();
    expect(parseWeights('nope')).toBeNull();
    expect(parseWeights('[]')).toBeNull();
    const { perBan: _gone, ...missing } = WEIGHTS;
    expect(parseWeights(JSON.stringify(missing))).toBeNull();
    expect(parseWeights(JSON.stringify({ ...WEIGHTS, base: '10' }))).toBeNull();
    // Open reports weigh nothing unless the owner says so (sybil reports, ADR 0026).
    const { perOpenReport: _open, ...noOpen } = WEIGHTS;
    expect(parseWeights(JSON.stringify(noOpen))).toEqual({ ...WEIGHTS, perOpenReport: 0 });
    expect(parseWeights(JSON.stringify({ ...WEIGHTS, perOpenReport: 'x' }))).toBeNull();
    expect(parseWeights(JSON.stringify({ ...WEIGHTS, perDay: 1e6 }))).toBeNull();
    expect(parseWeights(JSON.stringify({ ...WEIGHTS, maxAgeDays: 1.5 }))).toBeNull();
  });

  it('adds the facts up, counts whole days up to the cap, and keeps within 0..100', () => {
    expect(scoreOf(WEIGHTS, FACTS)).toBe(10);
    expect(scoreOf(WEIGHTS, { ...FACTS, ageMs: 2.9 * DAY, email: true, identities: 3 })).toBe(
      10 + 2 + 5 + 6,
    );
    expect(scoreOf(WEIGHTS, { ...FACTS, ageMs: 400 * DAY })).toBe(40);
    expect(scoreOf(WEIGHTS, { ...FACTS, openReports: 1, actionedReports: 1, bans: 1 })).toBe(0);
    expect(scoreOf({ ...WEIGHTS, base: 500 }, FACTS)).toBe(100);
  });
});

describe('the trust score in the session token', () => {
  it('is read with each token, passed to the socket, and drops with reports and bans', async () => {
    await testEnv.MODERATION.put(TRUST_WEIGHTS_KEY, JSON.stringify(WEIGHTS));
    const account = await signedIn();
    // A new account: base and its verified email.
    expect((await sessionOf(account.browser)).r).toBe(15);
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          "INSERT INTO reports (reporter_id, target_id, target_nickname, reason, created_at, status) VALUES (?, ?, 'x', 'offensive', ?, 'actioned')",
        )
        .bind(account.id, account.id, now),
      db
        .prepare(
          "INSERT INTO reports (reporter_id, target_id, target_nickname, reason, created_at, status) VALUES (?, ?, 'y', 'hateful', ?, 'open')",
        )
        .bind(account.id, account.id, now),
      db
        .prepare(
          "INSERT INTO bans (user_id, reason, created_by, created_at, lifted_at) VALUES (?, 'spam', 'test', ?, ?)",
        )
        .bind(account.id, now - 1000, now - 500),
    ]);
    // Choosing a nickname issues a new token, with the score read afresh.
    expect((await account.name()).status).toBe(200);
    expect((await sessionOf(account.browser)).r).toBe(15 - 4 - 2 - 6);
    const client = `trust-sock-${count}`;
    const opened = await account.browser.get(`/ws?client=${client}`, { Upgrade: 'websocket' });
    const attached = (await attachmentsAfter(opened)).find((a) => a.client === client);
    expect(attached).toMatchObject({ player: account.id, trust: 3 });
  });

  it('is left out without weights, and the socket carries none', async () => {
    const account = await signedIn();
    // After the sign-in, which restores every mock; a cached miss would not log again.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    forgetWeights();
    expect((await account.name()).status).toBe(200);
    expect(await sessionOf(account.browser)).not.toHaveProperty('r');
    expect(errors).toHaveBeenCalledWith(
      `${TRUST_WEIGHTS_KEY} is not set: tokens carry no trust score`,
    );
    const client = `trust-none-${count}`;
    const opened = await account.browser.get(`/ws?client=${client}`, { Upgrade: 'websocket' });
    const attached = (await attachmentsAfter(opened)).find((a) => a.client === client);
    expect(attached).toMatchObject({ player: account.id });
    expect(attached).not.toHaveProperty('trust');
  });

  it('uses the header name FanoutDO reads, and drops one the client sends', async () => {
    expect(socket.TRUST_HEADER).toBe(TRUST_HEADER);
    const sent = socket.withIdentity(
      new Request('https://brickplace.test/ws', { headers: { [TRUST_HEADER]: '100' } }),
      { player: 'p', client: 'c-12345678' },
      'canvas',
    );
    expect(sent.headers.get(TRUST_HEADER)).toBeNull();
  });
});
