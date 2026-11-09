import {
  type ClientMessage,
  decodeClientMessage,
  encodeServerMessage,
  type ServerMessage,
} from '@brickplace/protocol';
import type { Connect, Socket, SocketEvents } from '../src/socket.ts';

/** One socket a test opened through FakeServer: what the client sent, and a way to answer. */
export class FakeSocket implements Socket {
  readonly sent: ClientMessage[] = [];
  closed: { code?: number; reason?: string } | null = null;

  constructor(
    readonly url: URL,
    readonly headers: Record<string, string>,
    private readonly events: SocketEvents,
  ) {}

  send(data: Uint8Array): void {
    this.sent.push(decodeClientMessage(data));
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  open(): void {
    this.events.open();
  }

  push(message: ServerMessage): void {
    this.events.message(encodeServerMessage(message));
  }

  /** The server closes the socket. */
  drop(code: number, reason = ''): void {
    this.events.close(code, reason);
  }
}

/** Records every socket the code under test opens. */
export class FakeServer {
  readonly sockets: FakeSocket[] = [];

  readonly connect: Connect = (url, headers, events) => {
    const socket = new FakeSocket(new URL(url), headers, events);
    this.sockets.push(socket);
    return socket;
  };

  get last(): FakeSocket {
    return this.sockets.at(-1)!;
  }
}
