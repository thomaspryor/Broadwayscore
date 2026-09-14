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
const {
  findOrphanedDuplicatePointers,
  findUnjustifiedHealClears,
  findChainPointersThrough,
  buildHealClearReason,
} = require('./lib/orphaned-duplicate-pointer-heal');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `heal-orphaned-duplicate-pointers.js — Retro-heals duplicateOf pointers orphaned by a later target-invalidation (BRO-3250).

Usage:
  node scripts/heal-orphaned-duplicate-pointers.js [options]
  node scripts/heal-orphaned-duplicate-pointers.js --help, -h    print this usage and exit

Options:
  --json                machine-readable report
  --dry-run             report only (default; accepted explicitly for scripting)
  --fix                 repair in place
  --force-bulk          override the surge guard (FIX_SURGE_THRESHOLD)
  --show=ID             scope to a single show directory
  --revert-unjustified  retract clears THIS heal made whose target was never
                        actually invalidated (BRO-3092); report only unless --fix
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
const REVERT_UNJUSTIFIED = args.includes('--revert-unjustified');
const showArg = args.find((a) => a.startsWith('--show='));
const SHOW_FILTER = showArg ? showArg.slice('--show='.length) : null;

function walkShowDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !NON_SHOW_DIRS.has(e.name))
    .filter((e) => !SHOW_FILTER || e.name === SHOW_FILTER)
    .map((e) => path.join(root, e.name));
}

/** Read one show directory into the {file, data} record list the pure lib takes. */
function readShowRecords(showDir) {
  let files;
  try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json'); }
  catch { return null; }
  const records = [];
  for (const file of files) {
    try {
      records.push({ file, data: JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf-8')) });
    } catch { /* unreadable file — skip, other audits catch corrupt JSON */ }
  }
  return records;
}

/**
 * Walk the corpus with one of the pure detectors.
 * @param {(records: Array) => Array} detect
 * @returns {Array<{showId: string, loserFile: string, targetFile: string, reason: string}>}
 */
function scan(detect) {
  const results = [];
  for (const showDir of walkShowDirs(REVIEW_TEXTS_DIR)) {
    const showId = path.basename(showDir);
    const records = readShowRecords(showDir);
    if (!records) continue;
    for (const hit of detect(records)) results.push({ showId, ...hit });
  }
  return results;
}

/** Find all orphaned duplicateOf pointers. Returns [{showId, loserFile, targetFile, reason}]. */
function audit() {
  return scan(findOrphanedDuplicatePointers);
}

/** Find clears this heal made that the corrected predicate no longer justifies (BRO-3092). */
function auditUnjustified() {
  return scan(findUnjustifiedHealClears);
}

/**
 * Chains left one hop short behind a pointer this heal has ALREADY restored
 * (a file carrying duplicateHealRetractedReason with a live duplicateOf).
 * Scanned separately from revert()'s own in-pass flattening so the mode is
 * idempotent: a restore that landed before chain-flattening existed still gets
 * cleaned up on the next run, rather than silently leaving the sibling that
 * pointed at it recoverable by rebuild-all-reviews.js.
 */
function auditChainsBehindRestores() {
  return scan((records) => {
    const out = [];
    for (const { file, data } of records) {
      if (!data || !data.duplicateHealRetractedReason || !data.duplicateOf) continue;
      out.push(...findChainPointersThrough(records, file));
    }
    return out;
  });
}

/**
 * Restore the duplicateOf pointers listed by auditUnjustified(). Mirrors the
 * write-guard's own re-mark branch: set duplicateOf/duplicateReason and null
 * out the now-false clear breadcrumb, so the push-review-texts restore
 * exception (isIntentionalClear) stops treating the file as intentionally
 * un-suppressed.
 */
function revert(unjustified) {
  let restored = 0;
  let flattened = 0;
  const day = new Date().toISOString().slice(0, 10);
  for (const o of unjustified) {
    const showDir = path.join(REVIEW_TEXTS_DIR, o.showId);
    const filePath = path.join(showDir, o.loserFile);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data.duplicateOf = o.targetFile;
    // The reason fix() nulled, when the breadcrumb recorded it — inventing
    // 'url-collision-detected-at-write' over a real 'byline-explosion-collapse'
    // or task-#1072 outlet-mismatch verdict would falsify the provenance.
    data.duplicateReason = o.priorDuplicateReason || 'url-collision-detected-at-write';
    data.duplicateClearReason = null;
    data.duplicateHealRetractedReason =
      `heal-orphaned-duplicate-pointers.js --revert-unjustified on ${day}: ${o.reason} (BRO-3092)`;
    // force:true — this write CHOOSES its duplicateOf target deliberately, and
    // the detector has already applied the guard's own decision predicate
    // (shouldMarkUrlCollisionDuplicate) plus the cycle check to that exact
    // pair. Without force, safeWriteReview's collision self-heal re-points the
    // file at whatever same-URL sibling readdir happens to return first, which
    // in a 3-file cluster silently overwrites the target we picked (measured on
    // romeo-juliet-2024). We read-modify-write the complete record, so nothing
    // force would otherwise preserve is lost.
    safeWriteReview(filePath, data, { force: true });
    restored++;

    // The loser is a duplicate again, so anything pointing AT it is now one hop
    // short of the canonical — and rebuild-all-reviews.js recovers through that
    // hop instead of following it. Flatten, or the restore just swaps which
    // byline carries the duplicate URL into reviews.json.
    flattened += flatten(findChainPointersThrough(readShowRecords(showDir) || [], o.loserFile)
      .map((c) => ({ showId: o.showId, ...c })));
  }
  return { restored, flattened };
}

/** Re-aim one-hop chain pointers at the canonical they should have pointed at. */
function flatten(chains) {
  let n = 0;
  const day = new Date().toISOString().slice(0, 10);
  for (const c of chains) {
    const chainPath = path.join(REVIEW_TEXTS_DIR, c.showId, c.loserFile);
    const chainData = JSON.parse(fs.readFileSync(chainPath, 'utf-8'));
    const wasPointingAt = chainData.duplicateOf;
    chainData.duplicateOf = c.targetFile;
    if (chainData.duplicateTextOf === wasPointingAt) chainData.duplicateTextOf = c.targetFile;
    chainData.duplicateClearReason = null;
    chainData.duplicateHealRetractedReason =
      `heal-orphaned-duplicate-pointers.js --revert-unjustified on ${day}: ${c.reason} (BRO-3092)`;
    safeWriteReview(chainPath, chainData, { force: true }); // same reasoning as revert()
    n++;
  }
  return n;
}

function fix(orphans) {
  let cleared = 0;
  const day = new Date().toISOString().slice(0, 10);
  for (const o of orphans) {
    const dir = path.join(REVIEW_TEXTS_DIR, o.showId);
    const filePath = path.join(dir, o.loserFile);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data.duplicateClearReason = buildHealClearReason(day, o.targetFile, o.reason, data.duplicateReason);
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

  if (REVERT_UNJUSTIFIED) {
    const unjustified = auditUnjustified();
    const standingChains = auditChainsBehindRestores();
    if (unjustified.length === 0 && standingChains.length === 0) {
      console.log(JSON_OUT
        ? JSON.stringify({ mode: 'revert-unjustified', count: 0, unjustified: [], chains: [] }, null, 2)
        : 'OK: no unjustified heal clears found');
      process.exit(0);
    }
    if (FIX && unjustified.length === 0) {
      // Nothing new to restore, but earlier restores left chains one hop short.
      const n = flatten(standingChains);
      console.log(JSON_OUT
        ? JSON.stringify({ mode: 'revert-unjustified', count: 0, restored: 0, flattened: n, chains: standingChains }, null, 2)
        : `Restored 0 duplicateOf pointer(s); flattened ${n} chain pointer(s) behind earlier restores.`);
      process.exit(0);
    }
    if (unjustified.length === 0) {
      console.log(JSON_OUT
        ? JSON.stringify({ mode: 'revert-unjustified', count: 0, unjustified: [], chains: standingChains }, null, 2)
        : `Found ${standingChains.length} chain pointer(s) left one hop short behind an earlier restore.\n\nRun with --fix to re-aim them at the canonical.`);
      process.exit(1);
    }
    if (!FIX) {
      // Report-only: --json prints the machine-readable form, exit 1 = work pending.
      if (JSON_OUT) {
        console.log(JSON.stringify({ mode: 'revert-unjustified', count: unjustified.length, unjustified }, null, 2));
      } else {
        console.log(`Found ${unjustified.length} unjustified heal clear(s):\n`);
        for (const o of unjustified) {
          console.log(`  ${o.showId}`);
          console.log(`    ${o.loserFile}  cleared duplicateOf → ${o.targetFile} (target is NOT invalidated; URLs still match)`);
        }
        console.log('\nRun with --fix to restore these pointers.');
      }
      process.exit(1);
    }
    // Same reasoning as the --fix surge guard below: a spike in retractions
    // would mean the invalidation predicate itself moved, and re-suppressing
    // that many reviews at once deserves a human look first.
    if (unjustified.length > FIX_SURGE_THRESHOLD && !FORCE_BULK) {
      console.log(`Refusing to restore ${unjustified.length} pointer(s) — above FIX_SURGE_THRESHOLD (${FIX_SURGE_THRESHOLD}).`);
      console.log('Review the list with --revert-unjustified (no --fix), then re-run with --force-bulk to proceed.');
      process.exit(1);
    }
    const { restored, flattened } = revert(unjustified);
    if (JSON_OUT) {
      console.log(JSON.stringify({ mode: 'revert-unjustified', count: unjustified.length, restored, flattened, unjustified }, null, 2));
    } else {
      console.log(`Restored ${restored} duplicateOf pointer(s); flattened ${flattened} chain pointer(s) behind them.`);
      console.log('Re-run the rebuild so the re-suppressed duplicates drop back out of reviews.json.');
    }
    process.exit(0);
  }

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

module.exports = { audit, auditUnjustified, fix, revert, walkShowDirs, FIX_SURGE_THRESHOLD };
