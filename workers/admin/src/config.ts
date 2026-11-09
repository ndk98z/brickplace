import type { ItemConfig } from '@brickplace/core';
import type { ConfigScope, ConfigState, ConfigVersion, ScheduledVersion } from '@brickplace/game';
import { CONFIG_SCOPES, checkVersion } from '@brickplace/game/config';
import { auditStatement } from './audit.ts';
import type { Admin } from './identity.ts';
import type { CanvasConfigPort } from './ports.ts';

// Config versions (ADR 0022). D1 keeps every version an admin made, who made it and why; the
// canvas keeps its own copy and switches to it at its effective time. A version is recorded in
// D1 first, then sent to the canvas (which answers a retry of the same version as already
// stored), then marked delivered in the same batch as its audit row. A version whose delivery
// failed stays listed as not delivered until an admin retries or cancels it.

/** Largest cooldown the core accepts (ms, a u32 on the wire). */
const MAX_COOLDOWN = 0xffffffff;
const LIST_LIMIT = 100;

export interface VersionRow {
  readonly id: number;
  readonly canvas: string;
  readonly scope: ConfigScope;
  readonly version: number;
  readonly config: unknown;
  readonly effectiveAt: number;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly note: string;
  readonly deliveredAt: number | null;
  readonly cancelledAt: number | null;
  readonly cancelledBy: string | null;
}

export interface Outcome {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

type Row = {
  id: number;
  canvas: string;
  scope: ConfigScope;
  version: number;
  json: string;
  effective_at: number;
  created_by: string;
  created_at: number;
  note: string;
  delivered_at: number | null;
  cancelled_at: number | null;
  cancelled_by: string | null;
};

function toView(row: Row): VersionRow {
  return {
    id: row.id,
    canvas: row.canvas,
    scope: row.scope,
    version: row.version,
    config: JSON.parse(row.json),
    effectiveAt: row.effective_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    note: row.note,
    deliveredAt: row.delivered_at,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
  };
}

/** The canvas's view (or why it could not be read) and the versions recorded in D1. */
export async function configView(db: D1Database, port: CanvasConfigPort): Promise<Outcome> {
  const { results } = await db
    .prepare('SELECT * FROM config_versions WHERE canvas = ? ORDER BY id DESC LIMIT ?')
    .bind(port.canvas, LIST_LIMIT)
    .all<Row>();
  let state: ConfigState | null = null;
  try {
    state = await port.state();
  } catch (error) {
    console.error('admin: could not read the canvas config', error);
  }
  return {
    status: 200,
    body: { canvas: port.canvas, state, versions: results.map(toView) },
  };
}

export interface NewVersion {
  readonly scope: unknown;
  readonly config: unknown;
  /** ms; null or a past time means now. */
  readonly effectiveAt: unknown;
  readonly note: string;
}

/**
 * Records a new version and delivers it. The version number is one more than any the canvas
 * or D1 knows for the scope; `config.version` of an item config is set to it.
 */
export async function createVersion(
  db: D1Database,
  port: CanvasConfigPort,
  admin: Admin,
  input: NewVersion,
  now: number,
  action = 'config.schedule',
): Promise<Outcome> {
  const scope = CONFIG_SCOPES.find((s) => s === input.scope);
  if (!scope) return { status: 400, body: { error: 'invalid', detail: 'unknown scope' } };
  if (typeof input.config !== 'object' || input.config === null) {
    return { status: 400, body: { error: 'invalid', detail: 'config must be an object' } };
  }
  const requested = input.effectiveAt ?? null;
  if (requested !== null && (!Number.isSafeInteger(requested) || (requested as number) < 0)) {
    return { status: 400, body: { error: 'invalid', detail: 'effectiveAt must be ms or null' } };
  }
  const state = await readState(port);
  if (!state) return { status: 503, body: { error: 'canvas_unavailable' } };
  const recorded = await db
    .prepare('SELECT MAX(version) AS v FROM config_versions WHERE canvas = ? AND scope = ?')
    .bind(port.canvas, scope)
    .first<{ v: number | null }>();
  const version = Math.max(state.latest[scope], recorded?.v ?? 0) + 1;
  const effectiveAt = Math.max((requested as number | null) ?? now, now);
  const config =
    scope === 'items' ? { ...(input.config as ItemConfig), version } : { ...input.config };
  const checked = checkVersion({ scope, version, effectiveAt, config } as ConfigVersion);
  if (typeof checked === 'string') {
    return { status: 400, body: { error: 'invalid', detail: checked } };
  }
  let id: number;
  try {
    const row = await db
      .prepare(
        'INSERT INTO config_versions (canvas, scope, version, json, effective_at, created_by, ' +
          'created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      )
      .bind(
        port.canvas,
        scope,
        version,
        JSON.stringify(checked.config),
        effectiveAt,
        admin.email,
        now,
        input.note,
      )
      .first<{ id: number }>();
    id = row!.id;
  } catch (error) {
    // Another admin took this number a moment ago: the UNIQUE index, or the no-replace
    // trigger that runs before it (migrations/0001_admin.sql).
    if (/UNIQUE|never replaced/.test(String(error))) {
      return { status: 409, body: { error: 'version_taken' } };
    }
    throw error;
  }
  const before = scope === 'items' ? state.items : state.growth;
  return deliver(db, port, admin, id, checked, now, {
    action,
    before: { version: state.current[scope], config: before },
    reason: input.note,
    pending: pendingAfter(state, scope, effectiveAt),
  });
}

/** Answers a refused change and records the refusal in the audit log. */
async function refused(
  db: D1Database,
  admin: Admin,
  now: number,
  entry: { action: string; target: string; reason: string; outcome: string },
  status: number,
): Promise<Outcome> {
  await auditStatement(db, admin, now, entry).run();
  return { status, body: { error: entry.outcome } };
}

/** Sends a recorded version that is not delivered yet to the canvas again. */
export async function retryDelivery(
  db: D1Database,
  port: CanvasConfigPort,
  admin: Admin,
  id: number,
  reason: string,
  now: number,
): Promise<Outcome> {
  const row = await readRow(db, port.canvas, id);
  const log = { action: 'config.deliver', reason };
  if (!row)
    return refused(db, admin, now, { ...log, target: `id ${id}`, outcome: 'not_found' }, 404);
  const target = `${port.canvas}/${row.scope}@${row.version}`;
  if (row.cancelled_at !== null) {
    return refused(db, admin, now, { ...log, target, outcome: 'cancelled' }, 409);
  }
  if (row.delivered_at !== null) return { status: 200, body: { version: toView(row) } };
  const version = {
    scope: row.scope,
    version: row.version,
    effectiveAt: row.effective_at,
    config: JSON.parse(row.json),
  } as ConfigVersion;
  return deliver(db, port, admin, id, version, now, log);
}

async function deliver(
  db: D1Database,
  port: CanvasConfigPort,
  admin: Admin,
  id: number,
  version: ConfigVersion,
  now: number,
  log: { action: string; before?: unknown; reason: string; pending?: readonly ScheduledVersion[] },
): Promise<Outcome> {
  const target = `${port.canvas}/${version.scope}@${version.version}`;
  let result: Awaited<ReturnType<CanvasConfigPort['schedule']>>;
  try {
    result = await port.schedule(version);
  } catch (error) {
    console.error('admin: could not deliver a config version', error);
    await auditStatement(db, admin, now, {
      action: log.action,
      target,
      before: log.before,
      after: version,
      reason: log.reason,
      outcome: 'not_delivered',
    }).run();
    return { status: 502, body: { error: 'not_delivered', id } };
  }
  if (!result.ok) {
    await auditStatement(db, admin, now, {
      action: log.action,
      target,
      before: log.before,
      after: version,
      reason: log.reason,
      outcome: result.reason,
    }).run();
    return { status: 409, body: { error: result.reason, detail: result.detail, id } };
  }
  const stored = result.version;
  await db.batch([
    db
      // A delivery that raced this one already recorded it; the first one stands.
      .prepare(
        'UPDATE config_versions SET delivered_at = ?, effective_at = ? ' +
          'WHERE id = ? AND delivered_at IS NULL',
      )
      .bind(now, stored.effectiveAt, id),
    auditStatement(db, admin, now, {
      action: log.action,
      target,
      before: log.before,
      after: { version: stored.version, effectiveAt: stored.effectiveAt, config: stored.config },
      reason: log.reason,
    }),
  ]);
  const row = await readRow(db, port.canvas, id);
  return {
    status: 200,
    body: { version: row ? toView(row) : null, pending: log.pending ?? [] },
  };
}

/** Cancels a version that has not taken effect: on the canvas, then in D1. */
export async function cancelVersion(
  db: D1Database,
  port: CanvasConfigPort,
  admin: Admin,
  id: number,
  reason: string,
  now: number,
): Promise<Outcome> {
  const row = await readRow(db, port.canvas, id);
  const log = { action: 'config.cancel', reason };
  if (!row)
    return refused(db, admin, now, { ...log, target: `id ${id}`, outcome: 'not_found' }, 404);
  const target = `${port.canvas}/${row.scope}@${row.version}`;
  if (row.cancelled_at !== null) {
    return refused(db, admin, now, { ...log, target, outcome: 'cancelled' }, 409);
  }
  // Recorded before the canvas acts, so a failure after the call cannot leave it unrecorded.
  await auditStatement(db, admin, now, { ...log, target, outcome: 'requested' }).run();
  let result: Awaited<ReturnType<CanvasConfigPort['cancel']>>;
  try {
    result = await port.cancel(row.scope, row.version);
  } catch (error) {
    console.error('admin: could not cancel a config version', error);
    return refused(db, admin, now, { ...log, target, outcome: 'canvas_unavailable' }, 503);
  }
  // `not_found`: never delivered, so there is nothing to undo on the canvas.
  if (!result.ok && result.reason === 'already_effective') {
    return refused(db, admin, now, { ...log, target, outcome: result.reason }, 409);
  }
  await db.batch([
    db
      .prepare(
        'UPDATE config_versions SET cancelled_at = ?, cancelled_by = ? ' +
          'WHERE id = ? AND cancelled_at IS NULL',
      )
      .bind(now, admin.email, id),
    auditStatement(db, admin, now, {
      action: 'config.cancel',
      target,
      before: { effectiveAt: row.effective_at, config: JSON.parse(row.json) },
      reason,
    }),
  ]);
  const after = await readRow(db, port.canvas, id);
  return { status: 200, body: { version: after ? toView(after) : null } };
}

/**
 * Emergency: a new item config, effective now, with the cooldown in force doubled. Versions
 * scheduled for later still take over at their time; the reply lists them.
 */
export async function doubleCooldown(
  db: D1Database,
  port: CanvasConfigPort,
  admin: Admin,
  reason: string,
  now: number,
): Promise<Outcome> {
  const state = await readState(port);
  if (!state) return { status: 503, body: { error: 'canvas_unavailable' } };
  const cooldown = Math.min(state.items.cooldown * 2, MAX_COOLDOWN);
  return createVersion(
    db,
    port,
    admin,
    {
      scope: 'items',
      config: { ...state.items, cooldown },
      effectiveAt: null,
      note: `Emergency cooldown x2 (${state.items.cooldown} ms to ${cooldown} ms): ${reason}`,
    },
    now,
    'emergency.cooldown_double',
  );
}

/** What carrying one scope's settings to a new season's canvas did. */
export type CarryOutcome =
  | { readonly scope: ConfigScope; readonly carried: 'same' }
  | { readonly scope: ConfigScope; readonly carried: number }
  | { readonly scope: ConfigScope; readonly error: string };

/**
 * A new season's canvas takes the settings in force on the canvas players are on now (ADR
 * 0022, owner to confirm): for each scope whose settings differ from the new canvas's own,
 * one version effective at once (so in force from its first op), recorded, delivered and
 * audited as `config.carry` like any version. Versions the old canvas has scheduled for later
 * stay there: they belong to its season. A failure is reported per scope and changes nothing
 * else; the season stands, and an owner makes the version by hand.
 */
export async function carryConfig(
  db: D1Database,
  from: CanvasConfigPort,
  to: CanvasConfigPort,
  admin: Admin,
  reason: string,
  now: number,
): Promise<CarryOutcome[]> {
  const source = await readState(from);
  const target = await readState(to);
  if (!source || !target) {
    const error = `canvas ${source ? to.canvas : from.canvas} could not be read`;
    return CONFIG_SCOPES.map((scope) => ({ scope, error }));
  }
  const out: CarryOutcome[] = [];
  for (const scope of CONFIG_SCOPES) {
    // An item config's number is its own canvas's; the settings are what is compared.
    const settings = (state: ConfigState) =>
      scope === 'items' ? { ...state.items, version: 0 } : state.growth;
    if (JSON.stringify(settings(source)) === JSON.stringify(settings(target))) {
      out.push({ scope, carried: 'same' });
      continue;
    }
    const config = scope === 'items' ? source.items : source.growth;
    const made = await createVersion(
      db,
      to,
      admin,
      {
        scope,
        config,
        effectiveAt: null,
        note: `Carried over from ${from.canvas} (${scope}@${source.current[scope]}): ${reason}`,
      },
      now,
      'config.carry',
    ).catch(
      (error: unknown): Outcome => ({
        status: 503,
        body: { error: error instanceof Error ? error.message : String(error) },
      }),
    );
    const version = (made.body.version as { version?: number } | null | undefined)?.version;
    out.push(
      made.status === 200 && version !== undefined
        ? { scope, carried: version }
        : { scope, error: String(made.body.error ?? `HTTP ${made.status}`) },
    );
  }
  return out;
}

async function readState(port: CanvasConfigPort): Promise<ConfigState | null> {
  try {
    return await port.state();
  } catch (error) {
    console.error('admin: could not read the canvas config', error);
    return null;
  }
}

async function readRow(db: D1Database, canvas: string, id: number): Promise<Row | null> {
  return db
    .prepare('SELECT * FROM config_versions WHERE id = ? AND canvas = ?')
    .bind(id, canvas)
    .first<Row>();
}

/** Versions of `scope` that will take over after `from`: an admin should know about them. */
function pendingAfter(state: ConfigState, scope: ConfigScope, from: number): ScheduledVersion[] {
  return state.versions.filter((v) => v.scope === scope && !v.cancelled && v.effectiveAt > from);
}
