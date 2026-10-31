#!/usr/bin/env node
/**
 * Clear wrongShow slot-blockers: delete files that have wrongShow=true and contain
 * no useful data (no score, no LLM score, no aggregator data, no meaningful text).
 * These files block gather-reviews from re-discovering the correct URLs.
 *
 * Usage: node scripts/clear-wrong-show-blockers.js [--apply] [--include-scored] [--force-bulk]
 *
 * Default (no --apply) is a dry run: prints what would be deleted without writing.
 * --apply: actually delete the files.
 * --include-scored: also delete wrongShow files that have scores (more aggressive;
 *   NOT enabled in the scheduled workflow — needs separate human review).
 * --force-bulk: override the surge guard (see FIX_SURGE_THRESHOLD below).
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { shouldDeleteWrongShowBlocker, shouldRefuseSurge } = require('./lib/wrong-show-blocker-cleanup');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `clear-wrong-show-blockers.js — Clear wrongShow slot-blockers: delete files that have wrongShow=true and contain no useful data.

Usage:
  node scripts/clear-wrong-show-blockers.js [options]
  node scripts/clear-wrong-show-blockers.js --help, -h    print this usage and exit

Options:
  --apply            Actually delete files (default is dry-run/report-only)
  --include-scored   Also delete wrongShow files that have scores (aggressive; not used by the scheduled workflow)
  --force-bulk       Override the >100-file surge guard
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const includeScored = args.includes('--include-scored');
const forceBulk = args.includes('--force-bulk');

// Surge guard (card #1828, mirrors card #1610's clear-stale-suspected-
// misattribution-flags.js pattern): this now runs unattended and weekly.
// A batch this large usually means the deletion predicate regressed, not
// routine catch-up drift — refuse and require a deliberate --force-bulk.
const FIX_SURGE_THRESHOLD = 100;

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

let deleted = 0;
let kept = 0;
let total = 0;
const deletedByShow = {};
const toDelete = [];

for (const showDir of listShowDirs(REVIEW_TEXTS_DIR)) {
  const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
  if (!fs.statSync(showPath).isDirectory()) continue;

  for (const file of fs.readdirSync(showPath)) {
    if (!file.endsWith('.json')) continue;
    const filepath = path.join(showPath, file);

    try {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      if (!data.wrongShow) continue;
      total++;

      if (shouldDeleteWrongShowBlocker(data, includeScored)) {
        toDelete.push({ filepath, showDir });
      } else {
        kept++;
      }
    } catch (e) {
      // Skip unreadable files
    }
  }
}

deleted = toDelete.length;

if (APPLY && shouldRefuseSurge(deleted, FIX_SURGE_THRESHOLD, forceBulk)) {
  console.error(`::error::Refusing to delete ${deleted} wrongShow blocker files (> ${FIX_SURGE_THRESHOLD}). A batch this large usually means the deletion predicate regressed, not routine drift — re-run with --force-bulk if this is a legitimate large backlog cleanup.`);
  process.exit(1);
}

if (APPLY) {
  for (const { filepath, showDir } of toDelete) {
    fs.unlinkSync(filepath);
    deletedByShow[showDir] = (deletedByShow[showDir] || 0) + 1;
  }
} else {
  for (const { showDir } of toDelete) {
    deletedByShow[showDir] = (deletedByShow[showDir] || 0) + 1;
  }
}

console.log(`\n${APPLY ? '' : '[DRY RUN] '}wrongShow cleanup results:`);
console.log(`  Total wrongShow files: ${total}`);
console.log(`  Deleted: ${deleted}`);
console.log(`  Kept (has useful data): ${kept}`);
console.log(`  Mode: ${includeScored ? 'aggressive (include scored)' : 'conservative (pure junk only)'}`);

if (deleted > 0) {
  const showCount = Object.keys(deletedByShow).length;
  console.log(`\n  Affected ${showCount} shows. Top 10:`);
  const sorted = Object.entries(deletedByShow).sort((a, b) => b[1] - a[1]);
  sorted.slice(0, 10).forEach(([show, count]) => {
    console.log(`    ${show}: ${count} deleted`);
  });
}

if (!APPLY) {
  console.log('\nPass --apply to write changes.');
}
