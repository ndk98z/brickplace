/** The little of a WebSocket the bots use, so tests can drive them without a server. */
export interface Socket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface SocketEvents {
  open(): void;
  message(data: Uint8Array): void;
  /** Code 1006 when the connection failed or dropped (a refused upgrade looks the same). */
  close(code: number, reason: string): void;
}

export type Connect = (
  url: string,
  headers: Record<string, string>,
  events: SocketEvents,
) => Socket;

/**
 * Node's built-in WebSocket (undici). It takes headers in place of protocols, which the bot key
 * needs, and sends no Origin header, so the gateway's cross-site check lets it through.
 */
export const nodeConnect: Connect = (url, headers, events) => {
  // The headers form is undici's, not the DOM's, so it is not in the types.
  const init = { headers } as unknown as string[];
  const ws = new WebSocket(url, init);
  ws.binaryType = 'arraybuffer';
  let closed = false;
  const close = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    events.close(code, reason);
  };
  ws.onopen = () => events.open();
  ws.onmessage = (event) => {
    if (!closed && event.data instanceof ArrayBuffer) events.message(new Uint8Array(event.data));
  };
  ws.onclose = (event) => close(event.code, event.reason);
  // A connection that fails (the server down, mid-restart) fires `error` and, on Node 22, no
  // `close`: without this the bot would wait for good instead of backing off and trying again.
  ws.onerror = () => {
    close(1006, '');
    try {
      ws.close();
    } catch {
      // Closed already.
    }
  };
  return {
    send(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close(code, reason) {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close(code, reason);
      }
    },
  };
};

/** A socket up this long counts as stable: the backoff starts over (the browser client's). */
export const STABLE_MS = 5000;

/** Uniform in [0, 1) from the system's generator: for ids a rerun must not repeat. */
export function secureRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296;
}

/**
 * The browser client's reconnect backoff (s): the first retry spread over 1 to 5 s, so a server
 * restart does not bring everyone back in the same second (ADR 0040), later steps times 0.5 to
 * 1.5, so bots that failed together do not retry together.
 */
const BACKOFF_S = [1, 2, 4, 8, 15];
const FIRST_RETRY_SPREAD = 5;
/** The step a close with CLOSE.tryAgainLater jumps to, as the client: 8 s. */
export const OVERLOADED_STEP = 3;

export function backoffMs(attempt: number, random: () => number): number {
  const step = BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)]!;
  const factor = attempt === 0 ? 1 + (FIRST_RETRY_SPREAD - 1) * random() : 0.5 + random();
  return Math.round(step * 1000 * factor);
}

/** A connection id (`?client=`, ADR 0017): 22 URL-safe characters, kept across reconnects. */
export function connectionId(random: () => number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-';
  let id = '';
  for (let i = 0; i < 22; i++) id += alphabet[Math.floor(random() * alphabet.length)];
  return id;
}

/** Close codes FanoutDO uses, as in @brickplace/realtime/player (a test checks they agree). */
export const CLOSE = {
  /** The session (for a bot: its hour) is over: reconnect. */
  expired: 4401,
  /** Kicked by a moderator: reconnect, and the socket watches if the kick still holds. */
  kicked: 4403,
  /** Another socket now plays as this player: someone else runs this bot number. */
  playingElsewhere: 4409,
  /** The account must pass a Turnstile first: a bot cannot, so its number is out (ADR 0034). */
  challenge: 4428,
  /** The grid fell out of date: reconnect for a fresh one. */
  resync: 1012,
  /** Try Again Later, from Cloudflare for an overloaded object: back off from 8 s. */
  tryAgainLater: 1013,
} as const;
