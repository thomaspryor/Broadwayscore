#!/usr/bin/env node

/**
 * audit-review-key-duplicates.js
 *
 * Counts duplicate reviews keyed by (showDir | outletId|outlet | criticName) —
 * the SAME definition generate-integrity-report.js uses for its
 * `report.current.duplicates` metric. Excluded files (duplicateOf /
 * wrongProduction / wrongShow / wrongUrl / isRejectedNonReview) are skipped.
 *
 * This was a BLOCKING assertion (`report.current.duplicates <= 5`) in
 * tests/unit/data-quality-pipeline.test.js. But it asserts on a property of the
 * live corpus that drifts continuously — WE scrapers create timeout/unknown
 * variant files that accumulate between dedup passes — so a no-op code push
 * could fail it. Per the advisory-vs-blocking rule it belongs on the
 * non-blocking check-corpus-drift path (surfaced in the rebuild digest), not in
 * the blocking test.yml gate. Mirrors audit-unknown-outlets.js. See
 * Notion 387637c5-416f-8138 / 387637c5-416f-8114 and check-corpus-drift.js.
 *
 * Usage:
 *   node scripts/audit-review-key-duplicates.js            # summary, exit 0/1
 *   node scripts/audit-review-key-duplicates.js --max=5    # drift threshold (default 5)
 *   node scripts/audit-review-key-duplicates.js --json
 *
 * Exit codes (matches the check-corpus-drift audit contract):
 *   0 — duplicates <= max (no drift)
 *   1 — duplicates > max (drift)
 *   2 — corpus missing / unreadable (could not run)
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { isRejectedNonReview } = require('./lib/review-guards');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// Pure: count (showDir|outlet|critic) duplicates the same way the integrity
// report does. Returns { duplicates, totalReviews, examples }.
function countKeyDuplicates(reviewTextsDir) {
  const reviewKeys = new Set();
  let duplicates = 0;
  let totalReviews = 0;
  const examples = [];

  const showDirs = listShowDirs(reviewTextsDir).filter((f) =>
    fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
  );

  for (const showDir of showDirs) {
    const showPath = path.join(reviewTextsDir, showDir);
    const files = fs
      .readdirSync(showPath)
      .filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      totalReviews++;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(showPath, file), 'utf-8'));
      } catch (err) {
        continue;
      }

      const isExcluded =
        data.duplicateOf || data.wrongProduction || data.wrongShow || data.wrongUrl ||
        isRejectedNonReview(data);
      if (isExcluded) continue;

      const outletId = (data.outletId || '').toLowerCase();
      const outlet = (data.outlet || '').toLowerCase();
      const criticName = (data.criticName || 'unknown').toLowerCase().trim();
      const key = `${showDir}|${outletId || outlet}|${criticName}`;

      if (reviewKeys.has(key)) {
        duplicates++;
        if (examples.length < 25) examples.push({ showDir, file, key });
      } else {
        reviewKeys.add(key);
      }
    }
  }

  return { duplicates, totalReviews, examples };
}

function main() {
  const argv = process.argv.slice(2);
  const max = parseMaxArgOrExit(argv, { defaultMax: 5, scriptName: 'audit-review-key-duplicates' });
  const asJson = argv.includes('--json');

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error('[audit-review-key-duplicates] review-texts corpus missing — cannot run.');
    process.exit(2);
  }

  const { duplicates, totalReviews, examples } = countKeyDuplicates(REVIEW_TEXTS_DIR);
  const drift = duplicates > max;

  if (asJson) {
    console.log(JSON.stringify({ duplicates, max, totalReviews, drift, examples }, null, 2));
  } else {
    console.log(
      `[audit-review-key-duplicates] duplicate reviews: ${duplicates} (threshold ${max}) across ${totalReviews} files`
    );
    if (drift) {
      console.log('  Examples (same showDir|outlet|critic appearing more than once):');
      for (const ex of examples.slice(0, 15)) {
        console.log(`    ${ex.key}  —  ${ex.showDir}/${ex.file}`);
      }
    }
  }

  process.exit(drift ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { countKeyDuplicates };
