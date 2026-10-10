#!/usr/bin/env node
/**
 * bsc-needs-you — one-shot list of ONLY the cmux tabs with a pending owner
 * decision, each with its exact tab title and the one-sentence question.
 * Everything else is implicitly "nothing needed from you" (card #870, owner
 * pain 2026-08-02: "I just have this giant list of tabs and I can't tell
 * which ones actually need decisions from me").
 *
 * Read-only: mirrors bsc-status.js's cmux + fs access pattern, never closes,
 * marks, or dispatches anything. All logic lives in
 * scripts/lib/needs-you-snapshot.js (shared with the digest section).
 *
 *   bsc-needs-you           print pending-decision tabs (title + question)
 *   bsc-needs-you --help    usage only, no cmux/fs side effects
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const { buildNeedsYouSnapshot } = require('./lib/needs-you-snapshot.js');

const USAGE = `bsc-needs-you — list ONLY cmux tabs with a pending owner decision.

Usage:
  bsc-needs-you           print pending-decision tabs (title + question)
  bsc-needs-you --help    show this message, do nothing else

Read-only: never closes, marks, or dispatches anything.
`;

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const snap = buildNeedsYouSnapshot();
  if (!snap) { console.log('cmux CLI not found — nothing to check.'); return; }
  if (!snap.items.length) { console.log('Nothing needs you right now.'); return; }
  console.log(`Tabs needing your decision (${snap.items.length}):\n`);
  for (const item of snap.items) {
    console.log(`  ${item.title}`);
    console.log(`      ${item.detail}\n`);
  }
}

if (require.main === module) main();

module.exports = { main, USAGE };
