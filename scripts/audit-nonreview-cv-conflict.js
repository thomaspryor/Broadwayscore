#!/usr/bin/env node

/**
 * Stale-isNonReview-vs-fresh-CV sweep (task #1255, Notion 3b9637c5).
 *
 * Reports review-text files where isNonReview===true but a NEWER, high-
 * confidence contentVerification pass affirms articleType='review' — the
 * exact shape isNonReviewDemotedByFreshCV() in scripts/lib/review-guards.js
 * now demotes at read time (isIncludableForRebuild + rebuild-all-reviews.js's
 * own inline check). isNonReview itself is never mutated on disk by this
 * script or by the fix — this is a read-time reclassification, not a write —
 * so the count here does not need to trend to zero; it is visibility into how
 * often a stale classifier verdict (mostly gemini, memory/feedback_llm_
 * verifier_hallucinates.md) gets outranked by a later re-verification, and
 * ordinary future pipeline runs can add to it. --gate is an optional,
 * informational ceiling — not wired into CI by default, since this is not a
 * draining backlog the way self-contradictory-clears is.
 *
 * Reuses the single exported predicate rather than re-deriving the logic, so
 * this can never drift out of sync with the actual inclusion behavior.
 *
 * Usage:
 *   node scripts/audit-nonreview-cv-conflict.js               # report, exits 0
 *   node scripts/audit-nonreview-cv-conflict.js --gate --max=15
 *   node scripts/audit-nonreview-cv-conflict.js --show=ID
 *   node scripts/audit-nonreview-cv-conflict.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { isNonReviewDemotedByFreshCV } = require('./lib/review-guards');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');

const USAGE = `audit-nonreview-cv-conflict.js — stale isNonReview outranked by a fresher high-confidence CV (#1255)

Usage:
  node scripts/audit-nonreview-cv-conflict.js [--gate] [--max=15] [--show=ID] [--json]

  --gate      exit 1 when the count exceeds --max (optional, informational — not CI-gated by default)
  --max=N     ceiling for --gate (default 15 — the count measured 2026-08-11)
  --show=ID   scope the sweep to one show directory
  --json      machine-readable output
`;

const ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');

const SKIP_DIRS = new Set(['_superseded-misattributed']);

function parseArgs(argv) {
  const args = {
    gate: false,
    max: parseMaxArgOrExit(argv, { defaultMax: 15, scriptName: 'audit-nonreview-cv-conflict' }),
    show: null,
    json: false,
  };
  for (const a of argv) {
    if (a === '--gate') args.gate = true;
    else if (a === '--json') args.json = true;
    else if (a.startsWith('--show=')) args.show = a.split('=')[1];
  }
  return args;
}

function listShowDirs(showFilter) {
  let entries;
  try {
    entries = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((name) => !SKIP_DIRS.has(name))
    .filter((name) => !showFilter || name === showFilter)
    .filter((name) => {
      try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, name)).isDirectory(); }
      catch { return false; }
    });
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = parseArgs(process.argv.slice(2));

  const hits = [];
  let scanned = 0;

  for (const showId of listShowDirs(args.show)) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json')); }
    catch { continue; }

    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch { continue; }
      scanned++;

      if (isNonReviewDemotedByFreshCV(data)) {
        const cv = data.contentVerification;
        hits.push({
          showId,
          file,
          classifiedAt: data.classifiedAt || null,
          classifiedBy: data.nonReviewClassifiedBy || null,
          verifiedAt: cv.verifiedAt,
          verifiedBy: cv.verifiedBy || null,
        });
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ scanned, count: hits.length, hits }, null, 2));
  } else {
    console.log(`isNonReview-vs-CV sweep: ${scanned} review file(s) scanned, ${hits.length} demoted-by-CV hit(s).`);
    for (const h of hits.slice(0, 40)) {
      console.log(`  ${h.showId}/${h.file}  classifiedAt=${h.classifiedAt || 'none'} (${h.classifiedBy || 'unknown'}) -> verifiedAt=${h.verifiedAt} (${h.verifiedBy || 'unknown'})`);
    }
    if (hits.length > 40) console.log(`  … and ${hits.length - 40} more`);
  }

  try {
    assertCorpusScanned(scanned, { gate: args.gate });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  if (args.gate && hits.length > args.max) {
    console.error(`\nFAIL: ${hits.length} hit(s) > max ${args.max}.`);
    process.exit(1);
  }
}

main();
