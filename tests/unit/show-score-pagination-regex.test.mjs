/**
 * Regression: Show Score uses single-quoted inline attributes (Rails-rendered HTML),
 * not double quotes. The old regex `data-next-page-path="..."` matched zero pages,
 * silently dropping reviews 9–N for every show with >8 critics. Fixed 2026-04-26.
 *
 * Run: node --test tests/unit/show-score-pagination-regex.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror the production regexes from gather-reviews.js fetchShowScorePaginatedReviews.
// If those regexes change, update here too — keep in sync.
const NEXT_PAGE_RE = /data-next-page-path=(["'])([^"']+)\1/;
const TOTAL_COUNT_RE = /js-show-page-v2__critic-reviews[^>]*data-total-count=(["'])(\d+)\1/;

test('matches single-quoted data-next-page-path (current Show Score render)', () => {
  const html = `
    <div class='js-show-page-v2__critic-reviews -with-margin-bottom'
         data-next-page-path='/shows/hamilton/paginate_critic_reviews'
         data-steps='{&quot;default&quot;:2}'
         data-total-count='44'>
    </div>`;
  const m = html.match(NEXT_PAGE_RE);
  assert.ok(m, 'should match single-quoted data-next-page-path');
  assert.equal(m[2], '/shows/hamilton/paginate_critic_reviews');
  const t = html.match(TOTAL_COUNT_RE);
  assert.ok(t, 'should match single-quoted data-total-count on critic block');
  assert.equal(t[2], '44');
});

test('matches double-quoted data-next-page-path (legacy/fallback render)', () => {
  const html = `
    <div class="js-show-page-v2__critic-reviews"
         data-next-page-path="/shows/wicked/paginate_critic_reviews"
         data-total-count="25"></div>`;
  const m = html.match(NEXT_PAGE_RE);
  assert.ok(m);
  assert.equal(m[2], '/shows/wicked/paginate_critic_reviews');
  const t = html.match(TOTAL_COUNT_RE);
  assert.ok(t);
  assert.equal(t[2], '25');
});

test('does not match foreign attribute with same value type', () => {
  // unrelated data-total-count must not bind when js-show-page-v2 prefix is absent
  const html = `<div class='unrelated-block' data-total-count='99'></div>`;
  const m = html.match(TOTAL_COUNT_RE);
  assert.equal(m, null);
});

test('only Critic-Reviews block total-count binds, not sibling counts', () => {
  // Show Score pages also expose a different data-total-count for member reviews.
  // Our prefix-anchored regex must select only the critic-reviews one.
  const html = `
    <div class='js-show-page-v2__member-reviews' data-total-count='6'></div>
    <div class='js-show-page-v2__critic-reviews' data-next-page-path='/shows/x/paginate_critic_reviews' data-total-count='44'></div>
  `;
  const t = html.match(TOTAL_COUNT_RE);
  assert.ok(t);
  assert.equal(t[2], '44');
});

test('extractor diagnostic: missing critic section signature differs from structure-changed', () => {
  // Distinguishes "Show Score has no critic reviews for this show yet" from
  // "structure changed". Mirrors the heuristic in extractShowScoreReviews.
  const noSection = `<html><body><nav>Critics Picks</nav><div>Just nav chrome</div></body></html>`;
  const hasHeadingNoExtraction = `<html><body><h2>Critic Reviews (5)</h2><div class='review-tile-v2 -critic'>but unparseable</div></body></html>`;
  const matchesHeading = (h) => /Critic\s+Reviews\s*\(\d+\)/i.test(h);
  const matchesTile = (h) => /review-tile-v2[^>'"]*-critic/.test(h);
  assert.equal(matchesHeading(noSection), false);
  assert.equal(matchesTile(noSection), false);
  assert.equal(matchesHeading(hasHeadingNoExtraction), true);
  assert.equal(matchesTile(hasHeadingNoExtraction), true);
});
