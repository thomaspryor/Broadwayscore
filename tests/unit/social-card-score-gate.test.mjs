// TESTS-VS-DERIVED-DATA-EXEMPT: parity test, the same core data through the social card path and the website's review-count gate; asserts equality, no factual pins.
/**
 * Social cards (scripts/social-image-generator.js) show a show's score only
 * when the website does: hasEnoughReviews(reviewCount, category, T1+T2). The
 * T1+T2 count matters: a show with only T3 reviews needs two more before the
 * site shows a score. scripts/generate-social-post.js must pass it on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeShowScores, loadShows } = require('../../scripts/generate-social-post');
const { getScoreLabel } = require('../../scripts/social-image-generator');
const { hasEnoughReviews } = require('../../scripts/lib/min-reviews');

test('social card label hides the score exactly when the website card is TBD', () => {
  const scores = computeShowScores();
  const category = new Map(loadShows().map(s => [s.id, s.category]));
  const ids = Object.keys(scores);
  if (ids.length === 0) return; // no core data in this checkout
  const misses = [];
  for (const id of ids) {
    const r = scores[id];
    assert.equal(typeof r.tier1And2Count, 'number', `${id}: computeShowScores must carry tier1And2Count`);
    const cat = category.get(id);
    const siteShows = hasEnoughReviews(r.reviewCount, cat, r.tier1And2Count);
    const label = getScoreLabel(r.compositeScore, r.reviewCount, cat, r.tier1And2Count);
    if (siteShows === (label === 'Awaiting Reviews')) misses.push(`${id}: site ${siteShows ? 'score' : 'TBD'}, card "${label}"`);
  }
  assert.deepEqual(misses.slice(0, 10), [], `${misses.length} disagreements`);
});

test('a T3-only Broadway show with 5 reviews is "Awaiting Reviews", as on the site', () => {
  assert.equal(hasEnoughReviews(5, 'broadway', 0), false);
  assert.equal(getScoreLabel(80, 5, 'broadway', 0), 'Awaiting Reviews');
  assert.equal(getScoreLabel(80, 7, 'broadway', 0), 'Recommended');
  assert.equal(getScoreLabel(80, 5, 'broadway', 2), 'Recommended');
});
