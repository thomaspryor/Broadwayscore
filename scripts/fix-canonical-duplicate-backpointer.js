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
const path = require('path');
const {
  planCanonicalPointerClear,
  applyCanonicalPointerClear,
} = require('./lib/canonical-duplicate-pointers');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');

// WHICH CLONE. Two review-texts checkouts exist on a dev machine: the nested
// data/review-texts the repo actually reads (validate-review-texts.js,
// review-guards.js, autonomous-data-workdir.js:39 all resolve there), and a
// legacy ~/broadway-review-texts that several older scripts still default to.
// On 2026-08-17 those two were 143+ commits apart. This script WRITES, so
// defaulting to the legacy clone means silently repairing the wrong copy and
// reporting success — it found a cycle in the stale clone that had already been
// fixed in the real one. Prefer the repo's own checkout, fall back to the legacy
// path, and always PRINT the directory so the target is never ambiguous.
const RT = resolveReviewTextsDir();
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
console.log(`[fix-canonical-duplicate-backpointer] review-texts: ${RT}`);

const pointerTargets = (d) => ['duplicateOf', 'duplicateTextOf']
  .map((k) => d && d[k])
  .filter((v) => typeof v === 'string' && v.endsWith('.json'));

// A named --show that is not present under RT is a WRONG-CORPUS error, never
// "no cycles". Without this, filtering a missing dir away left shows=[] and the
// run printed "0 canonical back-pointer cycle(s) found" and exited 0 — making a
// wrong/empty/stale target indistinguishable from a clean corpus (code review,
// 2026-08-17). Silence is the failure mode this whole change exists to remove.
if (showFilter) {
  let ok = false;
  try { ok = fs.statSync(path.join(RT, showFilter)).isDirectory(); } catch { ok = false; }
  if (!ok) {
    console.error(`ERROR: show '${showFilter}' not found under ${RT}. Wrong review-texts checkout, or a typo — refusing to report a clean result for a corpus this tool cannot see.`);
    process.exit(2);
  }
}

const shows = (showFilter ? [showFilter] : fs.readdirSync(RT)).filter((d) => {
  if (d.startsWith('.') || d.startsWith('_')) return false;
  try { return fs.statSync(path.join(RT, d)).isDirectory(); } catch { return false; }
});

// A full-corpus run over an empty/near-empty tree is the same failure wearing a
// different hat: report it instead of exiting 0 with a reassuring zero.
if (!shows.length) {
  console.error(`ERROR: no show directories under ${RT} — that is an empty or wrong review-texts checkout, not a clean corpus.`);
  process.exit(2);
}

let found = 0;
let written = 0;
for (const show of shows) {
  const dir = path.join(RT, show);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
  const parsed = {};
  const rawAtScan = {};
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      parsed[f] = JSON.parse(raw);
      rawAtScan[f] = raw; // exact bytes, for the compare-and-swap below
    } catch { /* unreadable sibling */ }
  }

  for (const [self, data] of Object.entries(parsed)) {
    const back = data.duplicateTextOf;
    if (typeof back !== 'string' || !back.endsWith('.json')) continue;
    // This file must be the CANONICAL: not itself collapsed into something else.
    if (data.duplicateOf) continue;
    if (data.humanReviewScore != null) continue;
    // Never touch a file a human or another process has locked. safeWriteReview
    // enforces this for normal writes; this script writes plainly (see below), so
    // it has to enforce it itself.
    if (data._locked) continue;
    const other = parsed[back];
    // The pointer must be part of a mutual cycle — a one-way syndication link
    // (same text, DIFFERENT url) is a legitimate claim and must survive.
    if (!other || !pointerTargets(other).includes(self)) continue;
    // Belt and braces: only collapse pointers between files PROVEN to share a url.
    // Cross-url duplicateTextOf is syndication, never a byline-explosion artifact,
    // and a missing url on either side is not proof of anything — require both.
    if (!data.url || !other.url || data.url !== other.url) continue;

    found++;
    const plan = planCanonicalPointerClear(data, { self, clusterFiles: [back], siblings: parsed });
    if (!plan.drop.length) continue;
    console.log(`${show}: ${self} —X-> ${back}  (drop ${plan.drop.join('+')})`);
    if (!apply) continue;

    const target = path.join(dir, self);
    // Compare-and-swap. The scan above is a snapshot, and CI rebuilds/collects into
    // this same tree every ~30 min; a whole-object write from a stale read would
    // silently clobber a score or fullText written since. Compare against the EXACT
    // bytes read at scan time — re-serialising `data` instead would false-negative
    // on any file whose on-disk key order or whitespace differs from ours, silently
    // refusing to repair it.
    let onDisk;
    try { onDisk = fs.readFileSync(target, 'utf8'); } catch { onDisk = null; }
    if (onDisk === null || onDisk !== rawAtScan[self]) {
      console.log(`  skipped ${self}: changed on disk since the scan (re-run to pick it up)`);
      continue;
    }

    const next = { ...data };
    // The push-restore breadcrumb: without duplicateClearReason a later
    // safeWriteReview(merge) would fold the old pointer back in
    // (review-write-guard.js:586).
    next.duplicateClearReason = `canonical-backpointer-cleared: ${plan.reason} (${STAMP})`;
    if (!applyCanonicalPointerClear(next, plan)) continue;
    // Plain write, matching audit-review-url-clusters.js:126-131 — safeWriteReview's
    // URL-collision detector would immediately re-set the pointer we are clearing.
    fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
    parsed[self] = next;
    written++;
  }
}

console.log(`\n${found} canonical back-pointer cycle(s) found; ${written} file(s) rewritten${apply ? '' : ' (dry-run — pass --apply to write)'}.`);
if (found && !apply) process.exitCode = 1;
