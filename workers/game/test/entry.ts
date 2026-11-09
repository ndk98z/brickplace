// Test-only entry: CanvasDO as in production, plus a stand-in for the realtime script's
// FanoutDO (the FANOUT binding names that script, which these tests do not run). The stand-in
// records the diff ticks the canvas pushes and answers as a tests tells it to.
import { DurableObject } from 'cloudflare:workers';
import type { TickPush, TickReply } from '../src/push.ts';

export { CanvasDO, default } from '../src/index.ts';

export interface FanoutBehaviour {
  /** Open sockets to report; 0 makes the canvas forget the shard. */
  readonly sockets?: number;
  /** Throw on every push. */
  readonly fail?: boolean;
  /** Report this seq instead of the push's `to`. */
  readonly seq?: number;
}

export class FanoutDO extends DurableObject {
  private readonly pushes: TickPush[] = [];
  private behaviour: FanoutBehaviour = {};

  async tick(push: TickPush): Promise<TickReply> {
    if (this.behaviour.fail) throw new Error('shard unreachable');
    this.pushes.push(push);
    return { seq: this.behaviour.seq ?? push.to, sockets: this.behaviour.sockets ?? 1 };
  }

  async behave(behaviour: FanoutBehaviour): Promise<void> {
    this.behaviour = behaviour;
  }

  /** The pushes received so far, oldest first; `clear` forgets them. */
  async received(clear = false): Promise<TickPush[]> {
    const out = [...this.pushes];
    if (clear) this.pushes.length = 0;
    return out;
  }
}
