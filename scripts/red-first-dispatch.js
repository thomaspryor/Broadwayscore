#!/usr/bin/env node
/**
 * red-first-dispatch.js — run the BRO-4054 red-first pass once by hand.
 *
 * The pass itself lives in scripts/lib/red-first-dispatch.js and is wired
 * FIRST into scripts/bsc-reconcile.js's 5-minute launchd tick; this CLI is
 * the by-hand / live-proof entry point (same code path, same journal).
 *
 *   node scripts/red-first-dispatch.js             dispatch eligible red cards + follow up resolved ones
 *   node scripts/red-first-dispatch.js --dry-run   select and decide only; spawn/journal/mutate nothing
 *   node scripts/red-first-dispatch.js --help, -h  usage, do nothing else
 *
 * Prints one JSON summary line ({dispatched, skipped, followUps}) and exits 0;
 * a thrown error prints to stderr and exits 1.
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const { runRedFirstPass } = require('./lib/red-first-dispatch.js');

const USAGE = `red-first-dispatch.js — BRO-4054 red-first pass (dispatch red-main cards, follow up resolved ones)
  node scripts/red-first-dispatch.js [--dry-run]
    --dry-run   select and decide only; no spawn, no journal write, no Linear mutation
    --help, -h  print this usage and exit — no reads/writes
  Kill switches: RED_FIRST_DISABLED=1, LINEAR_NEXT_DISABLED=1
`;

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const dryRun = argv.includes('--dry-run');
  const summary = await runRedFirstPass({ dryRun });
  console.log(JSON.stringify({ dryRun, ...summary }));
}

if (require.main === module) {
  main().catch((err) => { console.error(`[red-first-dispatch] ${(err && err.stack) || err}`); process.exit(1); });
}

module.exports = { main, USAGE };
