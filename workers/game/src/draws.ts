// Kept out of the Worker entry (index.ts): workerd accepts only handlers and Durable Object
// classes as exports of the main module.

/** The two uniform 32-bit words one item draw takes: [kind, shape] (see core drawItem). */
export type DrawWords = readonly [kind: number, shape: number];

/** Domain tag: a new message format gets a new tag, never a silent change. */
const TAG = new TextEncoder().encode('bp-draw-v1');
export const SALT_BYTES = 16;

/**
 * The keyed PRF behind every item draw (ADR 0012):
 *   HMAC-SHA-256(key, "bp-draw-v1" ‖ salt ‖ utf8(player) ‖ u32be(drawIndex)).
 * The salt is 16 random bytes made once per canvas and pinned in its stored config, so a new
 * season (a new canvas) never repeats an old season's words under the same key. Only the
 * player is variable-length, and the index has a fixed width after it, so the message splits
 * one way only. The first two big-endian u32 words of the digest are the kind and shape words.
 *
 * Clients cannot predict their next item without the key. Anyone holding the key can
 * recompute the words of any draw from the salt, the player and the index; the item they
 * gave also depends on the map when the draw was made (phase, holes, fitting shapes), which
 * is not logged, so checking an item also needs the op log replayed to that moment.
 */
export async function drawWords(
  key: CryptoKey,
  salt: Uint8Array,
  player: string,
  index: number,
): Promise<DrawWords> {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new RangeError(`draw index ${index} out of range`);
  }
  if (salt.length !== SALT_BYTES) throw new RangeError(`salt must be ${SALT_BYTES} bytes`);
  const name = new TextEncoder().encode(player);
  const message = new Uint8Array(TAG.length + SALT_BYTES + name.length + 4);
  message.set(TAG);
  message.set(salt, TAG.length);
  message.set(name, TAG.length + SALT_BYTES);
  new DataView(message.buffer).setUint32(message.length - 4, index, false);
  const digest = new DataView(await crypto.subtle.sign('HMAC', key, message));
  return [digest.getUint32(0, false), digest.getUint32(4, false)];
}

/** A fresh canvas salt, as hex for the stored config. */
export function newSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reads a salt written by newSalt; throws on anything else. */
export function parseSalt(hex: string): Uint8Array {
  if (typeof hex !== 'string' || !/^[0-9a-f]{32}$/.test(hex)) {
    throw new RangeError('drawSalt must be 32 lowercase hex digits');
  }
  return Uint8Array.from({ length: SALT_BYTES }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
}

/**
 * Imports the draw key from the ITEM_DRAW_KEY secret, or returns null when it is missing:
 * the canvas then draws nothing (fails closed) rather than fall back to a guessable key.
 */
export async function importDrawKey(secret: string | undefined): Promise<CryptoKey | null> {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}
