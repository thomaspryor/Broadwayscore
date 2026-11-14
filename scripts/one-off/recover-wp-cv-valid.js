#!/usr/bin/env node
/**
 * recover-wp-cv-valid.js
 *
 * Reads /tmp/wp-audit.json (produced by audit-wp-cv-valid.js) and applies the
 * recovery pattern from sweep-revival-wrong-production.js to HIGH-confidence
 * candidates.
 *
 * A HIGH candidate has:
 *   - wrongProduction=true
 *   - contentVerification explicitly says isValid=true (no wrongArticle, no
 *     wrongProduction, no isFilmTv)
 *   - No diagnostic reason recorded anywhere (generic 'wrong_content' / 'Wrong
 *     production' / 'Full review text' only)
 *   - Text mentions at least one show keyword
 *   - URL slug contains a significant show title token
 *   - publishDate OR URL year falls within the show's strict run window
 *   - For revival titles (canonical title shared with another show), the
 *     keyword must be more specific than the bare title, OR both pubYear and
 *     URL year agree
 *
 * What this script does for each HIGH file:
 *   - delete wrongProduction (legacy guard was wrong — CV already validated)
 *   - delete wrongProductionNote, wrongProductionReason
 *   - clear contentVerification.wrongProduction if stale true
 *   - clear incompleteReason / incompleteDetail if generic 'wrong_content'
 *   - clear contentTier if 'invalid' (let rebuild recompute)
 *   - clear contentTierReason if 'Wrong production' / 'Full review text'
 *   - set wrongProductionManualClear = descriptive string (nuclear guard)
 *   - set humanReviewedWrongProduction = false (belt-and-suspenders)
 *
 * Idempotent. Writes to files only in --apply mode.
 *
 * Usage:
 *   node scripts/one-off/recover-wp-cv-valid.js                 — dry run
 *   node scripts/one-off/recover-wp-cv-valid.js --apply         — write
 *   node scripts/one-off/recover-wp-cv-valid.js --show=SLUG     — single show
 *   node scripts/one-off/recover-wp-cv-valid.js --bucket=HIGH   — default HIGH
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const showFilter = (argv.find(a => a.startsWith('--show=')) || '').split('=')[1] || null;
const bucket = ((argv.find(a => a.startsWith('--bucket=')) || '').split('=')[1] || 'HIGH').toUpperCase();

const ROOT = path.join(__dirname, '..', '..');
const REVIEW_ROOT = path.join(ROOT, 'data', 'review-texts');
const AUDIT_PATH = '/tmp/wp-audit.json';

if (!fs.existsSync(AUDIT_PATH)) {
  console.error(`Missing audit file: ${AUDIT_PATH}`);
  console.error(`Run: node scripts/one-off/audit-wp-cv-valid.js --json=${AUDIT_PATH}`);
  process.exit(1);
}

const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
const candidates = (audit[bucket] || []).filter(c => !showFilter || c.showId === showFilter);

console.log(`=== recover-wp-cv-valid (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
console.log(`Bucket: ${bucket}`);
console.log(`Candidates: ${candidates.length}${showFilter ? ' (filtered to ' + showFilter + ')' : ''}`);
console.log('');

const CLEAR_MSG = 'Auto-recovered 2026-04-11: CV isValid=true, keyword+URL+year match, no diagnostic reason recorded (legacy guard stamped wrongProduction without a reason)';

const GENERIC_INCOMPLETE_REASONS = new Set(['wrong_content', 'partial_text']);
const GENERIC_TIER_REASONS = new Set(['Wrong production', 'Full review text']);
const GENERIC_INCOMPLETE_DETAILS = new Set(['Wrong production']);

const stats = {
  recovered: 0,
  alreadyClean: 0,
  skipped: 0,
  errors: [],
};
const perShow = {};

for (const c of candidates) {
  const fpath = path.join(REVIEW_ROOT, c.showId, c.file);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  } catch (e) {
    stats.errors.push({ path: c.path, error: e.message });
    continue;
  }

  // Safety re-check (defence against audit drift). If the file has become
  // safe or the CV state has changed since the audit ran, skip.
  if (data.wrongProduction !== true) {
    stats.alreadyClean++;
    continue;
  }
  const cv = data.contentVerification;
  if (!cv || cv.isValid !== true || cv.wrongProduction === true || cv.wrongArticle === true) {
    stats.skipped++;
    continue;
  }
  if (data.wrongShow === true) {
    stats.skipped++;
    continue;
  }
  // Don't touch files where a human has actively marked wrongProduction true.
  if (data.humanReviewedWrongProduction === true) {
    stats.skipped++;
    continue;
  }

  const mutations = [];

  // 1. Clear the wrongProduction flag family.
  if (data.wrongProduction === true) {
    mutations.push('delete wrongProduction');
    if (APPLY) delete data.wrongProduction;
  }
  if (data.wrongProductionNote !== undefined) {
    mutations.push('delete wrongProductionNote');
    if (APPLY) delete data.wrongProductionNote;
  }
  if (data.wrongProductionReason !== undefined) {
    mutations.push('delete wrongProductionReason');
    if (APPLY) delete data.wrongProductionReason;
  }

  // 2. Clear stale CV sub-flag if it's echoing wrongProduction even though
  //    isValid=true was the real verdict.
  if (cv && cv.wrongProduction === true) {
    mutations.push('clear cv.wrongProduction (stale)');
    if (APPLY) delete data.contentVerification.wrongProduction;
  }

  // 3. Clear generic incompleteReason/Detail that echoed the flag.
  if (data.incompleteReason && GENERIC_INCOMPLETE_REASONS.has(data.incompleteReason)) {
    mutations.push(`clear incompleteReason (${data.incompleteReason})`);
    if (APPLY) delete data.incompleteReason;
  }
  if (data.incompleteDetail && GENERIC_INCOMPLETE_DETAILS.has(data.incompleteDetail)) {
    mutations.push(`clear incompleteDetail (${data.incompleteDetail})`);
    if (APPLY) delete data.incompleteDetail;
  }

  // 4. Clear stale contentTier=invalid + contentTierReason so rebuild recomputes.
  if (data.contentTier === 'invalid') {
    mutations.push('clear contentTier=invalid');
    if (APPLY) delete data.contentTier;
  }
  if (data.contentTierReason && GENERIC_TIER_REASONS.has(data.contentTierReason)) {
    mutations.push(`clear contentTierReason (${data.contentTierReason})`);
    if (APPLY) delete data.contentTierReason;
  }
  if (data.tierReason && GENERIC_TIER_REASONS.has(data.tierReason)) {
    mutations.push(`clear tierReason (${data.tierReason})`);
    if (APPLY) delete data.tierReason;
  }

  // 5. Nuclear-guard protection fields (prevent re-flagging on next rebuild).
  if (data.wrongProductionManualClear !== CLEAR_MSG) {
    mutations.push('set wrongProductionManualClear');
    if (APPLY) data.wrongProductionManualClear = CLEAR_MSG;
  }
  if (data.humanReviewedWrongProduction !== false) {
    mutations.push('set humanReviewedWrongProduction=false');
    if (APPLY) data.humanReviewedWrongProduction = false;
  }

  if (mutations.length === 0) {
    stats.alreadyClean++;
    continue;
  }

  if (APPLY) {
    try {
      fs.writeFileSync(fpath, JSON.stringify(data, null, 2) + '\n');
    } catch (e) {
      stats.errors.push({ path: c.path, error: e.message });
      continue;
    }
  }

  stats.recovered++;
  perShow[c.showId] = (perShow[c.showId] || 0) + 1;
}

console.log(`--- Summary (${APPLY ? 'APPLIED' : 'DRY-RUN'}) ---`);
console.log(`  Recovered:     ${stats.recovered}`);
console.log(`  Already clean: ${stats.alreadyClean}`);
console.log(`  Skipped:       ${stats.skipped}`);
console.log(`  Errors:        ${stats.errors.length}`);
if (stats.errors.length > 0) {
  for (const e of stats.errors) console.log(`    ERR ${e.path}: ${e.error}`);
}

console.log('');
console.log(`--- Recovered per-show (${Object.keys(perShow).length} shows) ---`);
const sorted = Object.entries(perShow).sort((a, b) => b[1] - a[1]);
for (const [show, n] of sorted) console.log(`  ${n}  ${show}`);

if (!APPLY) {
  console.log('');
  console.log('Dry run complete. Re-run with --apply to write changes.');
}
