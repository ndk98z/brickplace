import { decodeServerMessage, type ServerMessage } from '@brickplace/protocol';
import type { Mirror } from './mirror.ts';
import {
  backoffMs,
  CLOSE,
  type Connect,
  connectionId,
  OVERLOADED_STEP,
  type Socket,
  STABLE_MS,
  secureRandom,
} from './socket.ts';

/**
 * A socket that only watches (no bot key, no player), keeping the shared Mirror current: the
 * whole grid on connect, then every live diff, in order, from one socket. The bots' own
 * sockets get frames too, but from several sockets they could arrive out of order, so the
 * bots aim with this copy only.
 */
export class Eye {
  private socket: Socket | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly client = connectionId(secureRandom);
  /**
   * The initial grid of the current socket, written at the mirror's current size until the
   * config frame that follows it says the map's size.
   */
  private incoming: { seq: number; cells: Uint8Array; shields: Uint8Array } | null = null;

  constructor(
    private readonly url: string,
    private readonly mirror: Mirror,
    private readonly connect: Connect,
    private readonly random: () => number,
    private readonly log: (line: string) => void = () => {},
  ) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.socket?.close(1000, 'done');
    this.socket = null;
  }

  private open(): void {
    const url = new URL(this.url);
    url.searchParams.set('client', this.client);
    const area = this.mirror.size * this.mirror.size;
    this.incoming = { seq: -1, cells: new Uint8Array(area), shields: new Uint8Array(area) };
    const socket = this.connect(
      url.toString(),
      {},
      {
        open: () => {
          if (this.socket !== socket) return;
          // The backoff starts over only once the socket stayed up (as the browser client).
          this.stableTimer = setTimeout(() => {
            this.stableTimer = null;
            this.attempt = 0;
          }, STABLE_MS);
        },
        message: (data) => {
          if (this.socket === socket) this.onFrame(data);
        },
        close: (code, reason) => {
          if (this.socket !== socket) return;
          this.socket = null;
          if (this.stableTimer) clearTimeout(this.stableTimer);
          this.stableTimer = null;
          if (this.stopped) return;
          this.log(`map socket closed (${code}${reason ? ` ${reason}` : ''}); reconnecting`);
          if (code === CLOSE.tryAgainLater) {
            this.attempt = Math.max(this.attempt, OVERLOADED_STEP);
          }
          this.timer = setTimeout(() => this.open(), backoffMs(this.attempt++, this.random));
        },
      },
    );
    this.socket = socket;
  }

  private onFrame(data: Uint8Array): void {
    let message: ServerMessage;
    try {
      message = decodeServerMessage(data);
    } catch {
      return; // A frame this build does not know: skip it, as older clients do.
    }
    const { mirror } = this;
    switch (message.type) {
      case 'diffs': {
        const incoming = this.incoming;
        // Every frame of the initial grid carries one seq; another seq means live frames.
        if (incoming && (incoming.seq < 0 || incoming.seq === message.seq)) {
          incoming.seq = message.seq;
          for (const { index, cell, shield } of message.diffs) {
            if (index >= incoming.cells.length) continue;
            incoming.cells[index] = cell;
            incoming.shields[index] = shield;
          }
          return;
        }
        this.finishGrid();
        mirror.applyDiffs(message.diffs);
        return;
      }
      case 'config': {
        const sized = message.mapSize === mirror.size;
        mirror.setConfig(message);
        if (sized) {
          this.finishGrid();
        } else {
          // Another map size (a new season's canvas): the copy is empty at the new size (and
          // a grid on its way was read at the old one), so read the whole map again.
          this.incoming = null;
          mirror.ready = false;
          this.log(`map size is now ${message.mapSize}²; reading the map again`);
          this.socket?.close(1000, 'map size changed');
          this.socket = null;
          this.open();
        }
        return;
      }
      case 'tile':
        mirror.applyTile(message);
        return;
      default:
    }
  }

  /** The socket's whole grid is in: it replaces the copy in one step. */
  private finishGrid(): void {
    const incoming = this.incoming;
    if (!incoming) return;
    this.incoming = null;
    if (incoming.cells.length !== this.mirror.size * this.mirror.size) return;
    this.mirror.replace(incoming.cells, incoming.shields);
    this.mirror.ready = true;
  }
}
