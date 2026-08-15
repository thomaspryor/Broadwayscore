#!/usr/bin/env node
/**
 * audit-stale-cv-hash.js — surface reviews excluded by a contentVerification
 * verdict whose contentHash no longer matches the text the file now holds.
 *
 * Background (2026-08-12, user-reported via feedback issue #559):
 * contentVerification stamps `contentHash` = md5 of the first 2500 chars of the
 * text it judged, exactly so a later body change can be detected.
 * rebuild-all-reviews already skips CV promotion on a hash mismatch — EXCEPT for
 * the `trustWrongArticleDespiteStale` carve-out (cv.wrongArticle === true &&
 * cv.confidence === 'high'), which was written for "this URL points at a
 * different show" (stable across refetches) but also catches "this article is a
 * preview / not a review" (NOT stable — a truncated first fetch reads as a
 * preview, the full body reads as a review).
 *
 * 3 Summers of Lincoln / BroadwayWorld hit exactly that: the CV judged a
 * truncated body, called it a preview, and the carve-out promoted wrongShow +
 * isNonReview onto a file whose current body is a complete 1044-word review.
 *
 * IMPORTANT — two distinct sub-populations, reported separately:
 *   refetched   textFetchedAt > cv.verifiedAt — the body was demonstrably
 *               re-fetched after verification. The "verdict describes text that
 *               no longer exists" story is established for these.
 *   unexplained no recorded refetch after verification, yet the hash still
 *               differs. Something rewrote fullText without stamping
 *               textFetchedAt, or the hash was taken over a different
 *               normalization of the same fetch. Do NOT assume these are
 *               wrongly suppressed — they need diagnosis first.
 *
 * This audit mutates nothing. Clearing an exclusion is a scoring change.
 *
 * Usage:
 *   node scripts/audit-stale-cv-hash.js              # summary + top offenders
 *   node scripts/audit-stale-cv-hash.js --json       # machine-readable
 *   node scripts/audit-stale-cv-hash.js --limit=50   # more rows
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
// Import the canonical hash rather than mirroring it. If the hash input ever
// changes (e.g. the 2500-char window), a local copy would silently audit a
// different population while claiming parity with rebuild's guard.
const { contentHash } = require('./lib/content-verifier');

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');

// Container directories, not show IDs: their review JSONs live one level
// deeper, so they legitimately contribute zero files at this level. Named
// explicitly so "files scanned" isn't quietly understating coverage.
const NON_SHOW_DIRS = new Set(['_pending', '_superseded-misattributed']);

// Deliberately checks the raw promoted flags rather than calling the canonical
// isIncludableForRebuild/explainExclusion (review-guards.js) — this audit's
// question is narrower than general includability: "did a CV-promoted flag
// survive with a stale hash", not "is this review currently scoreable" (which
// also covers duplicateOf, syndication, and other exclusion reasons this
// script never touches). A finding here may already be overridden at read
// time by isNonReviewDemotedByFreshCV or the isStaleCvPromoted* self-heal
// predicates — reverify-stale-cv-promoted.js re-verifying it anyway is
// redundant in that case, not harmful.
function isExcluded(d) {
  return Boolean(d.wrongShow || d.wrongProduction || d.isNonReview || d.contentTier === 'invalid');
}

function audit() {
  const stats = {
    filesScanned: 0,
    withContentVerification: 0,
    withContentHash: 0,
    noFullText: 0,
    hashMismatch: 0,
    hashMismatchExcluded: 0,
    hashMismatchExcludedPromoted: 0,
    refetchedAfterVerify: 0,
    unexplainedMismatch: 0,
    trustedWrongArticleCarveout: 0,
    cvJudgedTruncatedText: 0,
    skippedContainerDirs: [],
  };
  const findings = [];

  for (const showId of listShowDirs(REVIEW_TEXTS_DIR, { silent: true })) {
    if (NON_SHOW_DIRS.has(showId)) { stats.skippedContainerDirs.push(showId); continue; }
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try {
      files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch {
      continue;
    }

    for (const file of files) {
      let d;
      try {
        d = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      } catch {
        continue;
      }
      stats.filesScanned++;

      const cv = d.contentVerification;
      if (!cv) continue;
      stats.withContentVerification++;
      if (!cv.contentHash) continue;
      stats.withContentHash++;

      const text = d.fullText || '';
      if (!text) {
        // A nulled body is the worst sub-class of this bug — the verdict that
        // suppressed the review outlives the text it judged entirely — so count
        // it rather than dropping it silently.
        if (isExcluded(d) && d.contentVerificationPromoted) stats.noFullText++;
        continue;
      }
      if (contentHash(text) === cv.contentHash) continue;
      stats.hashMismatch++;

      if (!isExcluded(d)) continue;
      stats.hashMismatchExcluded++;
      if (!d.contentVerificationPromoted) continue;
      stats.hashMismatchExcludedPromoted++;

      const fetchedAt = d.textFetchedAt ? Date.parse(d.textFetchedAt) : NaN;
      const verifiedAt = cv.verifiedAt ? Date.parse(cv.verifiedAt) : NaN;
      const refetched = Number.isFinite(fetchedAt) && Number.isFinite(verifiedAt) && fetchedAt > verifiedAt;
      if (refetched) stats.refetchedAfterVerify++; else stats.unexplainedMismatch++;

      const carveout = cv.wrongArticle === true && cv.confidence === 'high';
      if (carveout) stats.trustedWrongArticleCarveout++;
      if (cv.truncated === true) stats.cvJudgedTruncatedText++;

      findings.push({
        showId,
        file,
        outletId: d.outletId || null,
        criticName: d.criticName || null,
        assignedScore: d.assignedScore ?? null,
        contentTier: d.contentTier || null,
        wrongShow: Boolean(d.wrongShow),
        wrongProduction: Boolean(d.wrongProduction),
        isNonReview: Boolean(d.isNonReview),
        rejectionReason: d.rejectionReason || null,
        cvArticleType: cv.articleType || null,
        cvConfidence: cv.confidence || null,
        cvTruncated: cv.truncated === true,
        cvWrongArticle: cv.wrongArticle === true,
        trustedByCarveout: carveout,
        refetchedAfterVerify: refetched,
        cvVerifiedAt: cv.verifiedAt || null,
        textFetchedAt: d.textFetchedAt || null,
      });
    }
  }

  // Established cases first: a recorded refetch, then the carve-out, then a
  // self-declared-truncated verdict.
  findings.sort((a, b) => {
    const score = (f) => (f.refetchedAfterVerify ? 4 : 0) + (f.trustedByCarveout ? 2 : 0) + (f.cvTruncated ? 1 : 0);
    return score(b) - score(a) || String(a.showId).localeCompare(String(b.showId));
  });

  return { stats, findings };
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const parsedLimit = limitArg ? Number(limitArg.split('=')[1]) : NaN;
  // A typo'd --limit must not read as "nothing to look at" on a run with real
  // hits, so fall back rather than printing "Top NaN of N" and zero rows.
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 20;

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`No review-texts corpus at ${REVIEW_TEXTS_DIR}.`);
    console.error('This audit needs the private core-data checkout: ./scripts/setup-local-data.sh');
    process.exit(1);
  }

  const { stats, findings } = audit();

  if (asJson) {
    console.log(JSON.stringify({ stats, findings }, null, 2));
    return;
  }

  console.log('Stale contentVerification hash audit');
  console.log('===================================');
  console.log(`  files scanned                      ${stats.filesScanned}`);
  console.log(`  with contentVerification           ${stats.withContentVerification}`);
  console.log(`  with contentHash stamped           ${stats.withContentHash}`);
  console.log(`  hash no longer matches fullText    ${stats.hashMismatch}`);
  console.log(`  ...and the file is excluded        ${stats.hashMismatchExcluded}`);
  console.log(`  ...and exclusion was CV-promoted   ${stats.hashMismatchExcludedPromoted}`);
  console.log('');
  console.log('  Split by whether a refetch is actually recorded:');
  console.log(`    refetched after verify (established)  ${stats.refetchedAfterVerify}  <-- verdict outlived its text`);
  console.log(`    no recorded refetch (unexplained)     ${stats.unexplainedMismatch}  <-- diagnose before clearing`);
  console.log('');
  console.log(`  trusted via the high-confidence wrongArticle carve-out: ${stats.trustedWrongArticleCarveout}`);
  console.log(`  CV itself judged the text truncated:                    ${stats.cvJudgedTruncatedText}`);
  console.log(`  excluded+promoted with fullText nulled entirely:        ${stats.noFullText}`);
  if (stats.skippedContainerDirs.length) {
    console.log(`  container dirs skipped (reviews nested deeper): ${stats.skippedContainerDirs.join(', ')}`);
  }
  console.log('');

  if (!findings.length) {
    console.log('No excluded reviews with a stale verification hash. Nothing to do.');
    return;
  }

  console.log(`Top ${Math.min(limit, findings.length)} of ${findings.length} (refetched + carve-out + truncated first):`);
  for (const f of findings.slice(0, limit)) {
    const flags = [
      f.wrongShow && 'wrongShow',
      f.wrongProduction && 'wrongProduction',
      f.isNonReview && 'isNonReview',
    ].filter(Boolean).join(',') || 'tier=invalid';
    const why = f.refetchedAfterVerify ? 'REFETCHED' : 'unexplained';
    const carve = f.trustedByCarveout ? ' CARVE-OUT' : '';
    const trunc = f.cvTruncated ? ' cv-saw-truncated' : '';
    console.log(`  [${why}${carve}${trunc}] ${f.showId}/${f.file}`);
    console.log(`      outlet=${f.outletId} score=${f.assignedScore} flags=${flags} cvArticleType=${f.cvArticleType}`);
  }
  console.log('');
  console.log('These are NOT auto-cleared: clearing an exclusion is a scoring change.');
  console.log('Run node scripts/scoring-delta.js before shipping any bulk clear (CLAUDE.md 12.7).');
}

if (require.main === module) main();

module.exports = { audit };
