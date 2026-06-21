#!/usr/bin/env node
/**
 * Triage Unknown / empty-critic review-text stubs corpus-wide.
 *
 * Context: ~732 stubs whose criticName is Unknown/empty/unnamed accumulated from
 * SERP/aggregator discovery. Quality is mixed: some are legit aggregator
 * star-stubs (Show Score / Stagedoor / WET stars with no byline — scored via the
 * aggregatorStars fallback), some carry an originalScore or fullText, and some
 * are contentless husks or aggregator_url_mismatch contamination
 * (url on an aggregator domain but outletId is a real outlet — the class the
 * gather-reviews.js guard now prevents).
 *
 * This script buckets every Unknown/empty-critic stub and emits deletion
 * candidates. It is READ-ONLY — it writes a report and prints candidate paths.
 * Deletion is done separately via gh api against the private repo
 * (delete-stub-candidates) so the stale local clone can't clobber other
 * sessions' uncommitted work.
 *
 * Usage:
 *   node scripts/triage-unknown-critic-stubs.js [--dir <review-texts-dir>] [--out <report.json>]
 *
 * Buckets (a stub can land in several):
 *   hasOriginalScore         — originalScore present (a real outlet score)
 *   hasAggregatorStars       — aggregatorStars / westEndTheatreScore present (legit star-stub)
 *   hasFullText              — fullText present and non-trivial
 *   aggregatorUrlMismatch    — url hostname is an aggregator domain, outletId is NOT an aggregator
 *
 * Deletion candidate when BOTH:
 *   - contentless: no originalScore AND no aggregatorStars/westEndTheatreScore AND no meaningful fullText
 *   OR aggregatorUrlMismatch (regardless of content — contamination)
 * AND NOT a protected/legit star-stub (hasAggregatorStars && !aggregatorUrlMismatch).
 */
const fs = require('fs');
const path = require('path');
const { isAggregatorUrlMismatch } = require('./lib/aggregator-domains');

function arg(name, def) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  return def;
}

const REVIEW_TEXTS_DIR = path.resolve(arg('dir', path.join(__dirname, '..', 'data', 'review-texts')));
const OUT = path.resolve(arg('out', path.join(__dirname, '..', 'data', 'audit', 'unknown-critic-stub-triage.json')));

const MIN_FULLTEXT = 200; // chars — below this is not a real review body
const MIN_EXCERPT = 40;   // chars — an aggregator excerpt worth keeping

// Any value signal that makes a stub worth keeping: a score of any kind, an
// aggregator rating/thumb, an excerpt, or a real review body. A stub with ANY of
// these is contributing to (or feeding) scoring and must NOT be deleted.
const SCORE_SIGNALS = [
  'originalScore', 'assignedScore', 'llmScore', 'humanReviewScore',
  'aggregatorStars', 'westEndTheatreScore', 'showScoreStars', 'stagedoorStars',
  'dtliThumb', 'bwwThumb',
];
const EXCERPT_FIELDS = ['dtliExcerpt', 'nycTheatreExcerpt', 'bwwExcerpt', 'excerpt', 'pullQuote'];

// URLs that are clearly NOT reviews — social posts, closing/cast news, listicles.
// A stub on one of these is a discovery miss, not a collectable review.
const NON_REVIEW_URL = /facebook\.com|twitter\.com|x\.com\/|instagram\.com|youtube\.com|\/news\/|final-performance|to-close|will-close|closing|announce|cast-change|in-photos|first-look|\/tickets/i;

function isUnknownCritic(d) {
  const c = (d.criticName || '').trim().toLowerCase();
  return !c || c === 'unknown' || c === 'unnamed';
}

function hasMeaningfulText(d) {
  const t = d.fullText || d.text || '';
  return typeof t === 'string' && t.trim().length >= MIN_FULLTEXT;
}

function hasStars(d) {
  return d.aggregatorStars != null || d.westEndTheatreScore != null ||
    d.showScoreStars != null || d.stagedoorStars != null || d.dtliThumb != null || d.bwwThumb != null;
}

function hasExcerpt(d) {
  return EXCERPT_FIELDS.some(k => typeof d[k] === 'string' && d[k].trim().length >= MIN_EXCERPT);
}

// True only when the stub carries NO usable signal at all.
function isContentless(d) {
  for (const k of SCORE_SIGNALS) if (d[k] != null) return false;
  if (hasExcerpt(d)) return false;
  if (hasMeaningfulText(d)) return false;
  return true;
}

function isNonReviewUrl(url) {
  return typeof url === 'string' && NON_REVIEW_URL.test(url);
}

function main() {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`review-texts dir not found: ${REVIEW_TEXTS_DIR}`);
    process.exit(1);
  }

  const report = {
    dir: REVIEW_TEXTS_DIR,
    totalFiles: 0,
    unknownStubs: 0,
    buckets: {
      hasOriginalScore: 0,
      hasAggregatorStars: 0,
      hasFullText: 0,
      hasExcerpt: 0,
      aggregatorUrlMismatch: 0,
      contentless: 0,
    },
    protectedStarStubs: 0,
    // Husk = contentless (no score/stars/excerpt/text). Split by recoverability:
    huskNonReviewUrl: 0,       // url is social/news/listicle — not a collectable review
    huskCollectableUrl: 0,     // url is a plausible review awaiting text collection (KEEP — collect, don't delete)
    huskNoUrl: 0,              // nothing to collect
    deletionCandidates: [],    // {file, outletId, url, reasons}
    candidatesByReason: { contentless: 0, aggregatorUrlMismatch: 0, both: 0 },
    // Deletion candidates by reason, broken down for transparency
    keepForCollection: [],     // contentless husks with a plausible review URL — flagged, NOT deleted
  };

  for (const show of fs.readdirSync(REVIEW_TEXTS_DIR)) {
    const sd = path.join(REVIEW_TEXTS_DIR, show);
    let st;
    try { st = fs.statSync(sd); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(sd)) {
      if (!f.endsWith('.json') || f === 'failed-fetches.json' || f === '_blocklist.json') continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8')); } catch { continue; }
      report.totalFiles++;
      if (!isUnknownCritic(d)) continue;
      report.unknownStubs++;

      const rel = path.join(show, f);
      const stars = hasStars(d);
      const mismatch = isAggregatorUrlMismatch(d.url, d.outletId);
      const contentless = isContentless(d);

      if (d.originalScore != null) report.buckets.hasOriginalScore++;
      if (stars) report.buckets.hasAggregatorStars++;
      if (hasMeaningfulText(d)) report.buckets.hasFullText++;
      if (hasExcerpt(d)) report.buckets.hasExcerpt++;
      if (mismatch) report.buckets.aggregatorUrlMismatch++;
      if (contentless) report.buckets.contentless++;

      // Protected: a legit aggregator star-stub (has a rating, url is NOT a mismatch).
      const protectedStarStub = stars && !mismatch;
      if (protectedStarStub) report.protectedStarStubs++;

      const reasons = [];
      // (1) aggregator_url_mismatch is contamination — always a candidate (the class
      //     the gather-reviews.js guard now prevents). Never protected.
      if (mismatch) reasons.push('aggregatorUrlMismatch');

      // (2) contentless husks: SAFE to delete only when there is nothing to recover.
      //     A husk whose url is a plausible review is pending text collection — deleting
      //     it loses a discovered review, so we KEEP it (route to collection instead).
      if (contentless && !protectedStarStub) {
        const url = d.url;
        if (!url) { report.huskNoUrl++; reasons.push('contentless'); }
        else if (isNonReviewUrl(url)) { report.huskNonReviewUrl++; reasons.push('contentless'); }
        else { report.huskCollectableUrl++; /* KEEP — do not add 'contentless' reason */ if (!mismatch) report.keepForCollection.push({ file: rel, outletId: d.outletId || null, url }); }
      }

      if (reasons.length && !protectedStarStub) {
        report.deletionCandidates.push({ file: rel, outletId: d.outletId || null, url: d.url || null, reasons });
        const key = reasons.length === 2 ? 'both' : reasons[0];
        report.candidatesByReason[key] = (report.candidatesByReason[key] || 0) + 1;
      }
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log(`Triage of ${REVIEW_TEXTS_DIR}`);
  console.log(`  total files:            ${report.totalFiles}`);
  console.log(`  unknown/empty-critic:   ${report.unknownStubs}`);
  console.log(`  --- buckets (overlap) ---`);
  console.log(`  hasOriginalScore:       ${report.buckets.hasOriginalScore}`);
  console.log(`  hasAggregatorStars:     ${report.buckets.hasAggregatorStars}`);
  console.log(`  hasFullText:            ${report.buckets.hasFullText}`);
  console.log(`  hasExcerpt:             ${report.buckets.hasExcerpt}`);
  console.log(`  aggregatorUrlMismatch:  ${report.buckets.aggregatorUrlMismatch}`);
  console.log(`  contentless (husks):    ${report.buckets.contentless}`);
  console.log(`  protected star-stubs:   ${report.protectedStarStubs}`);
  console.log(`  --- husk recoverability ---`);
  console.log(`  husk no-url:            ${report.huskNoUrl}        (delete — nothing to collect)`);
  console.log(`  husk non-review url:    ${report.huskNonReviewUrl}        (delete — social/news/listicle)`);
  console.log(`  husk collectable url:   ${report.huskCollectableUrl}        (KEEP — pending text collection)`);
  console.log(`  --- deletion candidates ---`);
  console.log(`  total:                  ${report.deletionCandidates.length}`);
  console.log(`    contentless only:     ${report.candidatesByReason.contentless || 0}`);
  console.log(`    aggregatorUrlMismatch only: ${report.candidatesByReason.aggregatorUrlMismatch || 0}`);
  console.log(`    both:                 ${report.candidatesByReason.both || 0}`);
  console.log(`  report → ${OUT}`);
}

main();
