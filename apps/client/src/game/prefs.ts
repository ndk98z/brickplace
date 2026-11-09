import { Observable } from '../ui/observable.ts';
import type { FlagStore } from './screens.ts';
import {
  defaultPrefs,
  localStore,
  type MotionSetting,
  PREFS_KEY,
  type PrefKey,
  type Prefs,
  readChoices,
  systemMotion,
} from './stored-prefs.ts';

export type { PrefKey, Prefs } from './stored-prefs.ts';

// The player's display and sound preferences (Profile design), kept in this browser's
// localStorage only, like the screens' flags: nothing goes to the server. Only the choices a
// player made are stored, so "reduce motion" follows the system setting, changes included,
// until it is switched.

export class Preferences {
  readonly state: Observable<Prefs>;
  private choices: Partial<Prefs>;

  constructor(
    private readonly store: FlagStore | null = localStore(),
    motion: MotionSetting = systemMotion(),
  ) {
    this.choices = readChoices(store);
    this.state = new Observable<Prefs>({ ...defaultPrefs(motion.reduce), ...this.choices });
    motion.watch((reduce) => {
      if (this.choices.reduceMotion === undefined) this.state.update({ reduceMotion: reduce });
    });
  }

  set(key: PrefKey, value: boolean): void {
    this.choices = { ...this.choices, [key]: value };
    this.state.update({ [key]: value });
    try {
      this.store?.setItem(PREFS_KEY, JSON.stringify(this.choices));
    } catch {
      // Full or blocked: the choice holds until the page reloads.
    }
  }
}
