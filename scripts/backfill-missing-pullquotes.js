#!/usr/bin/env node
/**
 * backfill-missing-pullquotes.js (BRO-767)
 *
 * Scoped, narrow alternative to a full rebuild-all-reviews.js run. A full
 * rebuild recomputes every field on every review (score, critic-name
 * normalization, quote-wrapping) — a 20,000+ review diff for a bug that is
 * only about one field on ~40 reviews. This script touches ONLY the
 * `pullQuote` field, and ONLY on reviews that currently have none, using the
 * same selectBestExcerpt() the rebuild uses so the two never disagree.
 *
 * Scope (matches the BRO-767 audit query): T1/T2 reviews, critic-level dedup
 * winner, assignedScore >= 70, pullQuote null/empty/<30 chars.
 *
 * --all widens scope to every review missing a pullQuote regardless of tier/
 * score (found via a /what-else pass on this same fix: the wiring gap the fix
 * closes isn't specific to T1/T2>=70, it's just where the BRO-767 audit query
 * happened to look. 17 reviews corpus-wide are recoverable; 4 are the T1/T2
 * ones the default scope already covers).
 *
 * Run:
 *   node scripts/backfill-missing-pullquotes.js            # apply (BRO-767 scope)
 *   node scripts/backfill-missing-pullquotes.js --all       # apply (every tier/score)
 *   node scripts/backfill-missing-pullquotes.js --dry-run   # report only
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { selectBestExcerpt } = require('./rebuild-all-reviews.js');
const { fileForReview, loadShowTexts } = require('./audit-pull-quotes.js');

const ROOT = path.join(__dirname, '..');
const REVIEWS_FILE = process.env.REVIEWS_FILE || path.join(ROOT, 'data', 'reviews.json');
const SHOWS_FILE = process.env.SHOWS_FILE || path.join(ROOT, 'data', 'shows.json');
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');
const OUTLET_REGISTRY_FILE = process.env.OUTLET_REGISTRY_FILE || path.join(ROOT, 'data', 'outlet-registry.json');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Same dedup-winner selection the BRO-767 audit query uses. */
function findTargetReviews(reviews, outlets) {
  const tierByOutlet = {};
  for (const id of Object.keys(outlets)) tierByOutlet[id] = outlets[id].tier;

  const byCritic = new Map();
  for (const r of reviews) {
    if ((tierByOutlet[r.outletId] || 3) > 2) continue;
    if (!(r.assignedScore >= 70)) continue;
    const key = `${r.showId}|${r.outletId}|${(r.criticName || '__unk__').toLowerCase()}`;
    const existing = byCritic.get(key);
    if (!existing || (r.publishDate || '') > (existing.publishDate || '')) byCritic.set(key, r);
  }

  return [...byCritic.values()].filter(r => !r.pullQuote || r.pullQuote.length < 30);
}

/** Every review missing a pullQuote, regardless of tier/score (--all mode). */
function findAllMissingPullQuoteReviews(reviews) {
  return reviews.filter(r => !r.pullQuote || r.pullQuote.length < 30);
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const allScope = process.argv.includes('--all');

  const reviewsData = readJson(REVIEWS_FILE);
  const shows = readJson(SHOWS_FILE).shows || [];
  const outlets = readJson(OUTLET_REGISTRY_FILE).outlets || {};
  const titleById = new Map(shows.map(s => [s.id, s.title]));

  const targets = allScope
    ? findAllMissingPullQuoteReviews(reviewsData.reviews)
    : findTargetReviews(reviewsData.reviews, outlets);
  console.log(`backfill-missing-pullquotes: ${targets.length} target review(s) missing pullQuote`);

  const textsByShow = new Map();
  function textsFor(showId) {
    if (!textsByShow.has(showId)) textsByShow.set(showId, loadShowTexts(showId, REVIEW_TEXTS_DIR));
    return textsByShow.get(showId);
  }

  let filled = 0;
  let noFile = 0;
  let noExcerpt = 0;
  const stillMissing = [];

  for (const target of targets) {
    const entry = fileForReview(textsFor(target.showId), target);
    if (!entry) {
      noFile++;
      stillMissing.push({ showId: target.showId, outletId: target.outletId, criticName: target.criticName, reason: 'no-source-file' });
      continue;
    }

    let excerpt;
    try {
      excerpt = selectBestExcerpt(entry.data, titleById.get(target.showId));
    } catch (e) {
      stillMissing.push({ showId: target.showId, outletId: target.outletId, criticName: target.criticName, reason: `error: ${e.message}` });
      continue;
    }

    if (!excerpt) {
      noExcerpt++;
      stillMissing.push({ showId: target.showId, outletId: target.outletId, criticName: target.criticName, reason: 'no-usable-excerpt' });
      continue;
    }

    console.log(`  [FILL] ${target.showId} / ${target.outletId} / ${target.criticName}: ${JSON.stringify(excerpt.slice(0, 100))}`);
    // Mutate the actual record in reviewsData.reviews (target IS that object —
    // findTargetReviews returns references from reviewsData.reviews, not copies).
    target.pullQuote = excerpt;
    filled++;
  }

  console.log(`\nfilled: ${filled}, no-source-file: ${noFile}, no-usable-excerpt: ${noExcerpt}`);
  if (stillMissing.length) {
    console.log(`\nStill missing (${stillMissing.length}) — needs a source excerpt added to review-texts:`);
    for (const m of stillMissing) console.log(`  ${m.showId} / ${m.outletId} / ${m.criticName} (${m.reason})`);
  }

  if (dryRun) {
    console.log('\n--dry-run: not writing reviews.json');
    return stillMissing.length ? 1 : 0;
  }

  if (filled === 0) {
    console.log('\nNothing to write.');
    return stillMissing.length ? 1 : 0;
  }

  // Atomic write, following symlinks (see rebuild-all-reviews.js) so a local
  // dev checkout with data/reviews.json symlinked into the private repo
  // writes through to the private repo's working tree, not the symlink itself.
  const realReviewsPath = fs.existsSync(REVIEWS_FILE) ? fs.realpathSync(REVIEWS_FILE) : REVIEWS_FILE;
  const tmpPath = realReviewsPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(reviewsData, null, 2));
  JSON.parse(fs.readFileSync(tmpPath, 'utf8')); // validate before rename
  fs.renameSync(tmpPath, realReviewsPath);
  console.log(`\nwrote ${realReviewsPath}`);

  return stillMissing.length ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { findTargetReviews, findAllMissingPullQuoteReviews };
