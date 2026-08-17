#!/usr/bin/env node
/**
 * fix-canonical-duplicate-backpointer.js
 *
 * Repairs the duplicateTextOf half of the circular-duplicate class.
 * scripts/fix-circular-duplicate-pairs.js already repairs A.duplicateOf=B +
 * B.duplicateOf=A. It does NOT look at `duplicateTextOf`, so this shape survives:
 *
 *     loser.duplicateOf      = canonical      (correct — collapse this file)
 *     canonical.duplicateTextOf = loser       (STALE back-pointer — a mutual cycle)
 *
 * review-guards.js:2897 treats `duplicateTextOf` as a valid back-pointer, so the
 * pair is recognised as circular and resolved by content fingerprint: same text ->
 * keep the lexically-lower file; DIFFERENT text -> "legitimate separate reviews",
 * keep BOTH. That last branch is the trap. One scrape artifact on either side (a
 * Times quiz widget prepended to the canonical's fullText, 2026-08-17) makes the
 * fingerprints differ, both files land in reviews.json under one URL, and
 * validate-data.js fails the "one URL per outlet per show" gate — main goes red.
 *
 * Repair: delete the CANONICAL's back-pointer, leaving a clean one-way collapse.
 * Only the canonical is touched; the loser keeps pointing at it.
 *
 * Deliberately conservative:
 *  - only acts when the target of the back-pointer points back at this file, AND
 *    this file is the canonical (its own duplicateOf is empty)
 *  - never touches a file carrying humanReviewScore
 *  - --show=ID or --all required; --all also requires --yes (386 latent instances
 *    corpus-wide as of 2026-08-17, most benign — do not sweep them casually)
 *  - dry-run is the default; --apply writes
 *
 * Usage:
 *   node scripts/fix-canonical-duplicate-backpointer.js --show=ID
 *   node scripts/fix-canonical-duplicate-backpointer.js --show=ID --apply
 *   node scripts/fix-canonical-duplicate-backpointer.js --all --apply --yes
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  planCanonicalPointerClear,
  applyCanonicalPointerClear,
} = require('./lib/canonical-duplicate-pointers');

const RT = process.env.REVIEW_TEXTS_DIR || path.join(os.homedir(), 'broadway-review-texts');
const args = process.argv.slice(2);
const showFilter = (args.find((a) => a.startsWith('--show=')) || '').split('=')[1] || null;
const all = args.includes('--all');
const apply = args.includes('--apply');
const STAMP = process.env.FIX_STAMP || 'canonical-backpointer-repair';

if (!showFilter && !all) {
  console.error('Refusing to run unscoped. Pass --show=ID, or --all --yes for the full corpus.');
  process.exit(2);
}
if (all && !args.includes('--yes')) {
  console.error('--all rewrites every affected canonical corpus-wide. Re-run with --yes if that is intended.');
  process.exit(2);
}
if (!fs.existsSync(RT)) {
  console.error(`review-texts dir not found: ${RT}`);
  process.exit(2);
}

const pointerTargets = (d) => ['duplicateOf', 'duplicateTextOf']
  .map((k) => d && d[k])
  .filter((v) => typeof v === 'string' && v.endsWith('.json'));

const shows = (showFilter ? [showFilter] : fs.readdirSync(RT)).filter((d) => {
  if (d.startsWith('.') || d.startsWith('_')) return false;
  try { return fs.statSync(path.join(RT, d)).isDirectory(); } catch { return false; }
});

let found = 0;
let written = 0;
for (const show of shows) {
  const dir = path.join(RT, show);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
  const parsed = {};
  for (const f of files) {
    try { parsed[f] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* unreadable sibling */ }
  }

  for (const [self, data] of Object.entries(parsed)) {
    const back = data.duplicateTextOf;
    if (typeof back !== 'string' || !back.endsWith('.json')) continue;
    // This file must be the CANONICAL: not itself collapsed into something else.
    if (data.duplicateOf) continue;
    if (data.humanReviewScore != null) continue;
    const other = parsed[back];
    // The pointer must be part of a mutual cycle — a one-way syndication link is legitimate.
    if (!other || !pointerTargets(other).includes(self)) continue;

    found++;
    const plan = planCanonicalPointerClear(data, { self, clusterFiles: [back] });
    if (!plan.drop.length) continue;
    console.log(`${show}: ${self} —X-> ${back}  (drop ${plan.drop.join('+')})`);
    if (!apply) continue;

    const next = { ...data };
    // The push-restore breadcrumb: without duplicateClearReason the CI push action
    // reverts the clear (review-write-guard.js PROTECTED_FIELDS exception).
    next.duplicateClearReason = `canonical-backpointer-cleared: ${plan.reason} (${STAMP})`;
    if (!applyCanonicalPointerClear(next, plan)) continue;
    // Plain write, matching audit-review-url-clusters.js:126-131 — safeWriteReview's
    // URL-collision detector would immediately re-set the pointer we are clearing.
    fs.writeFileSync(path.join(dir, self), `${JSON.stringify(next, null, 2)}\n`);
    parsed[self] = next;
    written++;
  }
}

console.log(`\n${found} canonical back-pointer cycle(s) found; ${written} file(s) rewritten${apply ? '' : ' (dry-run — pass --apply to write)'}.`);
if (found && !apply) process.exitCode = 1;
