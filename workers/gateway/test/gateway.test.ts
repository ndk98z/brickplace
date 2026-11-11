import { env, exports } from 'cloudflare:workers';
import {
  ADDRESS_HEADER,
  CLIENT_HEADER,
  NETWORK_HEADER,
  PLAYER_HEADER,
  TEAM_HEADER,
  UNTIL_HEADER,
  WATCH_HEADER,
} from '@brickplace/realtime/player';
import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index.ts';
import { SESSION_TTL_MS } from '../src/session.ts';
import * as socket from '../src/socket.ts';
import { keyRing, seal } from '../src/token.ts';
import { attachmentsAfter, envIn } from './support.ts';

// Runtime types are generated without the env, so the main module's exports are untyped.
const gateway = (exports as unknown as { default: Fetcher }).default;
const upgrade = { Upgrade: 'websocket' };

// Every case states its ENVIRONMENT, so no local .dev.vars can change the result. The test
// Worker's own binding is the value committed in wrangler.jsonc (see vitest.config.ts).
function fetchIn(
  environment: Env['ENVIRONMENT'],
  path: string,
  headers: Record<string, string> = upgrade,
) {
  const request = new Request(`https://brickplace.test${path}`, { headers });
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], envIn(environment));
}

const devFetch = (path: string, headers?: Record<string, string>) => fetchIn('dev', path, headers);

/** What FanoutDO attached to the socket opened with this connection id. */
async function socketFor(response: Response, client: string) {
  const attachments = await attachmentsAfter(response);
  return attachments.find((a) => a.client === client);
}

describe('gateway', () => {
  it('answers health checks', async () => {
    const response = await gateway.fetch('https://brickplace.test/healthz');
    expect(await response.text()).toBe('ok');
  });

  it('refuses plain HTTP on /ws', async () => {
    const response = await gateway.fetch('https://brickplace.test/ws');
    expect(response.status).toBe(426);
  });

  it('uses the header names FanoutDO reads', () => {
    expect(socket.PLAYER_HEADER).toBe(PLAYER_HEADER);
    expect(socket.CLIENT_HEADER).toBe(CLIENT_HEADER);
    expect(socket.WATCH_HEADER).toBe(WATCH_HEADER);
    expect(socket.UNTIL_HEADER).toBe(UNTIL_HEADER);
    expect(socket.TEAM_HEADER).toBe(TEAM_HEADER);
    expect(socket.ADDRESS_HEADER).toBe(ADDRESS_HEADER);
    expect(socket.NETWORK_HEADER).toBe(NETWORK_HEADER);
  });

  it('keys addresses by IPv4 address and IPv6 /64, and nothing else (ADR 0026)', () => {
    expect(socket.addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(socket.addressKey('2001:DB8:0:42:1:2:3:4')).toBe('2001:db8:0:42::/64');
    expect(socket.addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(socket.addressKey('2001:0db8:00a0::')).toBe('2001:db8:a0:0::/64');
    expect(socket.addressKey('::1')).toBe('0:0:0:0::/64');
    for (const bad of [null, '', 'localhost', '1:2:3', '1::2::3', '1:2:3:4:5:6:7:8:9', '12345::']) {
      expect(socket.addressKey(bad), String(bad)).toBeNull();
      expect(socket.networkKey(bad), String(bad)).toBeNull();
    }
    // The wider IPv6 key: the /48, never one for IPv4.
    expect(socket.networkKey('2001:DB8:0:42:1:2:3:4')).toBe('2001:db8:0::/48');
    expect(socket.networkKey('2001:db8:7::1')).toBe('2001:db8:7::/48');
    expect(socket.networkKey('203.0.113.7')).toBeNull();
  });

  it('passes the address key from the edge, never one the client sends', () => {
    const request = new Request('https://brickplace.test/ws', {
      headers: { 'CF-Connecting-IP': '2001:db8:1:2:3:4:5:6', [ADDRESS_HEADER]: 'forged' },
    });
    const sent = socket.withIdentity(request, { watch: true, client: 'c-12345678' }, 'canvas');
    expect(sent.headers.get(ADDRESS_HEADER)).toBe('2001:db8:1:2::/64');
    expect(sent.headers.get(NETWORK_HEADER)).toBe('2001:db8:1::/48');
    const v4 = socket.withIdentity(
      new Request('https://brickplace.test/ws', {
        headers: { 'CF-Connecting-IP': '203.0.113.7', [NETWORK_HEADER]: 'forged' },
      }),
      { watch: true, client: 'c-12345678' },
      'canvas',
    );
    expect(v4.headers.get(NETWORK_HEADER)).toBeNull();
    const without = socket.withIdentity(
      new Request('https://brickplace.test/ws', { headers: { [ADDRESS_HEADER]: 'forged' } }),
      { watch: true, client: 'c-12345678' },
      'canvas',
    );
    expect(without.headers.get(ADDRESS_HEADER)).toBeNull();
  });

  it('drops a session expiry or a team the client sends itself', async () => {
    const response = await devFetch('/ws?player=page-until-01&client=conn-until-01', {
      ...upgrade,
      [UNTIL_HEADER]: String(Date.now() + 10 ** 9),
      [TEAM_HEADER]: '7',
    });
    // A dev guest has no session, so no expiry and no team at all. Matched, not equal: the
    // first hold may already have added its own fields to the socket.
    const attached = await socketFor(response, 'conn-until-01');
    expect(attached).toMatchObject({ player: 'dev-page-until-01', client: 'conn-until-01' });
    expect(attached).not.toHaveProperty('until');
    expect(attached).not.toHaveProperty('team');
  });

  it('keeps /ws, /api and /auth closed when locked (a deploy without --env)', async () => {
    expect((await fetchIn('locked', '/ws?player=abcdefgh')).status).toBe(501);
    expect((await fetchIn('locked', '/api/me', {})).status).toBe(501);
    expect((await fetchIn('locked', '/auth/dev/start', {})).status).toBe(501);
    // And as committed: the test Worker runs with wrangler.jsonc's own ENVIRONMENT.
    const deployed = await gateway.fetch('https://brickplace.test/ws?player=abcdefgh', {
      headers: upgrade,
    });
    expect(deployed.status).toBe(501);
  });

  it('commits no environment as dev, at the top level or in any env block', () => {
    const committed = (env as unknown as { COMMITTED_ENVIRONMENTS: Record<string, string> })
      .COMMITTED_ENVIRONMENTS;
    expect(Object.keys(committed)).toEqual(expect.arrayContaining(['', 'staging', 'production']));
    for (const [name, value] of Object.entries(committed)) {
      expect(value, name || 'top level').not.toBe('dev');
    }
    expect(committed['']).toBe('locked');
  });

  it('requires, in every env block, the secrets that environment uses', () => {
    type Committed = { required: string[] | null; vars: Record<string, unknown> };
    const committed = (env as unknown as { COMMITTED_SECRETS: Record<string, Committed> })
      .COMMITTED_SECRETS;
    // At the top level a `secrets` block would also drop unlisted .dev.vars keys in local dev.
    expect(committed['']?.required).toBeNull();
    for (const [name, { required, vars }] of Object.entries(committed)) {
      if (name === '') continue;
      // Without them no session is issued and no account is created (both fail closed).
      expect(required, name).toEqual(
        expect.arrayContaining(['SESSION_KEYS', 'TURNSTILE_SECRET_KEY']),
      );
      // An OAuth secret is required exactly when its client id turns the provider on.
      for (const provider of ['GOOGLE', 'REDDIT', 'DISCORD']) {
        const enabled = Boolean(vars[`${provider}_CLIENT_ID`]);
        expect(required?.includes(`${provider}_CLIENT_SECRET`), `${name} ${provider}`).toBe(
          enabled,
        );
      }
    }
  });

  it('outside dev, a socket without a session only watches, whatever it claims', async () => {
    for (const environment of ['staging', 'production'] as const) {
      const client = `claims-${environment}`;
      const response = await fetchIn(environment, `/ws?player=abcdefgh&client=${client}`, {
        ...upgrade,
        [PLAYER_HEADER]: 'someone-else',
      });
      expect(await socketFor(response, client), environment).toEqual({ client });
    }
  });

  it('outside dev, refuses a socket opened from another site', async () => {
    const response = await fetchIn('production', '/ws', {
      ...upgrade,
      Origin: 'https://evil.test',
    });
    expect(response.status).toBe(403);
  });

  it('in dev, plays as the per-page id and ignores identity headers from the client', async () => {
    const response = await devFetch('/ws?player=page-1234abcd&client=conn-1234abcd', {
      ...upgrade,
      [PLAYER_HEADER]: 'someone-else',
      [CLIENT_HEADER]: 'forged-client',
    });
    // Matched, not equal: the first hold may already have added its own fields to the socket.
    const attached = await socketFor(response, 'conn-1234abcd');
    expect(attached).toMatchObject({ player: 'dev-page-1234abcd', client: 'conn-1234abcd' });
    expect(attached).not.toHaveProperty('until');
    expect(attached).not.toHaveProperty('team');
  });

  it('gives a socket without a connection id a fresh one', async () => {
    const response = await devFetch('/ws?player=page-fresh-01');
    const attachments = await attachmentsAfter(response);
    const mine = attachments.find((a) => a.player === 'dev-page-fresh-01');
    expect(mine?.client).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('in dev, a socket without an id or a session watches', async () => {
    const response = await devFetch('/ws?client=watch-only-01');
    expect(await socketFor(response, 'watch-only-01')).toEqual({ client: 'watch-only-01' });
  });

  it('refuses malformed ids', async () => {
    expect((await devFetch('/ws?player=short')).status).toBe(400);
    expect((await devFetch('/ws?player=has%20space%20inside')).status).toBe(400);
    expect((await devFetch('/ws?client=bad')).status).toBe(400);
  });
});

describe('committed hosts (ADR 0045)', () => {
  it('serves PUBLIC_ORIGIN on a custom domain, and staging on nothing else', () => {
    type Committed = {
      runWorkerFirst: string[] | boolean | null;
      workersDev: boolean | null;
      previewUrls: boolean | null;
      routes: string[];
      customDomains: string[];
    };
    const committed = (env as unknown as { COMMITTED_ROUTES: Record<string, Committed> })
      .COMMITTED_ROUTES;
    const secrets = (
      env as unknown as { COMMITTED_SECRETS: Record<string, { vars: Record<string, unknown> }> }
    ).COMMITTED_SECRETS;
    for (const [name, routes] of Object.entries(committed)) {
      const where = name || 'top level';
      // Socket, health check, API and sign-in reach the Worker; pages are plain assets.
      expect(routes.runWorkerFirst, where).toEqual(['/ws', '/healthz', '/api/*', '/auth/*']);
      const origin = secrets[name]?.vars.PUBLIC_ORIGIN;
      if (typeof origin !== 'string' || origin === '') continue;
      const host = new URL(origin).host;
      // PUBLIC_ORIGIN is a host this Worker serves: its custom domain or its workers.dev address.
      if (host.endsWith('.workers.dev')) expect(routes.workersDev, where).not.toBe(false);
      else expect(routes.customDomains, where).toContain(host);
    }
    // Staging and production are reached on their custom domains only, so every request passes
    // the zone's WAF rules (ADR 0045, amended). Written out, not left to wrangler's defaults.
    for (const [name, host] of [
      ['staging', 'staging.brickplace.app'],
      ['production', 'brickplace.app'],
    ] as const) {
      expect(committed[name]?.routes, name).toEqual([host]);
      expect(committed[name]?.customDomains, name).toEqual([host]);
      expect(committed[name]?.workersDev, name).toBe(false);
      expect(committed[name]?.previewUrls, name).toBe(false);
    }
  });
});

describe('staging bots (ADR 0034)', () => {
  const KEY = 'bot-key-for-tests-0123456789abcdef';
  const keyed = { ...upgrade, Authorization: `Bearer ${KEY}` };
  const botFetch = (
    environment: Env['ENVIRONMENT'],
    path: string,
    headers: Record<string, string> = keyed,
    key: string | null = KEY,
  ) => {
    const request = new Request(`https://brickplace.test${path}`, { headers });
    return worker.fetch(
      request as Parameters<typeof worker.fetch>[0],
      envIn(environment, { BOT_KEY: key ?? undefined }),
    );
  };

  it('on staging, the bot key and ?bot= play as bot-<n> for an hour, with no team or trust', async () => {
    const before = Date.now();
    const response = await botFetch('staging', '/ws?bot=17&client=bot-conn-0017', {
      ...keyed,
      [PLAYER_HEADER]: 'someone-else',
      [UNTIL_HEADER]: String(before + 10 ** 9),
    });
    const attached = (await socketFor(response, 'bot-conn-0017')) as { until?: number };
    expect(attached).toMatchObject({ player: 'bot-17', client: 'bot-conn-0017' });
    // A session token's lifetime from the gateway, never what the client sent.
    expect(attached.until).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
    expect(attached.until).toBeLessThan(before + 10 ** 9);
    expect(attached).not.toHaveProperty('team');
    expect(attached).not.toHaveProperty('trust');
  });

  it('plays as the account when a session comes with a bot request', async () => {
    const ring = (await keyRing((env as unknown as Env).SESSION_KEYS))!;
    const now = Date.now();
    const token = await seal(ring, 'session', {
      u: 'account-with-bot-key',
      s: 'session-nonce',
      a: now,
      i: now,
      e: now + SESSION_TTL_MS,
      n: 1,
    });
    const response = await botFetch('staging', '/ws?bot=1&client=bot-and-session', {
      ...keyed,
      Cookie: `__Host-bp_session=${token}`,
    });
    const attached = await socketFor(response, 'bot-and-session');
    expect(attached).toMatchObject({ player: 'account-with-bot-key', client: 'bot-and-session' });
  });

  it('only watches without the right key, a long enough key, or outside staging', async () => {
    const cases: [string, Env['ENVIRONMENT'], Record<string, string>, string | null][] = [
      ['wrong key', 'staging', { ...upgrade, Authorization: `Bearer ${KEY}x` }, KEY],
      ['no header', 'staging', upgrade, KEY],
      ['not a bearer', 'staging', { ...upgrade, Authorization: KEY }, KEY],
      ['no key set', 'staging', keyed, null],
      ['key too short', 'staging', { ...upgrade, Authorization: 'Bearer short-key' }, 'short-key'],
      ['production', 'production', keyed, KEY],
    ];
    for (const [name, environment, headers, key] of cases) {
      const client = `bot-watch-${name.replaceAll(' ', '-')}`;
      const response = await botFetch(environment, `/ws?bot=1&client=${client}`, headers, key);
      expect(await socketFor(response, client), name).toEqual({ client });
    }
    // The key in the URL opens nothing either.
    const inQuery = await botFetch(
      'staging',
      `/ws?bot=1&key=${KEY}&client=bot-key-in-url`,
      upgrade,
    );
    expect(await socketFor(inQuery, 'bot-key-in-url')).toEqual({ client: 'bot-key-in-url' });
    // Dev keeps its own ids and ignores the key; locked stays closed.
    const dev = await botFetch('dev', '/ws?bot=1&client=bot-in-dev-01');
    expect(await socketFor(dev, 'bot-in-dev-01')).toEqual({ client: 'bot-in-dev-01' });
    expect((await botFetch('locked', '/ws?bot=1')).status).toBe(501);
  });

  it('refuses a malformed bot number only with the right key', async () => {
    // Leading zeros too: one number is one player.
    for (const bot of ['', 'abc', '1234567', '-1', '1.5', '01', '007']) {
      expect((await botFetch('staging', `/ws?bot=${bot}`)).status, bot).toBe(400);
    }
    const unkeyed = await botFetch('staging', '/ws?bot=abc&client=bot-bad-unkeyed', upgrade);
    expect(await socketFor(unkeyed, 'bot-bad-unkeyed')).toEqual({ client: 'bot-bad-unkeyed' });
  });

  it('sends FanoutDO no address key and no bot key for a bot', () => {
    const request = new Request('https://brickplace.test/ws', {
      headers: {
        'CF-Connecting-IP': '2001:db8:1:2:3:4:5:6',
        Authorization: `Bearer ${KEY}`,
        [ADDRESS_HEADER]: 'forged',
        [NETWORK_HEADER]: 'forged',
      },
    });
    const sent = socket.withIdentity(
      request,
      { player: 'bot-3', client: 'bot-conn-0003', bot: true },
      'canvas',
    );
    expect(sent.headers.get(PLAYER_HEADER)).toBe('bot-3');
    expect(sent.headers.get(ADDRESS_HEADER)).toBeNull();
    expect(sent.headers.get(NETWORK_HEADER)).toBeNull();
    expect(sent.headers.get('Authorization')).toBeNull();
    // A player who is not a bot keeps the address key.
    const player = socket.withIdentity(request, { player: 'p-1', client: 'conn-p-0001' }, 'canvas');
    expect(player.headers.get(ADDRESS_HEADER)).toBe('2001:db8:1:2::/64');
    expect(player.headers.get('Authorization')).toBeNull();
  });
});
