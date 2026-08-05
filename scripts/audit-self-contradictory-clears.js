#!/usr/bin/env node

/**
 * Self-contradictory clear-breadcrumb sweep (tasks #1020 / #1022 / #1023).
 *
 * Fires on review-text records that assert an exclusion flag AND their own
 * retraction breadcrumb at the same time — "this review is wrong" and "the
 * wrong-ness was cleared" in one file. Unlike the flag-vs-CV detectors in
 * audit-cv-flag-contradiction.js, this needs no adjudication between two
 * verdicts: the state is invalid on its face, so it gates.
 *
 * The forward fixes for the known pairs already exist (every wrongProduction
 * re-flag writer calls review-write-guard.invalidateWrongProductionAutoClear;
 * fix-playbill-bleed-attributions.js stamps wrongArticleManualClear on clear) —
 * this is the standing detector that proves they hold and surfaces the pre-fix
 * backlog. Pair coverage lives in scripts/lib/flag-contradiction.js
 * (SELF_CLEAR_PAIRS); adding a pair there is one table row.
 *
 * Usage:
 *   node scripts/audit-self-contradictory-clears.js              # report
 *   node scripts/audit-self-contradictory-clears.js --gate       # exit 1 over --max
 *   node scripts/audit-self-contradictory-clears.js --gate --max=0
 *   node scripts/audit-self-contradictory-clears.js --fix        # retract stale breadcrumbs
 *   node scripts/audit-self-contradictory-clears.js --show=ID    # scope to one show
 *   node scripts/audit-self-contradictory-clears.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const {
  detectSelfContradictoryClear,
  retractStaleClearBreadcrumb,
} = require('./lib/flag-contradiction');

const USAGE = `audit-self-contradictory-clears.js — exclusion flag + its own clear breadcrumb (#1020/#1022/#1023)

Usage:
  node scripts/audit-self-contradictory-clears.js [--gate] [--max=N] [--fix] [--show=ID] [--json]

  --gate      exit 1 when the contradiction count exceeds --max
  --max=N     gate ceiling (default 0 — the invariant admits no exceptions)
  --fix       retract the stale CLEAR breadcrumb, leaving the flag intact
  --show=ID   scope the sweep to one show directory
  --json      machine-readable output
`;

const ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');

// Tombstone directories only. `_pending/` is deliberately NOT here: it holds
// real reviews awaiting a byline strand that later land on a live show, so a
// contradiction parked there must still gate (memory/feedback_pending_no_byline
// _strand_drain). `_superseded-misattributed/` is the graveyard for records
// already replaced — their flag state is history, not a live scoring input.
const SKIP_DIRS = new Set(['_superseded-misattributed']);

function parseArgs(argv) {
  const args = { gate: false, max: 0, fix: false, show: null, json: false };
  for (const a of argv) {
    if (a === '--gate') args.gate = true;
    else if (a === '--fix') args.fix = true;
    else if (a === '--json') args.json = true;
    else if (a.startsWith('--max=')) args.max = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--show=')) args.show = a.split('=')[1];
  }
  return args;
}

function listShowDirs(showFilter) {
  let entries;
  try {
    entries = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    // isDirectory() is false for symlinked show dirs — accept those too, but
    // never plain files (the stray-symlink class, memory/feedback_stray_symlink).
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((name) => !SKIP_DIRS.has(name))
    .filter((name) => !showFilter || name === showFilter)
    .filter((name) => {
      try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, name)).isDirectory(); }
      catch { return false; }
    });
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = parseArgs(process.argv.slice(2));

  const hits = [];
  let fixed = 0;
  let scanned = 0;

  for (const showId of listShowDirs(args.show)) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json')); }
    catch { continue; }

    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch { continue; }
      scanned++;

      const contradiction = detectSelfContradictoryClear(data);
      if (!contradiction) continue;
      hits.push({ showId, file, ...contradiction });

      if (args.fix) {
        const removed = retractStaleClearBreadcrumb(data, contradiction);
        if (removed.length) {
          // Deliberately a plain write, not safeWriteReview(): the whole point
          // is to REMOVE a breadcrumb that safeWriteReview's isIntentionalClear
          // machinery would treat as protected and restore.
          fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
          fixed++;
        }
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ scanned, count: hits.length, fixed, hits }, null, 2));
  } else {
    console.log(`Self-contradictory clear sweep: ${scanned} review file(s) scanned, ${hits.length} contradiction(s).`);
    const byPair = {};
    for (const h of hits) {
      const key = `${h.flag} + ${h.breadcrumb} (${h.task})`;
      (byPair[key] = byPair[key] || []).push(h);
    }
    for (const [pair, list] of Object.entries(byPair).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${String(list.length).padStart(4)} | ${pair}`);
      for (const h of list.slice(0, 5)) console.log(`         ${h.showId}/${h.file}`);
      if (list.length > 5) console.log(`         … and ${list.length - 5} more`);
    }
    if (args.fix) console.log(`\nRetracted stale breadcrumbs on ${fixed} file(s).`);
  }

  if (args.gate && hits.length > args.max) {
    console.error(`\nFAIL: ${hits.length} self-contradictory clear(s) > max ${args.max}.`);
    console.error('Fix: node scripts/audit-self-contradictory-clears.js --fix');
    process.exit(1);
  }
}

main();
