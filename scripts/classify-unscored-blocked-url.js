#!/usr/bin/env node
/**
 * Corpus-wide backstop: stamps rejectionReason='not_a_review' on files that
 * are unscored AND unclassified AND saved from a URL isBlockedReviewUrl()
 * (scripts/lib/domain-filters.js) already treats as never-a-direct-review
 * (aggregator/listing, ticket/booking, social, or reference domain).
 *
 * Task #1328: isScoreable() filters isBlockedReviewUrl URLs out of the LLM
 * ensemble before it ever runs, so these files never get scored AND never
 * get a rejectionReason written — they sit unclassified indefinitely.
 * scripts/lib/found-outlet-ids.js's new blocked-URL check (same task) stops
 * them from masking the outlet slot in memory, but the on-disk file itself
 * stays unclassified until this stamps it — generalizes the narrow /news/
 * subclass task #1323 shipped in classify-unscored-news-articles.js to every
 * isBlockedReviewUrl domain.
 *
 * Corpus-wide dry-run on 2026-08-12 found 88 files across 29 outlets under
 * this gate — all inspected examples were aggregator review round-ups,
 * ticket-site listings, social posts, or reference-site news, never a
 * genuine single-outlet review.
 *
 * Usage:
 *   node scripts/classify-unscored-blocked-url.js [--show=SLUG] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `classify-unscored-blocked-url.js — stamp rejectionReason='not_a_review' on
unscored, unclassified files saved from a URL isBlockedReviewUrl() already treats
as never-a-direct-review (aggregator/listing, ticket, social, reference).

Usage:
  node scripts/classify-unscored-blocked-url.js [--show=SLUG] [--dry-run]

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

const { isBlockedReviewUrl } = require('./lib/domain-filters');
const { safeWriteReview } = require('./lib/review-write-guard');
const { hasValidScore } = require('./lib/review-guards');

function main() {
  console.log(`=== Classify Unscored Blocked-URL Files ===`);
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

      // Gate: only unscored + unclassified files with a URL isBlockedReviewUrl
      // flags. Anything already scored or already flagged (by the ensemble, a
      // human, or a prior run of this script) is left untouched. hasValidScore
      // is the CANONICAL score-presence check (review-guards.js) — checking
      // only llmScore/assignedScore missed originalScore/aggregatorStars and
      // corrupted 16 real show-score/timeout/thestage reviews on the first
      // corpus run (#1328 fixup, caught by a parallel session).
      const isScored = hasValidScore(data);
      const isClassified = !!data.rejectedAt || !!data.rejectionReason
        || data.wrongProduction === true || data.wrongShow === true;
      if (isScored || isClassified) continue;
      if (!data.url || !isBlockedReviewUrl(data.url)) continue;

      flagged++;
      flaggedFiles.push({ showId, file, url: data.url, outletId: data.outletId });
      console.log(`[FLAG] ${showId}/${file} (${data.outletId}): blocked URL ${data.url}`);

      if (!DRY_RUN) {
        const now = new Date().toISOString();
        const result = safeWriteReview(filePath, {
          ...data,
          rejectionReason: 'not_a_review',
          rejectedAt: now,
          rejectedBy: 'blocked-url-heuristic-check',
          rejectionReasoning: `heuristic: URL is on an isBlockedReviewUrl domain (aggregator/listing, ticket, social, or reference site) and was never scored — task #1328`,
        });
        if (!result.wrote) {
          console.log(`  ⚠ write skipped: ${result.skipped || 'unknown'}`);
        }
      }
    }
  }

  console.log('');
  console.log(`Scanned: ${scanned} files`);
  console.log(`Flagged as blocked-URL unscored: ${flagged}`);
  if (DRY_RUN) console.log('DRY RUN — no files modified');

  return { scanned, flagged, flaggedFiles };
}

if (require.main === module) {
  main();
} else {
  module.exports = { main };
}
