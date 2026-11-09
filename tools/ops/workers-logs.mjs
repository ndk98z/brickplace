#!/usr/bin/env node
// Sums up the ops events of docs/ops/alerts.md from Workers Logs, for one environment and the
// last N minutes, through the Workers Observability API. Read-only.
//
//   CLOUDFLARE_ACCOUNT_ID=<account id> CLOUDFLARE_API_TOKEN=<token> \
//     node tools/ops/workers-logs.mjs [--env staging] [--minutes 60] [--raw]
//
// The token needs Account > Workers Observability > Read; nothing else. The account id is in
// ops-private/<env>.conf, as for every wrangler command (docs/ops/setup.md).
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    env: { type: 'string', default: 'staging' },
    minutes: { type: 'string', default: '60' },
    raw: { type: 'boolean', default: false },
  },
});
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) {
  console.error(
    'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers Observability: Read).',
  );
  process.exit(2);
}
const minutes = Number(values.minutes);
if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error('--minutes takes a positive number');
  process.exit(2);
}
const suffix = `-${values.env}`;
const to = Date.now();
const from = to - minutes * 60_000;
const LIMIT = 2000;

async function query(name, filters, limit) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queryId: `brickplace-${name}-${to}`,
        timeframe: { from, to },
        view: 'events',
        limit,
        parameters: { datasets: ['cloudflare-workers'], filters, filterCombination: 'and', limit },
      }),
    },
  );
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.success) {
    const errors = JSON.stringify(json?.errors ?? json).slice(0, 800);
    console.error(`${name} query failed: HTTP ${response.status} ${errors}`);
    process.exit(1);
  }
  return json.result;
}

// Each row is one log line: `source` is the object the Worker logged, `$workers` says which
// script and handler logged it.
const result = await query('ops', [{ key: 'event', operation: 'exists', type: 'string' }], LIMIT);
// This environment's BrickPlace scripts only (the account may hold others), and only rows that
// carry an event name, so every loop below sees the same rows.
const rows = (result.events?.events ?? []).filter((row) => {
  const script = String(row.$workers?.scriptName ?? '');
  return (
    script.startsWith('brickplace-') &&
    script.endsWith(suffix) &&
    typeof row.source?.event === 'string'
  );
});
const scriptOf = (row) =>
  String(row.$workers?.scriptName ?? '?')
    .replace(/^brickplace-/, '')
    .replace(suffix, '');

const counts = {};
const abuse = {};
const worst = {};
for (const row of rows) {
  const e = row.source ?? {};
  if (typeof e.event !== 'string') continue;
  const tag = `${scriptOf(row)}:${e.event}`;
  counts[tag] = (counts[tag] ?? 0) + 1;
  for (const [key, value] of Object.entries(e)) {
    if (typeof value !== 'number') continue;
    if (e.event === 'fanout_abuse') abuse[key] = (abuse[key] ?? 0) + value;
    else worst[`${e.event}.${key}`] = Math.max(worst[`${e.event}.${key}`] ?? 0, value);
  }
}

const iso = (ms) => new Date(ms).toISOString();
console.log(`${values.env}, last ${minutes} min (${iso(from)} to ${iso(to)})`);
const all = result.events?.events?.length ?? 0;
console.log(
  `ops events: ${rows.length}${all >= LIMIT ? ' (hit the limit: shorten --minutes)' : ''}`,
);
console.log('\n== count by script and event');
for (const [tag, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tag.padEnd(40)} ${n}`);
}
if (!rows.length) console.log('  none: nothing hit a limit, a signal or a slow path');
console.log('\n== bot signals and abuse limits (fanout_abuse, summed)');
console.log(Object.keys(abuse).length ? `  ${JSON.stringify(abuse)}` : '  none');
console.log('\n== worst value of each numeric field');
console.log(Object.keys(worst).length ? `  ${JSON.stringify(worst)}` : '  none');
console.log('\n== every event, oldest first (UTC)');
for (const row of [...rows].sort((a, b) => a.timestamp - b.timestamp)) {
  const { event, ...fields } = row.source;
  const where = `${scriptOf(row)}/${row.$workers?.eventType ?? '?'}`;
  console.log(
    `  ${iso(row.timestamp).slice(11, 19)} ${where.padEnd(18)} ${event.padEnd(26)} ${JSON.stringify(fields)}`,
  );
}

if (values.raw) {
  // A few lines of any kind, to see how the API names its fields.
  const sample = await query('sample', [], 3);
  console.log('\n== raw sample');
  console.log(JSON.stringify(sample.events?.events ?? sample, null, 1).slice(0, 4000));
}
