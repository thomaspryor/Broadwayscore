#!/usr/bin/env node

/**
 * Coverage sweep for isNonReview:true files with a substantial word count
 * and a review-shaped URL slug (BRO-3862) — the corpus the ticket found
 * "too noisy to auto-clear as-is" but names as "the right corpus to tune a
 * precision rule against." This script does not clear anything itself and
 * has no --gate: it is pure measurement, run non-blocking in
 * check-corpus-drift.yml (see that workflow's "Audit isNonReview
 * content-type/wrongShow + slug coverage" step) so the corpus size is a
 * tracked, visible metric instead of a one-off manual sweep nobody revisits.
 *
 * Buckets (see scripts/lib/nonreview-slug-coverage.js for the full logic):
 *   wrong-show-suspect — nonReviewType==='review', not yet promoted to
 *     wrongShow. This is the SAME signal scripts/audit-review-type-wrong-show.js
 *     already owns and gates (--gate --max=0) — reported here only for
 *     corpus-size context, deliberately NOT re-gated. Two gates on one root
 *     cause double the maintenance burden for zero extra coverage (ship-check
 *     adversarial review, BRO-3862): resolve via that script's --apply, not
 *     this one.
 *   essay-intro-fp — already covered by audit-exclusion-flags.js; reported
 *     here for corpus-size context only, not gated (that script owns it).
 *   already-excluded — wrongShow/wrongProduction/contentVerification.
 *     wrongArticle/garbage-text/invalid contentTier/dead-page chrome dump.
 *     The file is already correctly kept out of reviews.json by one of
 *     these OTHER mechanisms; counting it under "unaudited" too just
 *     inflates the backlog with files that need no further action
 *     (2026-09-21 re-verification: this was ~74% of the raw hit count).
 *   unaudited — no existing predicate covers this file. No validated
 *     auto-clear predicate exists yet; reported so the count is visible and
 *     trending, per the ticket's "measured continuously" ask.
 *
 * Usage:
 *   node scripts/audit-nonreview-slug-coverage.js                # report, exits 0
 *   node scripts/audit-nonreview-slug-coverage.js --show=ID
 *   node scripts/audit-nonreview-slug-coverage.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { bucketSlugCoverageHit } = require('./lib/nonreview-slug-coverage');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');

const USAGE = `audit-nonreview-slug-coverage.js — measure isNonReview + 400w + review-URL-slug corpus coverage (BRO-3862)

Usage:
  node scripts/audit-nonreview-slug-coverage.js [--show=ID] [--json]

  --show=ID   scope the sweep to one show directory
  --json      machine-readable output

No --gate: pure measurement. The wrong-show-suspect bucket is gated by
scripts/audit-review-type-wrong-show.js instead — don't duplicate that gate here.
`;

const ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const AUDIT_DIR = path.join(ROOT, 'data', 'audit');
const LOG_PATH = path.join(AUDIT_DIR, 'nonreview-slug-coverage-audit.json');

const SKIP_DIRS = new Set(['_pending', '_superseded-misattributed']);

function parseArgs(argv) {
  const args = {
    json: argv.includes('--json'),
    show: null,
  };
  for (const a of argv) {
    if (a.startsWith('--show=')) args.show = a.split('=')[1];
  }
  return args;
}

// Same { dirs, rootMissing } contract as the sibling BRO-57/BRO-3862 audits —
// a missing/empty REVIEW_TEXTS_DIR has no legitimate reading distinct from a
// --show filter matching nothing (BRO-2283 vacuous-pass class).
function listShowDirs(dir, showFilter) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dirs: [], rootMissing: true };
  }
  if (entries.length === 0) return { dirs: [], rootMissing: true };
  const dirs = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((name) => !SKIP_DIRS.has(name))
    .filter((name) => !showFilter || name === showFilter)
    .filter((name) => {
      try { return fs.statSync(path.join(dir, name)).isDirectory(); }
      catch { return false; }
    });
  return { dirs, rootMissing: false };
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const args = parseArgs(argv);

  const buckets = { 'wrong-show-suspect': [], 'essay-intro-fp': [], 'already-excluded': [], unaudited: [] };
  let scanned = 0;

  const { dirs: showDirs, rootMissing } = listShowDirs(REVIEW_TEXTS_DIR, args.show);
  try {
    assertCorpusScanned(0, { corpusRootMissing: rootMissing });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }

  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json'); }
    catch { continue; }

    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      scanned++;

      const bucket = bucketSlugCoverageHit(data, showId);
      if (!bucket) continue;

      buckets[bucket].push({
        showId,
        file,
        outlet: data.outlet || data.outletId || null,
        nonReviewType: data.nonReviewType || null,
        url: data.url || null,
        score: (data.llmScore && data.llmScore.score) || data.assignedScore || null,
      });
    }
  }

  const total = buckets['wrong-show-suspect'].length + buckets['essay-intro-fp'].length + buckets['already-excluded'].length + buckets.unaudited.length;

  if (args.json) {
    console.log(JSON.stringify({ scanned, total, buckets }, null, 2));
  } else {
    console.log(`Nonreview slug-coverage sweep: ${scanned} review file(s) scanned, ${total} in-scope hit(s) (isNonReview + >=400w + review URL slug).`);
    console.log(`  wrong-show-suspect: ${buckets['wrong-show-suspect'].length} (owned/gated by audit-review-type-wrong-show.js, reported here for context only)`);
    console.log(`  essay-intro-fp:     ${buckets['essay-intro-fp'].length} (owned by audit-exclusion-flags.js, not gated here)`);
    console.log(`  already-excluded:   ${buckets['already-excluded'].length} (wrongShow/wrongProduction/wrongArticle/garbage-text/dead-page — correctly excluded via a different mechanism already, no action needed)`);
    console.log(`  unaudited:          ${buckets.unaudited.length} (no validated auto-clear predicate yet — reported, not gated)`);
  }

  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify({
    _meta: { generatedAt: new Date().toISOString(), scanned, total },
    buckets,
  }, null, 2) + '\n');
  if (!args.json) console.log(`\nAudit log: ${LOG_PATH}`);
}

if (require.main === module) main();

module.exports = { main, REVIEW_TEXTS_DIR };
