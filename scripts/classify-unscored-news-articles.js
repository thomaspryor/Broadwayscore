#!/usr/bin/env node
/**
 * Post-collect backstop: stamps rejectionReason='not_a_review' on outlet NEWS
 * articles (press releases, "first look"/"the lowdown"/"releases first
 * listen" pieces) that were fetched as contentTier=complete but never
 * classified by ensemble-scoreability-check.
 *
 * Task #1323: these files are typically on an aggregator/listing domain
 * (isBlockedReviewUrl in scripts/lib/domain-filters.js — e.g.
 * westendtheatre.com), which means isScoreable() filters them out of the LLM
 * scoring pipeline before the ensemble ever runs — so rejectionReason is
 * never stamped and the file sits unflagged indefinitely.
 * scripts/lib/found-outlet-ids.js then reads the unflagged outlet as
 * "found", so SERP/gap discovery never looks for that outlet's REAL review.
 *
 * Scope is deliberately narrow: only touches files with NO existing score
 * (llmScore/assignedScore) and NO existing classification (rejectedAt/
 * rejectionReason/wrongProduction/wrongShow) — corpus-wide dry-run on
 * 2026-08-12 found exactly 1 match under this gate (the file this card was
 * filed about) vs 11 matches with the gate removed, 5 of them already-scored
 * real reviews that would have been false positives. Never deletes files.
 *
 * Usage:
 *   node scripts/classify-unscored-news-articles.js [--show=SLUG] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `classify-unscored-news-articles.js — stamp rejectionReason='not_a_review'
on unscored, unclassified outlet NEWS articles (task #1323). Never deletes files.

Usage:
  node scripts/classify-unscored-news-articles.js [--show=SLUG] [--dry-run]

  --show=SLUG   limit to one show directory
  --dry-run     report what would change, write nothing
  --help, -h    print this and exit
`;

const args = process.argv.slice(2);
if (hasHelpFlag(args)) {
  console.log(USAGE);
  process.exit(0);
}

const DRY_RUN = args.includes('--dry-run');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';

const RT = process.env.REVIEW_TEXTS_DIR || path.join(os.homedir(), 'broadway-review-texts');

const { detectNewsArticle } = require('./lib/news-article-detector');
const { safeWriteReview } = require('./lib/review-write-guard');
const { hasValidScore } = require('./lib/review-guards');

function main() {
  console.log(`=== Classify Unscored News Articles ===`);
  console.log(`Review texts dir: ${RT}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  if (SHOW_FILTER) console.log(`Show filter: ${SHOW_FILTER}`);
  console.log('');

  const shows = fs.readdirSync(RT).filter(d => {
    if (d.startsWith('_') || d.startsWith('.')) return false;
    if (SHOW_FILTER && d !== SHOW_FILTER) return false;
    try { return fs.statSync(path.join(RT, d)).isDirectory(); } catch { return false; }
  });

  let scanned = 0;
  let flagged = 0;
  const flaggedFiles = [];

  for (const showId of shows) {
    const showDir = path.join(RT, showId);
    let files;
    try { files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json'); }
    catch { continue; }

    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      scanned++;

      // Gate: only unscored + unclassified files. Anything already scored or
      // already flagged (by the ensemble, a human, or a prior run of this
      // script) is left untouched. hasValidScore is the CANONICAL score-presence
      // check (review-guards.js) — a narrower llmScore/assignedScore-only check
      // misses originalScore/aggregatorStars and corrupted 16 real scored
      // reviews in the cousin script this one was modeled after (#1328 fixup).
      const isScored = hasValidScore(data);
      const isClassified = !!data.rejectedAt || !!data.rejectionReason
        || data.wrongProduction === true || data.wrongShow === true;
      if (isScored || isClassified) continue;

      const { isNewsArticle, reasons } = detectNewsArticle(data);
      if (!isNewsArticle) continue;

      flagged++;
      flaggedFiles.push({ showId, file, url: data.url, outletId: data.outletId, reasons });
      console.log(`[FLAG] ${showId}/${file} (${data.outletId}): ${reasons.join(', ')}`);

      if (!DRY_RUN) {
        const now = new Date().toISOString();
        const result = safeWriteReview(filePath, {
          ...data,
          rejectionReason: 'not_a_review',
          rejectedAt: now,
          rejectedBy: 'news-article-heuristic-check',
          rejectionReasoning: `heuristic: ${reasons.join('; ')}`,
        });
        if (!result.wrote) {
          console.log(`  ⚠ write skipped: ${result.skipped || 'unknown'}`);
        }
      }
    }
  }

  console.log('');
  console.log(`Scanned: ${scanned} files`);
  console.log(`Flagged as news articles: ${flagged}`);
  if (DRY_RUN) console.log('DRY RUN — no files modified');

  return { scanned, flagged, flaggedFiles };
}

if (require.main === module) {
  main();
} else {
  module.exports = { main };
}
