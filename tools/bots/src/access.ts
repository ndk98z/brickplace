// Staging sits behind Cloudflare Access (ADR 0045, amended 2026-11-11): only invited testers and
// one service token get through. Bots present the token on every request to the game's host,
// the sockets and /api/me alike; the CDN host stays public and gets no token.
import type { FetchJson } from './driver.ts';
import type { Connect } from './socket.ts';

/** The environment variables that hold an Access service token. */
export const ACCESS_ENV = {
  id: 'CF_ACCESS_CLIENT_ID',
  secret: 'CF_ACCESS_CLIENT_SECRET',
} as const;

/**
 * The service-token headers from the environment: none when neither variable is set, both
 * when both are. Throws when only one is set, since a run would then fail at Access's login
 * page with nothing to say why.
 */
export function accessHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const id = env[ACCESS_ENV.id]?.trim();
  const secret = env[ACCESS_ENV.secret]?.trim();
  if (!id && !secret) return {};
  if (!id || !secret) {
    throw new Error(`set both ${ACCESS_ENV.id} and ${ACCESS_ENV.secret}, or neither`);
  }
  return { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret };
}

/** A Connect that adds `extra` to every socket's headers (a bot's own headers win). */
export function connectWith(connect: Connect, extra: Record<string, string>): Connect {
  if (Object.keys(extra).length === 0) return connect;
  return (url, headers, events) => connect(url, { ...extra, ...headers }, events);
}

/** A FetchJson that sends `headers` and reads the JSON body; throws on a status other than 2xx. */
export function fetchJsonWith(
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): FetchJson {
  return async (url) => {
    // Access answers a request without a valid token with a redirect to its login page: follow
    // nothing, so that shows up as an error and not as HTML parsed as JSON.
    const response = await fetchImpl(url, { headers, redirect: 'manual' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
}
