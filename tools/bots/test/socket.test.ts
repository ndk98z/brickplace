import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeConnect } from '../src/socket.ts';

/** Stands in for Node's WebSocket: the test fires its events. */
class StubSocket {
  static last: StubSocket | null = null;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = StubSocket.CONNECTING;
  binaryType = 'blob';
  closes = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly init: unknown,
  ) {
    StubSocket.last = this;
  }

  send(): void {}

  close(): void {
    this.closes++;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function connect() {
  vi.stubGlobal('WebSocket', StubSocket);
  const closes: number[] = [];
  nodeConnect(
    'ws://localhost:8787/ws',
    {},
    {
      open: () => {},
      message: () => {},
      close: (code) => closes.push(code),
    },
  );
  return { socket: StubSocket.last!, closes };
}

describe('the Node socket', () => {
  it('reports a failed connection as a close, which Node 22 fires only as an error', () => {
    const { socket, closes } = connect();
    socket.onerror!();
    expect(closes).toEqual([1006]);
    expect(socket.closes).toBe(1);
  });

  it('reports one close when the error comes with a close event', () => {
    const { socket, closes } = connect();
    socket.onerror!();
    socket.onclose!({ code: 1006, reason: '' });
    expect(closes).toEqual([1006]);
    const other = connect();
    other.socket.onclose!({ code: 4401, reason: 'session expired' });
    other.socket.onerror!();
    expect(other.closes).toEqual([4401]);
  });
});
