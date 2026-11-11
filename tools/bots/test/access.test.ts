import { describe, expect, it } from 'vitest';
import { accessHeaders, connectWith, fetchJsonWith } from '../src/access.ts';
import type { Connect, SocketEvents } from '../src/socket.ts';

const events: SocketEvents = { open() {}, message() {}, close() {} };

describe('Access service token', () => {
  it('sends nothing without the variables and both headers with them', () => {
    expect(accessHeaders({})).toEqual({});
    expect(accessHeaders({ CF_ACCESS_CLIENT_ID: ' ', CF_ACCESS_CLIENT_SECRET: '' })).toEqual({});
    expect(
      accessHeaders({ CF_ACCESS_CLIENT_ID: 'id.access', CF_ACCESS_CLIENT_SECRET: 'secret\n' }),
    ).toEqual({ 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': 'secret' });
  });

  it('refuses half a token', () => {
    expect(() => accessHeaders({ CF_ACCESS_CLIENT_ID: 'id.access' })).toThrow(/both/);
    expect(() => accessHeaders({ CF_ACCESS_CLIENT_SECRET: 'secret' })).toThrow(/both/);
  });

  it('adds the token to every socket and keeps the bot key', () => {
    const seen: Record<string, string>[] = [];
    const inner: Connect = (_url, headers) => {
      seen.push(headers);
      return { send() {}, close() {} };
    };
    const token = { 'CF-Access-Client-Id': 'i', 'CF-Access-Client-Secret': 's' };
    expect(connectWith(inner, {})).toBe(inner);
    const connect = connectWith(inner, token);
    connect('wss://x/ws', {}, events);
    connect('wss://x/ws', { Authorization: 'Bearer k' }, events);
    expect(seen).toEqual([token, { ...token, Authorization: 'Bearer k' }]);
  });

  it('fetches /api/me with the token and treats Access redirects as failures', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fake = (status: number, body: unknown) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push([String(url), init]);
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    const token = { 'CF-Access-Client-Id': 'i', 'CF-Access-Client-Secret': 's' };
    await expect(fetchJsonWith(token, fake(200, { ok: 1 }))('https://x/api/me')).resolves.toEqual({
      ok: 1,
    });
    expect(calls[0]).toEqual(['https://x/api/me', { headers: token, redirect: 'manual' }]);
    await expect(fetchJsonWith(token, fake(302, {}))('https://x/api/me')).rejects.toThrow(
      'HTTP 302',
    );
  });
});
