// TESTS-VS-DERIVED-DATA-EXEMPT: structural: asserts the rebuild left no recoverable excerpt unused; pins no show fact
// BRO-5798 (BRO-3425 pattern): live-data assertion split out of tests/unit/review-pullquotes.test.mjs. It reads data/reviews.json and
// data/review-texts, which bots rewrite many times a day, so in a code-test batch it turned main red with no code change.
// It runs in check-corpus-drift.yml's "Live-data assertions" step (data-health), excluded from the unit batches in
// scripts/lib/unit-test-collection.js. Pure-logic tests stay in tests/unit/review-pullquotes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { fileForReview, loadShowTexts } = require('../../scripts/audit-pull-quotes.js');
const { findTargetReviews, recoverableQuote, changedSinceRebuildScan } = require('../../scripts/backfill-missing-pullquotes.js');
const REQUIRE_CORPUS = process.env.REQUIRE_REVIEW_CORPUS === '1';

// Integration check against the live corpus: the BRO-767 audit query
// (findTargetReviews — T1/T2, critic-level dedup winner, assignedScore >= 70,
// pullQuote null/empty/<30 chars) must never contain a review the pipeline
// could already fill. If it does, the wiring gap has regressed (or a new
// aggregator excerpt field needs the same treatment this fix gave the other
// three). Reviews with genuinely no captured excerpt anywhere (stub-tier, no
// fullText, no aggregator field) are a separate, tracked problem — see
// BRO-767 follow-up — and are expected to still appear here.
test('no review missing a pullQuote has a recoverable excerpt sitting unused in review-texts', (t) => {
  const ROOT = path.join(__dirname, '..', '..');
  const reviewsFile = process.env.REVIEWS_FILE || path.join(ROOT, 'data', 'reviews.json');
  const showsFile = process.env.SHOWS_FILE || path.join(ROOT, 'data', 'shows.json');
  const outletRegistryFile = process.env.OUTLET_REGISTRY_FILE || path.join(ROOT, 'data', 'outlet-registry.json');
  const reviewTextsDir = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');

  if (!fs.existsSync(reviewsFile) || !fs.existsSync(showsFile) || !fs.existsSync(outletRegistryFile) || !fs.existsSync(reviewTextsDir)) {
    // An absent corpus must read as SKIPPED, not passed (a bare return passes). The data-health job sets
    // REQUIRE_REVIEW_CORPUS=1 so a failed checkout fails here instead of skipping green.
    assert.ok(!REQUIRE_CORPUS, 'REQUIRE_REVIEW_CORPUS=1 but reviews.json / outlet-registry.json / review-texts is missing; fix the checkout rather than unsetting the flag.');
    return t.skip('reviews.json / outlet-registry.json / review-texts not present in this checkout');
  }

  const reviewsData = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
  const reviews = reviewsData.reviews;
  // BRO-6201: review-texts can be checked out ahead of reviews.json (a file scored after the last rebuild's scan).
  const scannedAt = reviewsData._meta && reviewsData._meta.reviewTextsScannedAt;
  const shows = JSON.parse(fs.readFileSync(showsFile, 'utf8')).shows || [];
  const outlets = JSON.parse(fs.readFileSync(outletRegistryFile, 'utf8')).outlets || {};
  const titleById = new Map(shows.map(s => [s.id, s.title]));
  const statusById = new Map(shows.map(s => [s.id, s.status]));
  const showById = new Map(shows.map(s => [s.id, s]));

  const targets = findTargetReviews(reviews, outlets);

  const textsByShow = new Map();
  function textsFor(showId) {
    if (!textsByShow.has(showId)) textsByShow.set(showId, loadShowTexts(showId, reviewTextsDir));
    return textsByShow.get(showId);
  }

  const stillRecoverable = [];
  const awaitingRebuild = [];
  for (const target of targets) {
    const entry = fileForReview(textsFor(target.showId), target);
    if (!entry) continue; // no source file at all — not a wiring gap
    if (changedSinceRebuildScan(entry.data, scannedAt)) { // the next rebuild fills it: lag, not a wiring gap
      awaitingRebuild.push(`${target.showId}/${entry.file}`);
      continue;
    }
    let excerpt;
    try {
      excerpt = recoverableQuote(entry.data, titleById.get(target.showId), statusById.get(target.showId), { show: showById.get(target.showId), filePath: path.join(reviewTextsDir, target.showId, entry.file) });
    } catch {
      continue;
    }
    if (excerpt) {
      stillRecoverable.push({ showId: target.showId, outletId: target.outletId, criticName: target.criticName });
    }
  }

  if (awaitingRebuild.length) t.diagnostic(`${awaitingRebuild.length} file(s) changed after reviews.json's review-texts scan (${scannedAt}), left to the next rebuild: ${awaitingRebuild.join(', ')}`);
  assert.deepEqual(
    stillRecoverable, [],
    `${stillRecoverable.length} review(s) have a usable excerpt in review-texts but no pullQuote in reviews.json — run scripts/backfill-missing-pullquotes.js`
  );
});
