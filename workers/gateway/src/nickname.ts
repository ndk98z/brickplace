// Nickname rules (ADR 0008, 0016): 3–20 characters, unique case-insensitively, checked
// against a word list kept in KV (never in this repo), renamed at most every 30 days.

export const NICKNAME_MIN = 3;
export const NICKNAME_MAX = 20;
export const RENAME_EVERY_MS = 30 * 24 * 60 * 60 * 1000;
/** KV key of the word list, in the MODERATION namespace managed from the private ops repo. */
export const WORD_LIST_KEY = 'nickname-words';
/** How long an isolate keeps the list before reading KV again. */
const WORD_LIST_TTL_MS = 5 * 60 * 1000;

/** ASCII letters, digits and underscore (owner decision, ADR 0016). */
const ALLOWED = /^[A-Za-z0-9_]+$/;

export type NicknameProblem =
  | 'too_short'
  | 'too_long'
  | 'characters'
  | 'blocked'
  | 'taken'
  | 'too_soon'
  | 'unavailable';

export type Checked =
  | { readonly ok: true; readonly nickname: string; readonly key: string }
  | { readonly ok: false; readonly problem: NicknameProblem };

/** Shape rules only; the word list and uniqueness come after. */
export function checkShape(raw: unknown): Checked {
  if (typeof raw !== 'string') return { ok: false, problem: 'characters' };
  const nickname = raw.trim();
  if (nickname.length < NICKNAME_MIN) return { ok: false, problem: 'too_short' };
  if (nickname.length > NICKNAME_MAX) return { ok: false, problem: 'too_long' };
  if (!ALLOWED.test(nickname)) return { ok: false, problem: 'characters' };
  return { ok: true, nickname, key: nicknameKey(nickname) };
}

/**
 * The placeholders a moderator's reset gives (`player_<n>`, `team_<n>`, ADR 0023), refused as
 * a player's choice for a nickname or a team name, so a reset never meets a taken name and
 * nobody passes for a reset account or team. Answered as `blocked`.
 */
const RESERVED = /^(player|team)_\d/i;

export function reservedName(name: string): boolean {
  return RESERVED.test(name);
}

/** The uniqueness key: case-insensitive. */
export function nicknameKey(nickname: string): string {
  return nickname.toLowerCase();
}

/**
 * The form names and list entries are compared in: lower case, common digit and symbol
 * stand-ins read as letters, separators dropped. So `B_4D_w0rd` meets the entry `badword`.
 */
export function foldForList(text: string): string {
  const map: Record<string, string> = {
    '0': 'o',
    '1': 'i',
    '3': 'e',
    '4': 'a',
    '5': 's',
    '7': 't',
    '8': 'b',
    '@': 'a',
    $: 's',
  };
  return text
    .toLowerCase()
    .replace(/[0134578@$]/g, (c) => map[c]!)
    .replace(/[^a-z]/g, '');
}

/**
 * Parses the word list: one entry per line, `#` starts a comment. An entry matches anywhere
 * in a folded name; an entry starting with `=` matches only the whole name (for words that
 * occur inside harmless ones).
 */
export function parseWordList(text: string): WordList {
  const anywhere: string[] = [];
  const whole = new Set<string>();
  for (const line of text.split('\n')) {
    const entry = line.replace(/#.*/, '').trim();
    if (!entry) continue;
    if (entry.startsWith('=')) {
      const folded = foldForList(entry.slice(1));
      if (folded) whole.add(folded);
    } else {
      const folded = foldForList(entry);
      if (folded) anywhere.push(folded);
    }
  }
  return { anywhere, whole };
}

export interface WordList {
  readonly anywhere: readonly string[];
  readonly whole: ReadonlySet<string>;
}

export function blocked(nickname: string, list: WordList): boolean {
  const folded = foldForList(nickname);
  return list.whole.has(folded) || list.anywhere.some((word) => folded.includes(word));
}

let cached: { list: WordList; at: number; kv: KVNamespace } | null = null;

/**
 * The word list from KV, cached per isolate for a few minutes. Null when it cannot be read
 * outside dev: nicknames then wait (fail closed) rather than skip the filter. Dev without a
 * list uses an empty one.
 */
export async function wordList(
  kv: KVNamespace | undefined,
  dev: boolean,
  now: number,
): Promise<WordList | null> {
  if (cached && kv === cached.kv && now - cached.at < WORD_LIST_TTL_MS) return cached.list;
  let text: string | null = null;
  try {
    text = kv ? await kv.get(WORD_LIST_KEY) : null;
  } catch (error) {
    console.error('nickname word list unreadable', error);
  }
  if (text === null) return dev ? { anywhere: [], whole: new Set() } : null;
  const list = parseWordList(text);
  if (kv) cached = { list, at: now, kv };
  return list;
}

/** Drops the cached list (tests change it between cases). */
export function forgetWordList(): void {
  cached = null;
}

/**
 * A starting suggestion from the provider's name: accents dropped, spaces and other
 * characters removed, cut to the maximum. The player edits it; it is checked on submit.
 */
export function suggestNickname(name: string | null): string {
  const plain = (name ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, NICKNAME_MAX);
  // A reserved placeholder would only be refused on submit.
  return plain.length >= NICKNAME_MIN && !reservedName(plain) ? plain : '';
}
