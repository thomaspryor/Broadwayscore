#!/usr/bin/env node
/**
 * audit-duplicate-flag-inheritance.js
 *
 * Detector for task #1256: finds review-text files with `duplicateOf` set
 * whose referenced twin carries an uncleared content-wrongness flag
 * (wrongShow / wrongProduction / isNonReview) that rebuild-all-reviews.js's
 * duplicateOf-recovery path does NOT propagate onto them
 * (duplicateOfInheritedFlag() in scripts/lib/review-guards.js returns
 * non-null) — AND are currently LIVE in data/reviews.json.
 *
 * NOT isScoreable/isIncludableForRebuild: isScoreable(A) is already false
 * whenever A.duplicateOf is set and a clean sibling exists (see
 * review-guards.js explainExclusion's own duplicateOf branch) — that is true
 * for BOTH the good case (a legitimately different review whose twin's flag
 * is stale) and the bad case (a second copy of the twin's bad content).
 * isScoreable cannot tell which of these candidates are actually live wrong
 * content right now — only reviews.json (what actually shipped) can.
 *
 * Usage:
 *   node scripts/audit-duplicate-flag-inheritance.js          # report, exit 1 on regression past floor
 *   node scripts/audit-duplicate-flag-inheritance.js --json   # machine-readable output
 *
 * Exit codes: 0 = count <= committed floor (or no floor pinned yet), 1 = regression past floor
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { duplicateOfInheritedFlag } = require('./lib/review-guards');
const { normalizeUrl } = require('./lib/review-normalization');
const { computeContentFingerprint } = require('./lib/content-quality');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');

// Both pointer fields carry the same class of bug (rebuild-all-reviews.js
// has two structurally-similar handling blocks, one per field — task #1256
// ship-check finding). refKey is what rebuild-all-reviews.js actually reads
// as the sibling filename for each.
const POINTER_FIELDS = ['duplicateOf', 'duplicateTextOf'];

const USAGE = `audit-duplicate-flag-inheritance.js — finds duplicateOf files whose flagged twin's content-wrongness flag isn't inherited, live in reviews.json.

Usage:
  node scripts/audit-duplicate-flag-inheritance.js [options]
  node scripts/audit-duplicate-flag-inheritance.js --help, -h    print this usage and exit

Options:
  --json     machine-readable output (still exits 1 on regression past the committed floor)

Env overrides (for running against a data checkout outside this worktree):
  REVIEW_TEXTS_DIR, SHOWS_JSON_PATH, REVIEWS_JSON_PATH
`;

if (hasHelpFlag(process.argv)) {
  console.log(USAGE);
  process.exit(0);
}

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_JSON_PATH = process.env.SHOWS_JSON_PATH || path.join(__dirname, '..', 'data', 'shows.json');
const REVIEWS_JSON_PATH = process.env.REVIEWS_JSON_PATH || path.join(__dirname, '..', 'data', 'reviews.json');
const FLOOR_PATH = path.join(__dirname, '.duplicate-flag-inheritance-floor.json');

const JSON_OUT = process.argv.includes('--json');

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function main() {
  const shows = loadJson(SHOWS_JSON_PATH, []);
  const showsById = {};
  for (const s of Array.isArray(shows) ? shows : Object.values(shows)) {
    if (s && s.id) showsById[s.id] = s;
  }

  const reviewsRaw = loadJson(REVIEWS_JSON_PATH, null);
  if (reviewsRaw === null) {
    console.error(`::error::cannot read ${REVIEWS_JSON_PATH} — liveness cannot be checked. Set REVIEWS_JSON_PATH to override.`);
    process.exitCode = 1;
    return;
  }
  const allReviews = Array.isArray(reviewsRaw) ? reviewsRaw : Object.values(reviewsRaw).flat();

  // Live-URL index per show, so each candidate's liveness check is O(1).
  const liveUrlsByShow = new Map();
  for (const r of allReviews) {
    if (!r || !r.showId || !r.url) continue;
    let set = liveUrlsByShow.get(r.showId);
    if (!set) { set = new Set(); liveUrlsByShow.set(r.showId, set); }
    let norm;
    try { norm = normalizeUrl(r.url); } catch { norm = r.url; }
    set.add(norm);
  }

  const candidates = [];
  let scanned = 0;
  for (const showId of listShowDirs(REVIEW_TEXTS_DIR)) {
    // `_`-prefixed dirs are staging/sentinel, not real shows (same convention
    // as silent-exclusion-detectors.js and other audits).
    if (showId.startsWith('_')) continue;
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try {
      files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }
      scanned++;

      for (const pointerField of POINTER_FIELDS) {
      const pointer = data[pointerField];
      if (!pointer || !pointer.endsWith('.json')) continue;

      const refPath = path.join(showDir, pointer);
      let refData;
      try {
        refData = JSON.parse(fs.readFileSync(refPath, 'utf8'));
      } catch {
        continue; // stale/missing pointer — not a candidate (rebuild keeps this file already)
      }

      const show = showsById[showId];
      const inheritedFlag = duplicateOfInheritedFlag(data, refData, show, refPath);
      if (!inheritedFlag) continue;

      // Mirror rebuild-all-reviews.js's circular-different-text carve-out
      // (task #1256 ship-check finding): a mutual circular pair with
      // CONFIRMED different text is the legitimate-separate-reviews case,
      // and must not be reported as a leak here either — otherwise this
      // detector's floor drifts out of sync with what the fixed rebuild
      // pipeline actually excludes.
      const isCircular = refData[pointerField] === file
        || refData.duplicateOf === file || refData.duplicateTextOf === file;
      let circularSameText = false;
      if (isCircular && data.fullText && refData.fullText) {
        const a = computeContentFingerprint(data.fullText);
        const b = computeContentFingerprint(refData.fullText);
        circularSameText = !!(a && b && a === b);
      }
      if (isCircular && !circularSameText) continue;

      if (!data.url) continue;
      let normUrl;
      try { normUrl = normalizeUrl(data.url); } catch { normUrl = data.url; }
      const liveSet = liveUrlsByShow.get(showId);
      if (!liveSet || !liveSet.has(normUrl)) continue; // not live today — not what this detector tracks

      candidates.push({
        showId,
        file,
        pointerField,
        duplicateOf: pointer,
        inheritedFlag,
        url: data.url,
        outletId: data.outletId || data.outlet || null,
        criticName: data.criticName || null,
      });
      } // end for (pointerField)
    } // end for (file)
  } // end for (showId)

  try {
    assertCorpusScanned(scanned, { gate: true, label: REVIEW_TEXTS_DIR });
  } catch (e) {
    if (e instanceof CorpusNotScannedError) {
      console.error(`::error::${e.message}`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  const pin = loadJson(FLOOR_PATH, null);
  const floor = pin && typeof pin.floor === 'number' ? pin.floor : null;

  if (JSON_OUT) {
    console.log(JSON.stringify({ scanned, count: candidates.length, floor, candidates }, null, 2));
  } else {
    console.log(`Scanned ${scanned} review-text files.`);
    console.log(`Found ${candidates.length} live duplicate-of-inherited-flag leak(s) (floor: ${floor === null ? 'unset' : floor}).`);
    for (const c of candidates.slice(0, 50)) {
      console.log(`  ${c.showId}/${c.file} -> duplicateOf ${c.duplicateOf} (${c.inheritedFlag}) url=${c.url}`);
    }
    if (candidates.length > 50) console.log(`  ... and ${candidates.length - 50} more`);
  }

  if (floor === null) {
    console.error('::warning::no committed floor at scripts/.duplicate-flag-inheritance-floor.json — treating as unbounded (pass). Seed one to make this a real gate.');
    return;
  }
  if (candidates.length > floor) {
    console.error(`::error::duplicate-flag-inheritance count regressed: ${candidates.length} > committed floor ${floor}. Either a new live leak was introduced (fix it), or the floor needs a deliberate, evidenced update (bump scripts/.duplicate-flag-inheritance-floor.json in the same change, with evidenceFile pointing at the measurement).`);
    process.exitCode = 1;
  } else if (!JSON_OUT) {
    // --json mode's stdout is machine-readable output (piped to jq, saved as
    // evidence, etc.) — an extra line here would corrupt it the same way the
    // "no committed floor" warning above correctly avoids by using stderr.
    console.log(`✅ within floor (${candidates.length} <= ${floor})`);
  }
}

main();
