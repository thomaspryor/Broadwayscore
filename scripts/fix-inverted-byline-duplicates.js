#!/usr/bin/env node
/**
 * fix-inverted-byline-duplicates.js — BRO-3409
 *
 * BRO-3247 fixed the MECHANISM that let same-url-dedup crown a phantom
 * byline over a real one (chooseCanonical's byline-attestation tiebreak,
 * fix-circular-duplicate-pairs.js:267). It only ever ran on MUTUAL
 * (circular) duplicateOf pairs, and only going forward. This script sweeps
 * the ONE-DIRECTIONAL shape the mechanism fix can't reach: fileA.duplicateOf
 * = fileB, sharing fileB's url, but fileB does NOT point back at fileA (so
 * fix-circular-duplicate-pairs.js's audit() — which requires `sd.duplicateOf
 * === file` — silently skips it). Some of these are stale phantom-byline
 * inversions from before the mechanism fix: the suppressed file's byline is
 * printed in its own article text, the surviving "canonical" file's is not.
 *
 * Reuses isClassAContaminated from fix-circular-duplicate-pairs.js for the
 * cross-market safety gate, but does NOT reuse chooseCanonicalForRebuild's
 * full tiebreak: that function's 2c step also requires the LOSING byline be
 * absent from BOTH copies' text (_nameAppearsAnywhere), which is deliberately
 * strict because it drives an UNSUPERVISED daily cron with no human review.
 * A truncated phantom is often a strict substring of the real name (e.g.
 * "John Mackin" inside "Joshua John Mackin") and so trips that reprieve —
 * exactly the amazing-grace-2015 case this card exists to fix. This script
 * instead applies the plain per-file isBylineAttestedInText check the issue
 * specifies, gated only on cross-market safety and same-critic exclusion,
 * because every candidate here gets an individual fullText read before
 * --fix touches it (see the session's verification pass), not blind cron
 * trust.
 *
 * Same-critic-different-outlet-slug pairs (e.g. a cross-posted article under
 * two outlet aliases) are excluded up front: that is an outlet-registry
 * merge case, not a phantom byline, and flag-and-keep on that shape has bit
 * us before (memory/feedback_outlet_merge_no_flag_and_keep.md).
 *
 * Repair, mirroring the Safe House hand-fix (broadway-review-texts
 * 8f02a804c39): the real review's duplicateOf is cleared WITH a
 * duplicateClearReason breadcrumb (the push-restore exception —
 * review-write-guard.js CLEAR_BREADCRUMBS.duplicateOf — without which the
 * next push reverts the clear); the phantom gets duplicateOf repointed at
 * the real review. Both written with force:true — same URL, so a plain
 * safeWriteReview() would re-fire the URL-collision detector.
 *
 * Usage:
 *   node scripts/fix-inverted-byline-duplicates.js            # report (exit 1 if any)
 *   node scripts/fix-inverted-byline-duplicates.js --json     # JSON report
 *   node scripts/fix-inverted-byline-duplicates.js --fix      # repair in place
 *   REVIEW_TEXTS_DIR=/path SHOWS_JSON=/path node scripts/... [--fix]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { isBylineAttestedInText, normalizeForAttestation } = require('./lib/byline-attestation');
const {
  bylineSlug, showsDataAvailable, isClassAContaminated,
} = require('./fix-circular-duplicate-pairs');

const USAGE = `fix-inverted-byline-duplicates.js — BRO-3409: repairs stale one-directional
duplicateOf pointers where the suppressed file's byline is attested in its own
text and the surviving canonical's is not.

Usage:
  node scripts/fix-inverted-byline-duplicates.js [options]
  node scripts/fix-inverted-byline-duplicates.js --help, -h    print this usage and exit
`;

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const NON_SHOW_DIRS = new Set(['_pending', '_superseded-misattributed']);

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const JSON_OUT = args.includes('--json');

function isShowDir(name) {
  return !name.startsWith('.') && !NON_SHOW_DIRS.has(name);
}

function walkShowDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && isShowDir(e.name))
    .map(e => path.join(root, e.name));
}

/**
 * Same critic on both sides — either the filename byline slug matches, or
 * the (normalized) criticName field matches. Either signal alone is enough:
 * a cross-posted article can carry the same slug with a differently-cased
 * criticName field, or vice versa.
 */
function sameCritic(aName, aData, bName, bData) {
  const aSlug = bylineSlug(aName), bSlug = bylineSlug(bName);
  if (aSlug && aSlug === bSlug) return true;
  const an = normalizeForAttestation(aData && aData.criticName);
  const bn = normalizeForAttestation(bData && bData.criticName);
  return !!an && an === bn;
}

let _skippedSameCritic = [];

/** Find one-directional duplicateOf pointers that are confirmed byline inversions. */
function audit() {
  const results = [];
  _skippedSameCritic = [];
  for (const showDir of walkShowDirs(REVIEW_TEXTS_DIR)) {
    let files;
    try {
      files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json' && !f.startsWith('_'));
    } catch { continue; }
    const cache = {};
    const load = (name) => {
      if (name in cache) return cache[name];
      try { cache[name] = JSON.parse(fs.readFileSync(path.join(showDir, name), 'utf-8')); }
      catch { cache[name] = null; }
      return cache[name];
    };
    for (const file of files) {
      const d = load(file);
      if (!d || typeof d.duplicateOf !== 'string' || !d.duplicateOf.endsWith('.json')) continue;
      const target = d.duplicateOf;
      if (target === file) continue; // self-ref: handled by review-write-guard's self-heal
      const td = load(target);
      if (!td) continue; // dangling pointer: handled by audit-duplicate-of-url-mismatch.js
      if (td.duplicateOf === file) continue; // mutual pair: fix-circular-duplicate-pairs.js's territory
      if (!d.url || !td.url || d.url !== td.url) continue; // only this bug's shape: shared-url pairs

      if (sameCritic(file, d, target, td)) {
        _skippedSameCritic.push({ showId: path.basename(showDir), suppressed: file, canonical: target, url: d.url });
        continue;
      }

      // Cross-market safety gate (shared with fix-circular-duplicate-pairs.js):
      // never canonicalize a class-A contaminated member, whichever side it's on.
      const showId = path.basename(showDir);
      if (isClassAContaminated(d, showId) || isClassAContaminated(td, showId)) continue;

      const suppressedAttested = isBylineAttestedInText(d.criticName, d.fullText);
      const canonicalAttested = isBylineAttestedInText(td.criticName, td.fullText);
      if (!suppressedAttested || canonicalAttested) continue; // not the phantom-byline shape

      results.push({
        showId,
        newCanonical: file,
        newLoser: target,
        reason: `suppressed byline "${d.criticName}" attested in its own text; canonical byline "${td.criticName}" is not`,
        url: d.url,
      });
    }
  }
  return results;
}

function fix(pairs) {
  let flipped = 0;
  const day = new Date().toISOString().slice(0, 10);
  for (const p of pairs) {
    const dir = path.join(REVIEW_TEXTS_DIR, p.showId);
    const newCanonPath = path.join(dir, p.newCanonical);
    const newLoserPath = path.join(dir, p.newLoser);

    // --- Real review: clear duplicateOf. LOAD-MODIFY-SAVE the full object. ---
    const nc = JSON.parse(fs.readFileSync(newCanonPath, 'utf-8'));
    nc.duplicateClearReason =
      `BRO-3409 (${day}): inverted duplicateOf repaired — this file's byline is attested in its own article text; ${p.newLoser}'s is not. Was incorrectly duplicateOf ${p.newLoser}, a stale pre-BRO-3247 same-url-dedup inversion.`;
    nc.duplicateOf = null;
    nc.duplicateReason = null;
    // force:true — the phantom shares this file's url, so a non-forced write
    // would re-fire review-write-guard's URL-collision detector and re-mark
    // us a duplicate.
    safeWriteReview(newCanonPath, nc, { force: true });

    // --- Phantom byline: repoint duplicateOf at the real review. ---
    const nl = JSON.parse(fs.readFileSync(newLoserPath, 'utf-8'));
    nl.duplicateOf = p.newCanonical;
    nl.duplicateReason =
      `BRO-3409 (${day}): repointed by fix-inverted-byline-duplicates.js — ${p.newCanonical}'s byline is attested in its own article text and this file's is not (same url). ${p.newCanonical} is now canonical.`;
    nl.duplicateClearReason = null;
    safeWriteReview(newLoserPath, nl, { force: true });

    flipped++;
  }
  return flipped;
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const pairs = audit();
  const skipped = _skippedSameCritic.length;
  if (JSON_OUT) {
    console.log(JSON.stringify({ count: pairs.length, pairs, skippedSameCritic: skipped, skippedSameCriticPairs: _skippedSameCritic }, null, 2));
    process.exit(pairs.length === 0 ? 0 : 1);
  }
  if (skipped) {
    console.log(`(${skipped} same-critic outlet-slug pair(s) excluded — outlet-merge case, not a phantom byline)\n`);
    for (const s of _skippedSameCritic) {
      console.log(`  skip (same critic): ${s.showId} — ${s.suppressed} / ${s.canonical}`);
    }
    console.log('');
  }
  if (pairs.length === 0) {
    console.log('OK: no confirmed inverted byline duplicateOf pointers found');
    process.exit(0);
  }
  console.log(`Found ${pairs.length} confirmed inverted duplicateOf pair(s):\n`);
  for (const p of pairs) {
    console.log(`  ${p.showId}`);
    console.log(`    real review (byline attested), becomes canonical: ${p.newCanonical}`);
    console.log(`    phantom byline, becomes duplicateOf: ${p.newLoser}`);
  }
  if (FIX) {
    // Fail-closed: chooseCanonicalForRebuild's cross-market guard is inert
    // without shows.json — same refusal as fix-circular-duplicate-pairs.js.
    if (!showsDataAvailable()) {
      console.error('\n❌ REFUSING --fix: shows.json (core-data) could not be loaded, so the cross-market class-A canonical guard is inert. Check out core-data (shows.json) and retry.');
      process.exit(1);
    }
    const n = fix(pairs);
    console.log(`\nFlipped ${n} pair(s).`);
    console.log('Re-run the rebuild to collapse each pair to its new canonical.');
    process.exit(0);
  }
  console.log('\nRun with --fix to repair.');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { audit, fix, sameCritic, walkShowDirs };
