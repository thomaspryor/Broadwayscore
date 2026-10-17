import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { selectBestExcerpt } = require('../../scripts/rebuild-all-reviews.js');
const { EXCERPT_SOURCE_RANK } = require('../../scripts/lib/pull-quote-guards.js');
const { fileForReview, loadShowTexts } = require('../../scripts/audit-pull-quotes.js');
const { findTargetReviews } = require('../../scripts/backfill-missing-pullquotes.js');

// BRO-767: T1/T2 reviews with assignedScore >= 70 shipped with pullQuote:null
// because three aggregator excerpt fields that ARE captured in review-texts —
// theatreReviewsExcerpt, westEndTheatreExcerpt, lboRoundupExcerpt — were never
// wired into selectBestExcerpt()'s source cascade. These tests guard the fix:
// each field must now be picked up, at a rank below the raw-fullText fallback.

test('EXCERPT_SOURCE_RANK includes the three previously-unwired aggregator fields, ranked above raw fullText', () => {
  for (const field of ['theatreReviewsExcerpt', 'westEndTheatreExcerpt', 'lboRoundupExcerpt']) {
    assert.equal(typeof EXCERPT_SOURCE_RANK[field], 'number', `${field} must have a rank`);
    assert.ok(
      EXCERPT_SOURCE_RANK[field] < EXCERPT_SOURCE_RANK.fullText,
      `${field} must rank above the raw fullText fallback`
    );
  }
});

test('selectBestExcerpt fills pullQuote from theatreReviewsExcerpt when nothing higher-priority exists', () => {
  const excerpt = selectBestExcerpt({
    showId: 'some-show-2026',
    theatreReviewsExcerpt: 'A genuinely gripping revival that finds new menace in a familiar text.',
  }, 'Some Show');
  assert.equal(excerpt, 'A genuinely gripping revival that finds new menace in a familiar text.');
});

test('selectBestExcerpt fills pullQuote from westEndTheatreExcerpt when nothing higher-priority exists', () => {
  const excerpt = selectBestExcerpt({
    showId: 'some-show-2026',
    westEndTheatreExcerpt: 'Acrobatic splendour and joy — a production that never lets its energy flag.',
  }, 'Some Show');
  assert.equal(excerpt, 'Acrobatic splendour and joy — a production that never lets its energy flag.');
});

test('selectBestExcerpt fills pullQuote from lboRoundupExcerpt when nothing higher-priority exists', () => {
  const excerpt = selectBestExcerpt({
    showId: 'some-show-2026',
    lboRoundupExcerpt: 'This co-production offers a fresh interpretation of a well-known text.',
  }, 'Some Show');
  assert.equal(excerpt, 'This co-production offers a fresh interpretation of a well-known text.');
});

test('selectBestExcerpt still prefers dtliExcerpt over the three new aggregator fields', () => {
  const excerpt = selectBestExcerpt({
    showId: 'some-show-2026',
    dtliExcerpt: 'The dtli-curated evaluative quote that should win.',
    theatreReviewsExcerpt: 'A lower-priority theatre.reviews quote that should lose.',
    westEndTheatreExcerpt: 'A lower-priority WET quote that should lose.',
    lboRoundupExcerpt: 'A lower-priority LBO quote that should lose.',
  }, 'Some Show');
  assert.equal(excerpt, 'The dtli-curated evaluative quote that should win.');
});

// Integration check against the live corpus: the BRO-767 audit query
// (findTargetReviews — T1/T2, critic-level dedup winner, assignedScore >= 70,
// pullQuote null/empty/<30 chars) must never contain a review the pipeline
// could already fill. If it does, the wiring gap has regressed (or a new
// aggregator excerpt field needs the same treatment this fix gave the other
// three). Reviews with genuinely no captured excerpt anywhere (stub-tier, no
// fullText, no aggregator field) are a separate, tracked problem — see
// BRO-767 follow-up — and are expected to still appear here.
test('no review missing a pullQuote has a recoverable excerpt sitting unused in review-texts', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const reviewsFile = process.env.REVIEWS_FILE || path.join(ROOT, 'data', 'reviews.json');
  const showsFile = process.env.SHOWS_FILE || path.join(ROOT, 'data', 'shows.json');
  const outletRegistryFile = process.env.OUTLET_REGISTRY_FILE || path.join(ROOT, 'data', 'outlet-registry.json');
  const reviewTextsDir = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');

  if (!fs.existsSync(reviewsFile) || !fs.existsSync(outletRegistryFile)) {
    // Local dev without data set up — the CI job that runs this test always
    // has data/ populated (checkout-review-texts action + core-data symlinks).
    console.log('  [skip] reviews.json / outlet-registry.json not present locally');
    return;
  }

  const reviews = JSON.parse(fs.readFileSync(reviewsFile, 'utf8')).reviews;
  const shows = JSON.parse(fs.readFileSync(showsFile, 'utf8')).shows || [];
  const outlets = JSON.parse(fs.readFileSync(outletRegistryFile, 'utf8')).outlets || {};
  const titleById = new Map(shows.map(s => [s.id, s.title]));

  const targets = findTargetReviews(reviews, outlets);

  const textsByShow = new Map();
  function textsFor(showId) {
    if (!textsByShow.has(showId)) textsByShow.set(showId, loadShowTexts(showId, reviewTextsDir));
    return textsByShow.get(showId);
  }

  const stillRecoverable = [];
  for (const target of targets) {
    const entry = fileForReview(textsFor(target.showId), target);
    if (!entry) continue; // no source file at all — not a wiring gap
    let excerpt;
    try {
      excerpt = selectBestExcerpt(entry.data, titleById.get(target.showId));
    } catch {
      continue;
    }
    if (excerpt) {
      stillRecoverable.push({ showId: target.showId, outletId: target.outletId, criticName: target.criticName });
    }
  }

  assert.deepEqual(
    stillRecoverable, [],
    `${stillRecoverable.length} review(s) have a usable excerpt in review-texts but no pullQuote in reviews.json — run scripts/backfill-missing-pullquotes.js`
  );
});
