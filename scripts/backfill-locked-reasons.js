#!/usr/bin/env node
/**
 * backfill-locked-reasons.js
 *
 * One-time backfill: for every review-text file that has a hard
 * humanReviewScore lock but no `lockedReason`, set a default rationale +
 * lockedAt + lockedBy so the audit trail starts now (Lost Boys 2026-04-27
 * Gap #6).
 *
 * "Hard lock" = humanReviewScore is a number AND humanReviewScoreProvisional
 * is not true (matches scripts/lib/locks-index.js definition).
 *
 * Default rationale: 'pre-2026-04-27 (rationale not captured)'
 * Default lockedAt:  '2026-04-27T00:00:00.000Z'
 * Default lockedBy:  'backfill'
 *
 * Modes:
 *   default   — print the list of files that would be edited, write nothing.
 *   --commit  — actually write the lockedReason / lockedAt / lockedBy fields
 *               to disk. Pair with `git diff` in the data/review-texts
 *               submodule to verify, then commit + push manually.
 *   --show=ID — restrict to a single show id (e.g. --show=the-lost-boys-2026).
 *
 * Usage:
 *   node scripts/backfill-locked-reasons.js                    # dry run
 *   node scripts/backfill-locked-reasons.js --commit           # write
 *   node scripts/backfill-locked-reasons.js --show=the-lost-boys-2026 --commit
 */

const fs = require('fs');
const path = require('path');
const { scanLocks } = require('./lib/locks-index');

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const showFilter = (() => {
  const arg = args.find((a) => a.startsWith('--show='));
  return arg ? arg.slice('--show='.length) : null;
})();

const DEFAULT_REASON = 'pre-2026-04-27 (rationale not captured)';
// Sentinel pre-feature timestamp so backfilled rows DON'T match the
// "Locked in last 7 days" filter on /admin/locks. The actual locks landed at
// various times in the historical record; we don't have those timestamps.
// Using 2026-04-27 (the day of backfill) would drown the recent-locks view in
// 217 false-positive entries for ~7 days. 2024-01-01 is far enough back to
// stay out of any reasonable recency window.
const DEFAULT_LOCKED_AT = '2024-01-01T00:00:00.000Z';
const DEFAULT_LOCKED_BY = 'backfill';

// Resolve via cwd so the script works from a worktree (whose scripts/../data
// doesn't carry the symlink) or directly from main. Override with
// --review-texts-dir=/abs/path if needed.
const dirArg = args.find((a) => a.startsWith('--review-texts-dir='));
const reviewTextsDir = dirArg
  ? dirArg.slice('--review-texts-dir='.length)
  : path.resolve(process.cwd(), 'data', 'review-texts');
if (!fs.existsSync(reviewTextsDir)) {
  console.error(`✕ review-texts dir not found: ${reviewTextsDir}`);
  console.error(`  Run from the main repo (cd /Users/tompryor/Broadwayscore) or pass --review-texts-dir=/abs/path.`);
  process.exit(1);
}
const NEEDED_PF = ['lockedReason', 'lockedAt', 'lockedBy'];

function fileNeedsBackfill(filePath, lockRecord) {
  if (!lockRecord.hasRationale) return { reason: 'missing-rationale' };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
  // Even if rationale is present, ensure per-file protectedFields pins the
  // lock-trail fields. Necessary during the worktree → main transition window
  // when the global PROTECTED_FIELDS list on main may not include them yet.
  const pf = Array.isArray(data.protectedFields) ? data.protectedFields : [];
  const missing = NEEDED_PF.filter((f) => !pf.includes(f));
  if (missing.length > 0) return { reason: 'missing-pf', missing };
  // Stale-sentinel correction: prior backfill wrote lockedAt=2026-04-27 which
  // collided with the "Locked in last 7 days" UI filter. Ship-check P1.
  if (
    data.lockedBy === 'backfill' &&
    data.lockedAt === '2026-04-27T00:00:00.000Z' &&
    DEFAULT_LOCKED_AT !== '2026-04-27T00:00:00.000Z'
  ) {
    return { reason: 'stale-sentinel-lockedAt' };
  }
  return null;
}

const allLocks = scanLocks(reviewTextsDir);
const targets = [];
for (const l of allLocks) {
  if (showFilter && l.showId !== showFilter) continue;
  const filePath = path.join(reviewTextsDir, l.showId, l.filename);
  const need = fileNeedsBackfill(filePath, l);
  if (need) targets.push({ ...l, _need: need });
}

const missingRationale = targets.filter((t) => t._need.reason === 'missing-rationale').length;
const missingPF = targets.filter((t) => t._need.reason === 'missing-pf').length;
const staleSentinel = targets.filter((t) => t._need.reason === 'stale-sentinel-lockedAt').length;
console.log(`🔍 ${allLocks.length} total hard locks; ${targets.length} need backfill${showFilter ? ` (filtered to ${showFilter})` : ''}.`);
console.log(`    - ${missingRationale} missing rationale`);
console.log(`    - ${missingPF} have rationale but missing protectedFields entries`);
console.log(`    - ${staleSentinel} have stale-sentinel lockedAt (2026-04-27 → ${DEFAULT_LOCKED_AT})`);
if (targets.length === 0) {
  console.log('✅ Nothing to backfill.');
  process.exit(0);
}

console.log('');
console.log(`First 20 targets:`);
targets.slice(0, 20).forEach((t) => {
  console.log(`  - ${t.showId} / ${t.outletId} / ${t.criticName} (locked at ${t.lockedScore})`);
});
if (targets.length > 20) console.log(`  ... and ${targets.length - 20} more.`);
console.log('');

if (!COMMIT) {
  console.log('Dry run — no files written. Re-run with --commit to apply.');
  process.exit(0);
}

let written = 0;
let failed = 0;
for (const t of targets) {
  const filePath = path.join(reviewTextsDir, t.showId, t.filename);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error(`✕ ${filePath}: read/parse failed (${err.message})`);
    failed++;
    continue;
  }

  // Only set defaults when actually missing — don't overwrite real lockedAt
  // values from the lock-score endpoint or earlier backfills.
  if (typeof data.lockedReason !== 'string' || !data.lockedReason.trim()) {
    data.lockedReason = DEFAULT_REASON;
  }
  if (typeof data.lockedAt !== 'string') {
    data.lockedAt = DEFAULT_LOCKED_AT;
  }
  if (typeof data.lockedBy !== 'string') {
    data.lockedBy = DEFAULT_LOCKED_BY;
  }
  // One-shot correction (ship-check 2026-04-27 P1 #1): an earlier backfill
  // wrote lockedAt='2026-04-27T00:00:00.000Z' which collided with the
  // /admin/locks "Locked in last 7 days" filter and drowned the recent-locks
  // view in 217 false-positive sentinel entries. Migrate those rows to the
  // new pre-feature sentinel so the filter behaves correctly. Detected by:
  // lockedBy='backfill' AND lockedAt='2026-04-27T00:00:00.000Z'.
  if (
    data.lockedBy === 'backfill' &&
    data.lockedAt === '2026-04-27T00:00:00.000Z' &&
    DEFAULT_LOCKED_AT !== '2026-04-27T00:00:00.000Z'
  ) {
    data.lockedAt = DEFAULT_LOCKED_AT;
  }

  // Always pin the lock-trail fields in per-file protectedFields. The global
  // PROTECTED_FIELDS list also lists them, but until that worktree edit ships
  // to main, any push-review-texts run on the older code would silently drop
  // these fields. Per-file protection is the belt-and-braces (cf. Beaches
  // 2026-04-22 incident in feedback_per_file_protected_fields_lock.md).
  const need = ['lockedReason', 'lockedAt', 'lockedBy'];
  const prior = Array.isArray(data.protectedFields) ? data.protectedFields : [];
  data.protectedFields = Array.from(new Set([...prior, ...need]));

  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    written++;
  } catch (err) {
    console.error(`✕ ${filePath}: write failed (${err.message})`);
    failed++;
  }
}

console.log('');
console.log(`✅ Wrote ${written} files. ${failed} failed.`);
console.log('');
console.log('Next steps:');
console.log('  1. cd data/review-texts && git status      # confirm the diff');
console.log('  2. cd data/review-texts && git add -A && git commit -m "data: backfill lockedReason for pre-2026-04-27 manual locks"');
console.log('  3. cd data/review-texts && git push');
console.log('  4. gh workflow run "Rebuild Reviews (Fast)"   # regenerate locks.json + reviews.json');
