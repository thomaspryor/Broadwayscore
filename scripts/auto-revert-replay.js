#!/usr/bin/env node
'use strict';
/**
 * auto-revert-replay.js — BRO-7102 item 2: CLI for the read-only 30-day replay of
 * the auto-revert decision. The engine (and its tests) live in
 * scripts/lib/auto-revert-replay.js.
 */
const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { replay, makeWindowFetcher, ghRunsForDay } = require('./lib/auto-revert-replay.js');

const DAY_MS = 86400000;

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/auto-revert-replay.js [--days 30] [--json out.json] [--cache commits-cache.json]\nRead-only replay of the auto-revert decision over main test.yml runs.\nExit 0 clean, 1 any false revert (confirmed or if-confirmed), 2 inconclusive (unknown windows).');
    return;
  }
  const days = Number(arg('--days', '30'));
  const now = Date.now();
  const runs = [];
  for (let d = days; d >= 0; d--) runs.push(...ghRunsForDay(new Date(now - d * DAY_MS).toISOString().slice(0, 10)));
  const windowOf = makeWindowFetcher(undefined, undefined, { cachePath: arg('--cache', null) });
  let result;
  try { result = replay(runs, windowOf); } finally { windowOf.save(); }
  console.log(JSON.stringify({ days, runs: runs.length, ...result, rows: undefined }, null, 2));
  for (const r of result.rows.filter((x) => x.outcome || x.ifConfirmed)) {
    console.log(`${(r.outcome || `if:${r.ifConfirmed}`).padEnd(20)} ${r.candidate} red@${r.redSha} ${r.at} ${r.subject}`);
  }
  const out = arg('--json', null);
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
  // Arming gate: exit 1 on any false revert (confirmed or if-confirmed); exit 2 when any window was unknown
  // (inconclusive: an unread window could hide a false revert, so it never passes).
  // Single-landing reds history never re-ran count too: their if-confirmed outcome
  // is what armed mode would have done once the live confirm re-run failed.
  const falseAny = result.falseReverts + (result.ifConfirmed['false-revert'] || 0);
  process.exitCode = falseAny > 0 ? 1 : result.unknown > 0 ? 2 : 0;
}

if (require.main === module) main();
