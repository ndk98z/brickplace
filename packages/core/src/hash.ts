import type { State } from './state.ts';

/**
 * 32-bit FNV-1a over cells then shields, as 8 lowercase hex digits.
 * Language-neutral on purpose: golden fixtures pin this value so any port of the core
 * (for example to Rust) must reproduce it bit for bit.
 */
export function gridHash(state: State): string {
  let h = 0x811c9dc5;
  for (const bytes of [state.cells, state.shields]) {
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i]!;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0');
}
