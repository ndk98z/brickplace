// Closing a player's open sockets at once (ADR 0023): FanoutDO.kick on the current season's
// canvas. A socket's token is checked only when it opens (ADR 0015), so without this a
// deleted account would keep playing until its token expired, up to an hour.

import type { Env } from './index.ts';
import { currentCanvas } from './seasons.ts';
import { fanoutName, MAX_FANOUT_SHARDS } from './socket.ts';

/**
 * Kicks `player` from the current canvas's fanout shards: its sockets close, and sockets
 * opened with a token issued before now watch instead of playing. Every shard there may be
 * (MAX_FANOUT_SHARDS, ADR 0028), not only the player's or the FANOUT_SHARDS now set: after the
 * count changes, older sockets stay on the shard they joined, and a later raise must not let
 * an old token play on a shard the kick missed. Kicks are rare; this is 64 calls. Best effort:
 * the account change it follows is already done, so a failure is logged and the token's
 * expiry remains the bound. True when every shard took it. `forget` (a deleted account) also
 * drops what each shard keeps of the account: a pending Turnstile challenge and its bot
 * signals (ADR 0026).
 */
export async function kickPlayer(
  env: Env,
  player: string,
  now: number,
  forget = false,
): Promise<boolean> {
  try {
    const canvas = await currentCanvas(env.ACCOUNTS, now);
    // Settled one by one: a shard that cannot be reached never keeps the others from kicking.
    const results = await Promise.allSettled(
      Array.from({ length: MAX_FANOUT_SHARDS }, (_, shard) =>
        env.FANOUT.get(env.FANOUT.idFromName(fanoutName(canvas, shard))).kick(player, forget),
      ),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.error(
        `kick failed on ${failed.length} shards; their sockets stop playing when their token expires`,
        (failed[0] as PromiseRejectedResult).reason,
      );
    }
    return failed.length === 0;
  } catch (error) {
    console.error('kick failed; open sockets stop playing when their token expires', error);
    return false;
  }
}
