#!/usr/bin/env node
/**
 * heal-orphaned-duplicate-pointers.js
 *
 * Driver for scripts/lib/orphaned-duplicate-pointer-heal.js (BRO-3250). Walks
 * data/review-texts, finds duplicateOf pointers whose TARGET was flagged
 * invalid (wrongShow/wrongProduction/nonReviewFlag/rejectedBy) by a
 * downstream classifier AFTER the pointer was set, and clears the pointer so
 * the wrongly-suppressed file re-enters isIncludableForRebuild.
 *
 * Same write pattern as heal-duplicate-of-direction.js / the fix() in
 * audit-duplicate-of-url-mismatch.js: LOAD-MODIFY-SAVE the full object,
 * stamp duplicateClearReason (the push-restore exception breadcrumb
 * isIntentionalClear() honors), then safeWriteReview.
 *
 * Surge guard: above FIX_SURGE_THRESHOLD, --fix refuses without
 * --force-bulk — a spike could mean a classifier regression flagged a batch
 * of siblings that were never actually invalid, and blindly re-admitting
 * that many reviews would flood scoring. Same philosophy as
 * audit-duplicate-of-url-mismatch.js's FIX_SURGE_THRESHOLD.
 *
 * Usage:
 *   node scripts/heal-orphaned-duplicate-pointers.js                # report (exit 1 if any)
 *   node scripts/heal-orphaned-duplicate-pointers.js --dry-run       # same as report (explicit)
 *   node scripts/heal-orphaned-duplicate-pointers.js --json          # JSON report
 *   node scripts/heal-orphaned-duplicate-pointers.js --fix           # repair in place
 *   node scripts/heal-orphaned-duplicate-pointers.js --fix --force-bulk  # override surge guard
 *   node scripts/heal-orphaned-duplicate-pointers.js --show=ID --fix     # scope to one show
 *   REVIEW_TEXTS_DIR=/path node scripts/... --fix                        # target a clone
 *
 * Exit codes: 0 = no orphans (report) / repaired (--fix); 1 = orphans found (report) / surge refused.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { findOrphanedDuplicatePointers } = require('./lib/orphaned-duplicate-pointer-heal');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `heal-orphaned-duplicate-pointers.js — Retro-heals duplicateOf pointers orphaned by a later target-invalidation (BRO-3250).

Usage:
  node scripts/heal-orphaned-duplicate-pointers.js [options]
  node scripts/heal-orphaned-duplicate-pointers.js --help, -h    print this usage and exit

Options:
  --json         machine-readable report
  --dry-run      report only (default; accepted explicitly for scripting)
  --fix          repair in place
  --force-bulk   override the surge guard (FIX_SURGE_THRESHOLD)
  --show=ID      scope to a single show directory
`;

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const AUDIT_PATH = path.join(__dirname, '..', 'data', 'audit', 'orphaned-duplicate-pointer-heal.json');

// Same non-show buckets audit-duplicate-of-url-mismatch.js excludes: neither
// is a real show directory with a sibling namespace duplicateOf can resolve
// against. See that script's NON_SHOW_DIRS comment for the full rationale.
const NON_SHOW_DIRS = new Set(['_pending', '_superseded-misattributed']);

// A spike past this floor signals a classifier regression (e.g.
// classify-wrong-production.js mass-flagging siblings that were never
// actually invalid) rather than normal one-at-a-time drift. --fix refuses
// without --force-bulk so a human reviews before re-admitting that many
// reviews to scoring. Mirrors audit-duplicate-of-url-mismatch.js's
// FIX_SURGE_THRESHOLD (25); set higher here because the initial BRO-3250
// backlog is itself ~124 files and is expected to need one --force-bulk run.
const FIX_SURGE_THRESHOLD = 150;

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const JSON_OUT = args.includes('--json');
const FORCE_BULK = args.includes('--force-bulk');
const showArg = args.find((a) => a.startsWith('--show='));
const SHOW_FILTER = showArg ? showArg.slice('--show='.length) : null;

function walkShowDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !NON_SHOW_DIRS.has(e.name))
    .filter((e) => !SHOW_FILTER || e.name === SHOW_FILTER)
    .map((e) => path.join(root, e.name));
}

/** Find all orphaned duplicateOf pointers. Returns [{showId, loserFile, targetFile, reason}]. */
function audit() {
  const results = [];
  for (const showDir of walkShowDirs(REVIEW_TEXTS_DIR)) {
    const showId = path.basename(showDir);
    let files;
    try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json'); }
    catch { continue; }
    const records = [];
    for (const file of files) {
      try {
        records.push({ file, data: JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf-8')) });
      } catch { /* unreadable file — skip, other audits catch corrupt JSON */ }
    }
    for (const orphan of findOrphanedDuplicatePointers(records)) {
      results.push({ showId, ...orphan });
    }
  }
  return results;
}

function fix(orphans) {
  let cleared = 0;
  const day = new Date().toISOString().slice(0, 10);
  for (const o of orphans) {
    const dir = path.join(REVIEW_TEXTS_DIR, o.showId);
    const filePath = path.join(dir, o.loserFile);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data.duplicateClearReason =
      `heal-orphaned-duplicate-pointers.js on ${day}: target ${o.targetFile} was flagged invalid after this pointer was set (${o.reason})`;
    data.duplicateOf = null;
    data.duplicateReason = null;
    safeWriteReview(filePath, data);
    cleared++;
  }
  return cleared;
}

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const orphans = audit();
  if (JSON_OUT) {
    console.log(JSON.stringify({ count: orphans.length, orphans }, null, 2));
    process.exit(orphans.length === 0 ? 0 : (FIX ? 0 : 1));
  }
  if (orphans.length === 0) {
    console.log('OK: no orphaned duplicateOf pointers found');
    process.exit(0);
  }
  console.log(`Found ${orphans.length} orphaned duplicateOf pointer(s):\n`);
  for (const o of orphans) {
    console.log(`  ${o.showId}`);
    console.log(`    ${o.loserFile}  duplicateOf → ${o.targetFile} (now invalid)`);
  }
  if (FIX) {
    if (orphans.length > FIX_SURGE_THRESHOLD && !FORCE_BULK) {
      console.log(`\nRefusing to auto-clear ${orphans.length} pointer(s) — above FIX_SURGE_THRESHOLD (${FIX_SURGE_THRESHOLD}).`);
      console.log('This many at once could mean a classifier regression, not normal drift. Review the list above, then re-run with --force-bulk to proceed.');
      process.exit(1);
    }
    const cleared = fix(orphans);
    try {
      fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
      fs.writeFileSync(AUDIT_PATH, JSON.stringify({
        generated: new Date().toISOString(),
        note: 'Orphaned duplicateOf pointers cleared by heal-orphaned-duplicate-pointers.js --fix (BRO-3250).',
        count: orphans.length,
        orphans,
      }, null, 2) + '\n');
    } catch (e) { console.warn(`[heal-orphaned-duplicate-pointers] could not write audit report: ${e.message}`); }
    console.log(`\nCleared ${cleared} orphaned duplicateOf pointer(s).`);
    console.log('Re-run the rebuild to pick up the re-admitted reviews.');
    process.exit(0);
  }
  console.log('\nRun with --fix to repair.');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { audit, fix, walkShowDirs, FIX_SURGE_THRESHOLD };
