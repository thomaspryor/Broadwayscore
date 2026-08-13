#!/usr/bin/env node
/**
 * audit-stale-cv-hash.js — surface reviews suppressed by a contentVerification
 * verdict that was computed against text the file no longer holds.
 *
 * Background (2026-08-12, user-reported via feedback issue #559):
 * contentVerification stamps `contentHash` = md5 of the first 2500 chars of the
 * text it judged, exactly so a later refetch can be detected. rebuild-all-reviews
 * already skips CV promotion when that hash no longer matches — EXCEPT for the
 * `trustWrongArticleDespiteStale` carve-out (cv.wrongArticle === true &&
 * cv.confidence === 'high'), which was written for "this URL points at a
 * different show" (stable across refetches) but also catches "this article is a
 * preview / not a review" (NOT stable — a truncated first fetch reads as a
 * preview, the full refetch reads as a review).
 *
 * 3 Summers of Lincoln / BroadwayWorld hit exactly that: the CV judged a
 * truncated body, called it a preview, and the carve-out promoted wrongShow +
 * isNonReview onto a file whose current body is a complete 1044-word review.
 *
 * This audit does NOT mutate anything. It reports the population so the class
 * stays visible instead of silently eating reviews.
 *
 * Usage:
 *   node scripts/audit-stale-cv-hash.js              # summary + top offenders
 *   node scripts/audit-stale-cv-hash.js --json       # machine-readable
 *   node scripts/audit-stale-cv-hash.js --limit=50   # more rows
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

/** Mirrors contentHash() in scripts/lib/content-verifier.js — first 2500 chars. */
function contentHash(text) {
  if (!text) return null;
  return crypto.createHash('md5').update(text.substring(0, 2500)).digest('hex');
}

function isExcluded(d) {
  return Boolean(d.wrongShow || d.wrongProduction || d.isNonReview || d.contentTier === 'invalid');
}

function listShowDirs(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  // Skip symlinks deliberately: a committed absolute-path symlink dangles in CI
  // and crashes the pipeline (memory: stray-symlink-crashes-pipeline).
  return entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name);
}

function audit() {
  const stats = {
    filesScanned: 0,
    withContentVerification: 0,
    withContentHash: 0,
    hashMismatch: 0,
    hashMismatchExcluded: 0,
    hashMismatchExcludedPromoted: 0,
    trustedWrongArticleCarveout: 0,
    cvJudgedTruncatedText: 0,
  };
  const findings = [];

  for (const showId of listShowDirs(REVIEW_TEXTS_DIR)) {
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
      if (!text) continue;
      if (contentHash(text) === cv.contentHash) continue;
      stats.hashMismatch++;

      if (!isExcluded(d)) continue;
      stats.hashMismatchExcluded++;
      if (!d.contentVerificationPromoted) continue;
      stats.hashMismatchExcludedPromoted++;

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
        cvVerifiedAt: cv.verifiedAt || null,
        textFetchedAt: d.textFetchedAt || null,
      });
    }
  }

  // Most suspicious first: the carve-out cases where the CV itself admits it was
  // reading truncated text — those verdicts cannot survive a body replacement.
  findings.sort((a, b) => {
    const score = (f) => (f.trustedByCarveout ? 2 : 0) + (f.cvTruncated ? 1 : 0);
    return score(b) - score(a) || String(a.showId).localeCompare(String(b.showId));
  });

  return { stats, findings };
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 20;

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
  console.log(`  ...and exclusion was CV-promoted   ${stats.hashMismatchExcludedPromoted}  <-- suppressed reviews`);
  console.log('');
  console.log(`  of those, trusted via the high-confidence wrongArticle carve-out: ${stats.trustedWrongArticleCarveout}`);
  console.log(`  of those, CV itself judged the text truncated:                    ${stats.cvJudgedTruncatedText}`);
  console.log('');

  if (!findings.length) {
    console.log('No suppressed reviews with a stale verification hash. Nothing to do.');
    return;
  }

  console.log(`Top ${Math.min(limit, findings.length)} of ${findings.length} (carve-out + truncated first):`);
  for (const f of findings.slice(0, limit)) {
    const flags = [
      f.wrongShow && 'wrongShow',
      f.wrongProduction && 'wrongProduction',
      f.isNonReview && 'isNonReview',
    ].filter(Boolean).join(',') || 'tier=invalid';
    const why = f.trustedByCarveout ? 'CARVE-OUT' : 'stale';
    const trunc = f.cvTruncated ? ' cv-saw-truncated' : '';
    console.log(`  [${why}${trunc}] ${f.showId}/${f.file}`);
    console.log(`      outlet=${f.outletId} score=${f.assignedScore} flags=${flags} cvArticleType=${f.cvArticleType}`);
  }
  console.log('');
  console.log('These are NOT auto-cleared: clearing an exclusion is a scoring change.');
  console.log('Run node scripts/scoring-delta.js before shipping any bulk clear (CLAUDE.md §12.7).');
}

if (require.main === module) main();

module.exports = { audit, contentHash };
