import { checkGrowth, checkItemConfig, type ItemConfig, type OpenGrowth } from '@brickplace/core';

// Admin config versions with an effective time (ADR 0022). Kept out of the Worker entry
// (index.ts): workerd accepts only handlers and Durable Object classes as exports there.
//
// Only settings that never replay live here: what the inventory hands out and how fast
// (`items`), and when the open area grows by itself (`growth`). Neither is read by a replay:
// holds are their own table, and a growth is logged as an `open` row (ADR 0013), so changing
// these rules cannot change history. Core rules that a replay reads (shield lifetime, the
// shield cap, the map) are pinned in the checkpoint and need a logged op first (ADR 0014).

export const CONFIG_SCOPES = ['items', 'growth'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

/** One version of one scope's settings, in force from `effectiveAt` (ms, the canvas clock). */
export type ConfigVersion =
  | {
      readonly scope: 'items';
      readonly version: number;
      readonly effectiveAt: number;
      readonly config: ItemConfig;
    }
  | {
      readonly scope: 'growth';
      readonly version: number;
      readonly effectiveAt: number;
      readonly config: OpenGrowth;
    };

/** A stored version, with whether it was cancelled before it took effect. */
export type ScheduledVersion = ConfigVersion & { readonly cancelled: boolean };

/** Named apart from the season's ScheduleResult (season.ts, ADR 0021). */
export type ConfigScheduleResult =
  | { readonly ok: true; readonly version: ScheduledVersion; readonly duplicate?: true }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'stale' | 'conflict' | 'cancelled' | 'too_many';
      readonly detail?: string;
    };

export type CancelResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_found' | 'already_effective' | 'cancelled' };

/** What admins see: the settings in force now, and every version the canvas has. */
export interface ConfigState {
  readonly at: number;
  readonly items: ItemConfig;
  readonly growth: OpenGrowth;
  /** Version in force per scope, and the highest version known (the next one is one more). */
  readonly current: Readonly<Record<ConfigScope, number>>;
  readonly latest: Readonly<Record<ConfigScope, number>>;
  /** Newest first. */
  readonly versions: readonly ScheduledVersion[];
  /** Stored versions that could not be read (`scope@version`): damage an operator must fix. */
  readonly unreadable: readonly string[];
}

/** One item config and the time it took over (-Infinity for the stored config). */
export interface ItemSegment {
  readonly config: ItemConfig;
  readonly since: number;
}

/**
 * Versions waiting to take effect, per canvas: a bound against a runaway client, not a
 * tuning knob (a season has a handful of changes).
 */
export const MAX_PENDING = 100;
/** The version the stored canvas config counts as, for scopes that carry none (growth). */
const BASE_GROWTH_VERSION = 1;

type Row = {
  scope: string;
  version: number;
  effective_at: number;
  json: string;
  cancelled: number;
};

/** Creates the schedule table. New in ADR 0022, so no upgrade. */
export function createConfigTable(sql: SqlStorage): void {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS config_schedule (scope TEXT NOT NULL, version INTEGER NOT NULL, ' +
      'effective_at INTEGER NOT NULL, json TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0, ' +
      'PRIMARY KEY (scope, version))',
  );
}

/**
 * The canvas's config versions: the stored config is version 1 of each scope (items carry
 * their own number), and each admin version takes over at its effective time. The version in
 * force at `at` is the one with the latest effective time not after `at`. An effective time in
 * the past becomes the time the canvas stores it, so a new version never claims a moment that
 * already happened under another one; a version can be cancelled only before it takes effect.
 *
 * A hold lives through each item version in turn when it is next looked at (inventory.ts,
 * `advance`): a full hold starts counting at the new version's time, so a larger hold gives
 * no burst, and a cooldown under way keeps the share it had run and runs the rest at the new
 * length from the version's time.
 */
export class ConfigSchedule {
  private rows: ScheduledVersion[];

  constructor(
    private readonly sql: SqlStorage,
    private readonly base: { readonly items: ItemConfig; readonly growth: OpenGrowth },
    private readonly save: (body: () => void) => void,
  ) {
    this.rows = sql
      .exec<Row>('SELECT * FROM config_schedule ORDER BY effective_at, version')
      .toArray()
      .flatMap((row) => {
        const parsed = parseRow(row);
        if (!parsed) {
          // Every version was checked before it was stored, so this is a damaged row. The
          // canvas keeps playing without it (refusing to start would stop the whole game),
          // says so on every start, and admins see it in configState().unreadable.
          console.error(
            `CanvasDO: CONFIG VERSION UNREADABLE, ignored: ${row.scope}@${row.version}`,
            row.json,
          );
          this.unreadable.push(`${row.scope}@${row.version}`);
          if (row.scope === 'items' || row.scope === 'growth') {
            this.unreadableLatest[row.scope] = Math.max(
              this.unreadableLatest[row.scope],
              row.version,
            );
          }
        }
        return parsed ? [parsed] : [];
      });
  }

  /**
   * When the next item config takes effect after `now` (ms), or null when none is scheduled:
   * the drop rates the manifest shows change then (ADR 0033).
   */
  nextItemsAt(now: number): number | null {
    let at: number | null = null;
    for (const r of this.rows) {
      if (r.scope !== 'items' || r.cancelled || r.effectiveAt <= now) continue;
      at = Math.min(at ?? Number.POSITIVE_INFINITY, r.effectiveAt);
    }
    return at;
  }

  /** Damaged stored versions (`scope@version`), ignored; their numbers stay taken. */
  private readonly unreadable: string[] = [];
  private readonly unreadableLatest: Record<ConfigScope, number> = { items: 0, growth: 0 };

  /**
   * The item configs a hold stamped with `fromVersion` has lived under up to `at`, oldest
   * first: that version's own config, then each one that took over after it, with the time
   * it did. Null only when that version takes effect after `at` (a call out of time order).
   * A version gone from the timeline for good gives just the config in force at `at`.
   */
  itemsHistory(fromVersion: number, at: number): ItemSegment[] | null {
    const timeline: ItemSegment[] = [{ config: this.base.items, since: Number.NEGATIVE_INFINITY }];
    const rows = this.rows
      .filter((r) => r.scope === 'items' && !r.cancelled && r.effectiveAt <= at)
      .sort((a, b) => a.effectiveAt - b.effectiveAt || a.version - b.version);
    for (const row of rows) {
      if (row.scope !== 'items') continue;
      const last = timeline[timeline.length - 1]!;
      // Two versions from the same moment: only the higher one was ever in force (inForce
      // picks it at every time from then on), so the lower one is dropped. Kept, it would put
      // holds through a config no batch ever used: e.g. a smaller `hold` in it would make
      // holds count as full and restart their cooldown at that moment.
      if (last.since === row.effectiveAt) timeline.pop();
      timeline.push({ config: row.config, since: row.effectiveAt });
    }
    let start = -1;
    for (let i = timeline.length - 1; i >= 0; i--) {
      if (timeline[i]!.config.version === fromVersion) {
        start = i;
        break;
      }
    }
    if (start >= 0) return timeline.slice(start);
    // A version that takes effect after `at`: the call is earlier than the hold's stamp, so
    // it changes nothing (null). Any other version missing from the timeline (unreadable,
    // cancelled, or a lower version dropped at an equal time) will never come back: the hold
    // carries on under the config in force and is stamped with it, rather than stop filling.
    const later = this.rows.some(
      (r) => r.scope === 'items' && r.version === fromVersion && r.effectiveAt > at,
    );
    return later ? null : [{ config: this.items(at), since: Number.NEGATIVE_INFINITY }];
  }

  items(at: number): ItemConfig {
    const row = this.inForce('items', at);
    return row?.scope === 'items' ? row.config : this.base.items;
  }

  growth(at: number): OpenGrowth {
    const row = this.inForce('growth', at);
    return row?.scope === 'growth' ? row.config : this.base.growth;
  }

  state(at: number): ConfigState {
    const current = { items: this.base.items.version, growth: BASE_GROWTH_VERSION };
    const latest = { ...current };
    for (const scope of CONFIG_SCOPES) {
      current[scope] = this.inForce(scope, at)?.version ?? current[scope];
    }
    for (const row of this.rows) latest[row.scope] = Math.max(latest[row.scope], row.version);
    for (const scope of CONFIG_SCOPES) {
      latest[scope] = Math.max(latest[scope], this.unreadableLatest[scope]);
    }
    const versions = [...this.rows].sort(
      (a, b) => b.effectiveAt - a.effectiveAt || b.version - a.version,
    );
    return {
      at,
      items: this.items(at),
      growth: this.growth(at),
      current,
      latest,
      versions,
      unreadable: [...this.unreadable],
    };
  }

  /**
   * Stores a version. Idempotent: the same scope, version and settings again answer the stored
   * one (a retried admin call). A version must be newer than every version of its scope.
   */
  schedule(input: ConfigVersion, now: number): ConfigScheduleResult {
    const checked = checkVersion(input);
    if (typeof checked === 'string') return { ok: false, reason: 'invalid', detail: checked };
    const { scope, version } = checked;
    const json = JSON.stringify(checked.config);
    const same = this.rows.find((r) => r.scope === scope && r.version === version);
    if (same) {
      if (JSON.stringify(same.config) !== json) return { ok: false, reason: 'conflict' };
      if (same.cancelled) return { ok: false, reason: 'cancelled' };
      return { ok: true, version: same, duplicate: true };
    }
    const latest = this.state(now).latest[scope];
    if (version <= latest) return { ok: false, reason: 'stale', detail: `latest is ${latest}` };
    const pending = this.rows.filter((r) => !r.cancelled && r.effectiveAt > now).length;
    if (pending >= MAX_PENDING) return { ok: false, reason: 'too_many' };
    const effectiveAt = Math.max(checked.effectiveAt, now);
    const stored = { ...checked, effectiveAt, cancelled: false } as ScheduledVersion;
    this.save(() => {
      this.sql.exec(
        'INSERT INTO config_schedule (scope, version, effective_at, json) VALUES (?, ?, ?, ?)',
        scope,
        version,
        effectiveAt,
        json,
      );
    });
    this.rows.push(stored);
    return { ok: true, version: stored };
  }

  /** Cancels a version that has not taken effect yet. */
  cancel(scope: ConfigScope, version: number, now: number): CancelResult {
    const index = this.rows.findIndex((r) => r.scope === scope && r.version === version);
    const row = this.rows[index];
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.cancelled) return { ok: false, reason: 'cancelled' };
    if (row.effectiveAt <= now) return { ok: false, reason: 'already_effective' };
    this.save(() => {
      this.sql.exec(
        'UPDATE config_schedule SET cancelled = 1 WHERE scope = ? AND version = ?',
        scope,
        version,
      );
    });
    this.rows[index] = { ...row, cancelled: true };
    return { ok: true };
  }

  private inForce(scope: ConfigScope, at: number): ScheduledVersion | undefined {
    let best: ScheduledVersion | undefined;
    for (const row of this.rows) {
      if (row.scope !== scope || row.cancelled || row.effectiveAt > at) continue;
      if (
        !best ||
        row.effectiveAt > best.effectiveAt ||
        (row.effectiveAt === best.effectiveAt && row.version > best.version)
      ) {
        best = row;
      }
    }
    return best;
  }
}

/** The version as the canvas will store it, or why it cannot be used. */
export function checkVersion(input: ConfigVersion): ConfigVersion | string {
  const { scope, version, effectiveAt, config } = (input ?? {}) as Partial<ConfigVersion>;
  if (!CONFIG_SCOPES.includes(scope as ConfigScope)) return 'unknown scope';
  if (!Number.isSafeInteger(version) || (version as number) < 1) return 'invalid version';
  if (!Number.isSafeInteger(effectiveAt) || (effectiveAt as number) < 0) {
    return 'invalid effectiveAt';
  }
  if (typeof config !== 'object' || config === null) return 'missing config';
  try {
    if (scope === 'items') {
      const items = pickItems(config as ItemConfig);
      checkItemConfig(items);
      if (items.version !== version) return 'items.version must equal the version';
      return {
        scope,
        version: version as number,
        effectiveAt: effectiveAt as number,
        config: items,
      };
    }
    const growth = pickGrowth(config as OpenGrowth);
    checkGrowth(growth);
    return {
      scope: 'growth',
      version: version as number,
      effectiveAt: effectiveAt as number,
      config: growth,
    };
  } catch (error) {
    return error instanceof Error ? error.message : 'invalid config';
  }
}

/** Only the known fields, so nothing unexpected is stored or handed to the core. */
function pickItems(c: ItemConfig): ItemConfig {
  const rates = c.rates ?? ({} as ItemConfig['rates']);
  return {
    version: c.version,
    hold: c.hold,
    cooldown: c.cooldown,
    startItems: c.startItems,
    rates: { settling: rates.settling, contested: rates.contested, saturated: rates.saturated },
  };
}

function pickGrowth(c: OpenGrowth): OpenGrowth {
  return { atPercent: c.atPercent, step: c.step };
}

function parseRow(row: Row): ScheduledVersion | null {
  try {
    const checked = checkVersion({
      scope: row.scope,
      version: row.version,
      effectiveAt: row.effective_at,
      config: JSON.parse(row.json),
    } as ConfigVersion);
    if (typeof checked === 'string') return null;
    return { ...checked, cancelled: row.cancelled !== 0 } as ScheduledVersion;
  } catch {
    return null;
  }
}
