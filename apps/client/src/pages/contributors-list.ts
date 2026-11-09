// The contributors page's list, kept by hand: add yourself in your first pull request.
// Order is the order shown. `roles` takes any of the four below; `url` is optional (https).

export type Role = 'code' | 'art' | 'translation' | 'moderation';

export interface Contributor {
  readonly name: string;
  readonly roles: readonly Role[];
  readonly url?: string;
}

export const ROLE_NAMES: Record<Role, string> = {
  code: 'Code',
  art: 'Art',
  translation: 'Translation',
  moderation: 'Moderation',
};

export const CONTRIBUTORS: readonly Contributor[] = [
  { name: 'Khanh (ndk98z)', roles: ['code'], url: 'https://github.com/ndk98z' },
];
