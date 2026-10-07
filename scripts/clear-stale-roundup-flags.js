#!/usr/bin/env node
/**
 * Sweep stale isRoundupArticle=true flags off review-text files that are
 * actually individual critic reviews (substantial fullText + isFullReview +
 * non-roundup URL). Identified by `isLikelyStaleRoundupFlag()` from
 * scripts/lib/review-guards.js.
 *
 * Background: Notion 34e637c5-416f-817b. The flag was set by older code paths
 * (URL-pattern matching in isRoundupUrl, blanket KNOWN_ROUNDUP_OUTLETS auto-tag
 * in gather-reviews) on legitimate individual reviews. The flag persisted on
 * disk after the producing code was tightened, silently dropping those reviews
 * from LLM scoring and from reviews.json.
 *
 * BRO-2323: this script existed with no scheduled workflow, so the backlog it
 * finds only grows — see .github/workflows/clear-stale-roundup-flags.yml.
 *
 * Usage:
 *   node scripts/clear-stale-roundup-flags.js [--apply] [--show=ID] [--force-bulk]
 *
 * Default mode is dry-run — prints the list and exits without writing.
 * --force-bulk: override the surge guard (see SURGE_THRESHOLD below).
 */
const fs = require('fs');
const path = require('path');
const { isLikelyStaleRoundupFlag } = require('./lib/review-guards');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs');
const { shouldRefuseSurge } = require('./lib/wrong-show-blocker-cleanup');

// Surge guard (mirrors clear-wrong-show-blockers.js / clear-stale-wrong-show-
// flags.js — this now runs unattended and weekly). A batch this large usually
// means the predicate regressed, not routine catch-up drift. The predicate
// here is whitelist/URL-pattern based with no LLM second-opinion (like
// clear-wrong-show-blockers.js's structural check), but clearing a flag is
// less consequential than deleting a file, so this splits the difference
// between that script's 100 and clear-stale-wrong-show-flags.js's LLM-gated
// 25 rather than taking either sibling's number outright.
const SURGE_THRESHOLD = 50;

const USAGE = `clear-stale-roundup-flags.js — Clear stale isRoundupArticle=true flags off review-text files that are actually individual critic reviews.

Usage:
  node scripts/clear-stale-roundup-flags.js [options]
  node scripts/clear-stale-roundup-flags.js --help, -h    print this usage and exit

Options:
  --apply         Actually write changes (default is dry-run/report-only)
  --show=ID       Limit to a single show directory
  --dir=PATH      Scan a directory other than data/review-texts (testing)
  --force-bulk    Override the >${SURGE_THRESHOLD}-file surge guard
`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE_BULK = args.includes('--force-bulk');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const DIR_OVERRIDE = (args.find(a => a.startsWith('--dir=')) || '').split('=')[1] || '';

const REVIEW_TEXTS_DIR = DIR_OVERRIDE || path.join(__dirname, '..', 'data', 'review-texts');

// listShowDirs skips dangling symlinks with a ::warning:: instead of crashing
// the whole run (card #1610's 8h outage) — the underscore filter on top keeps
// graveyard dirs like _superseded-misattributed/ out of the sweep.
const showDirs = listShowDirs(REVIEW_TEXTS_DIR).filter(name => !name.startsWith('_'));

let scanned = 0;
let flagged = 0;
const toClear = [];

for (const name of showDirs) {
  if (SHOW_FILTER && name !== SHOW_FILTER) continue;
  const showDir = path.join(REVIEW_TEXTS_DIR, name);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  for (const f of files) {
    scanned++;
    const filePath = path.join(showDir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    if (data.isRoundupArticle !== true) continue;
    flagged++;
    if (!isLikelyStaleRoundupFlag(data)) continue;
    toClear.push({ filePath, label: `${name}/${f}` });
  }
}

const stale = toClear.length;

console.log(`Scanned: ${scanned} files`);
console.log(`isRoundupArticle=true: ${flagged}`);
console.log(`Stale (would clear): ${stale}`);

if (APPLY && shouldRefuseSurge(stale, SURGE_THRESHOLD, FORCE_BULK)) {
  console.error(`::error::Refusing to clear ${stale} stale isRoundupArticle flags (> ${SURGE_THRESHOLD}). A batch this large usually means the predicate regressed, not routine catch-up drift — re-run with --force-bulk if this is a legitimate large backlog cleanup.`);
  process.exit(1);
}

if (!APPLY) {
  console.log('\nDRY RUN — pass --apply to write changes.');
  console.log('\nFirst 20 affected files:');
  toClear.slice(0, 20).forEach(({ label }) => console.log('  ' + label));
} else {
  const today = new Date().toISOString().slice(0, 10);
  for (const { filePath } of toClear) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    data.isRoundupArticle = false;
    data.roundupArticleClearedNote = `[${today} cleared stale isRoundupArticle — file has substantial fullText + isFullReview + non-roundup URL — Notion 34e637c5]`;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
  }
  console.log(`\nAPPLIED — cleared ${stale} files.`);
}
