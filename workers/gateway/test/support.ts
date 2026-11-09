// Helpers shared by the gateway tests: an env per ENVIRONMENT, a cookie jar, fetch mocks.
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import worker, { type Env } from '../src/index.ts';

/**
 * The test Worker's env with this ENVIRONMENT. Provider settings are cleared so no local
 * .dev.vars can turn a provider on; tests that need one pass it in `extra`.
 */
export function envIn(environment: Env['ENVIRONMENT'], extra: Partial<Env> = {}): Env {
  return {
    ...(env as unknown as Env),
    ENVIRONMENT: environment,
    PUBLIC_ORIGIN: environment === 'dev' ? undefined : 'https://brickplace.test',
    GOOGLE_CLIENT_ID: undefined,
    GOOGLE_CLIENT_SECRET: undefined,
    REDDIT_CLIENT_ID: undefined,
    REDDIT_CLIENT_SECRET: undefined,
    DISCORD_CLIENT_ID: undefined,
    DISCORD_CLIENT_SECRET: undefined,
    ...extra,
  };
}

export const ORIGIN = 'https://brickplace.test';

/** A browser's cookies for the test origin, kept across requests. */
export class Browser {
  readonly cookies = new Map<string, string>();

  constructor(private readonly environment: Env) {}

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const jar = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (jar) headers.set('Cookie', jar);
    const url = path.startsWith('http') ? path : `${ORIGIN}${path}`;
    const request = new Request(url, { ...init, headers, redirect: 'manual' });
    const response = await worker.fetch(
      request as Parameters<typeof worker.fetch>[0],
      this.environment,
    );
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const gone = attributes.some((a) => a.trim().toLowerCase() === 'max-age=0');
      if (gone) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  get(path: string, headers: Record<string, string> = {}) {
    return this.fetch(path, { headers });
  }

  postForm(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
    return this.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  }

  postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
    return this.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  async me(): Promise<MeBody> {
    const response = await this.get('/api/me');
    return (await response.json()) as MeBody;
  }
}

export interface MeBody {
  signedIn: boolean;
  csrf: string | null;
  sessionExpiresIn: number | null;
  user: {
    nickname: string | null;
    suggestedNickname: string;
    nicknameChangeableAt: number | null;
    email: string | null;
    linkUntil: number;
    identities: { provider: string; name: string | null }[];
  } | null;
  config: {
    providers: string[];
    turnstileSiteKey: string | null;
    devGuest: boolean;
    tilesUrl: string | null;
    playerCap: number | null;
  };
}

/**
 * Answers outbound fetches (providers, Turnstile) by URL prefix; anything else fails the
 * test. Returns the calls made, for assertions. Restored by vi.restoreAllMocks().
 */
export function mockOutbound(
  routes: Record<string, (request: Request) => Response | Promise<Response>>,
): Request[] {
  const calls: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    calls.push(request.clone());
    for (const [prefix, answer] of Object.entries(routes)) {
      if (request.url.startsWith(prefix)) return answer(request);
    }
    throw new Error(`unexpected outbound fetch ${request.url}`);
  });
  return calls;
}

export const TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** A siteverify answer for a token solved on our site's sign-in widget. */
export const turnstileSays = (success: boolean) => () =>
  Response.json({ success, hostname: 'brickplace.test', action: 'signin' });

/** Signs in through the dev provider as `subject`, with Turnstile passing. */
export async function devSignIn(browser: Browser, subject: string, name = 'Alice Example') {
  mockOutbound({ [TURNSTILE]: turnstileSays(true) });
  const started = await browser.postForm('/auth/dev/start', { turnstile: 'token' });
  vi.restoreAllMocks();
  const authorize = new URL(started.headers.get('Location')!);
  const issued = await browser.postForm(authorize.pathname, {
    ...Object.fromEntries(authorize.searchParams),
    subject,
    name,
    email: `${subject}@example.test`,
  });
  const back = new URL(issued.headers.get('Location')!);
  return browser.get(`${back.pathname}${back.search}`);
}

/** The players FanoutDO attached to its open sockets; closes the new one afterwards. */
export async function attachmentsAfter(
  response: Response,
): Promise<{ player?: string; client?: string }[]> {
  if (response.status !== 101) throw new Error(`expected 101, got ${response.status}`);
  const ws = response.webSocket!;
  ws.accept();
  const fanoutEnv = env as unknown as Env;
  const fanout = fanoutEnv.FANOUT.get(fanoutEnv.FANOUT.idFromName('fanout-0'));
  // Identity fields only: FanoutDO adds the hold's (nextAt, revision) once the socket's first
  // hold is out, which may or may not have happened yet, so they would make results racy.
  const attachments = await runInDurableObject(fanout, (_, state) =>
    state.getWebSockets().map((s) => {
      const {
        nextAt: _nextAt,
        revision: _revision,
        ...identity
      } = s.deserializeAttachment() as {
        player?: string;
        client?: string;
        nextAt?: unknown;
        revision?: unknown;
      };
      return identity;
    }),
  );
  ws.close();
  return attachments;
}
