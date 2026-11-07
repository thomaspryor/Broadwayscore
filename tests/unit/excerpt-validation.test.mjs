// Keep the card's acceptance command running all existing detector coverage.
import '../../scripts/lib/excerpt-validation.test.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isTourReviewExcerpt, tourContextForShow } = require('../../scripts/lib/excerpt-validation');
const { explainExclusion } = require('../../scripts/lib/review-guards');
const show = {
  id: 'the-play-2026', title: 'The Play', category: 'broadway', status: 'open',
  venue: 'August Wilson Theatre', openingDate: '2026-10-01',
};
const ctx = tourContextForShow(show);

for (const [label, excerpt] of [
  ['own venue and Broadway', 'The play, which follows a national tour, opens on Broadway at the August Wilson Theatre this week.'],
  ['own venue only', 'The play at the August Wilson Theatre follows a national tour.'],
  ['Broadway only', 'The play, which follows a national tour, opens on Broadway this week.'],
]) {
  test(`BRO-5327: bare national tour is history with ${label}`, () => {
    assert.equal(isTourReviewExcerpt(excerpt, ctx).isTourReview, false);
    const review = { showId: show.id, fullText: excerpt, textFetchedAt: '2026-10-14T00:00:00Z' };
    assert.equal(explainExclusion(review, show, '/nonexistent/the-play-2026/review.json'), null);
  });
}

test('BRO-5327: leading After a national tour remains history', () => {
  const result = isTourReviewExcerpt('After a national tour, the play opens on Broadway.', ctx);
  assert.equal(result.isTourReview, false);
  assert.equal(result.discounted, 'history');
});

for (const [label, excerpt] of [
  ['Pantages stop', 'The play, which opened on Broadway at the August Wilson Theatre, brings its national tour to the Pantages this week.'],
  ['city stop', 'The national tour is in Chicago this week, after the play opened on Broadway at the August Wilson Theatre.'],
  ['another city stop', 'The national tour is in San Diego this week, after the play opened on Broadway at the August Wilson Theatre.'],
  ['tour at an unlisted venue', 'The national tour at the Civic Theatre follows the run on Broadway at the August Wilson Theatre.'],
  ['current tour', 'This national tour of the play follows its run on Broadway at the August Wilson Theatre.'],
  ['touring production', 'The touring production of the play follows its run on Broadway at the August Wilson Theatre.'],
  ['wrong venue', 'The play, which follows a national tour, opens at the Winter Garden Theatre this week.'],
  ['off Broadway', 'The play, which follows a national tour, opens off-Broadway this week.'],
  ['no context', 'The play, which follows a national tour, opens at the August Wilson Theatre this week.'],
]) {
  test(`BRO-5327: ${label} stays a tour signal`, () => {
    assert.equal(isTourReviewExcerpt(excerpt, label === 'no context' ? undefined : ctx).isTourReview, true);
  });
}

test('BRO-5327: Broadway history rule does not change other markets', () => {
  const london = { ...show, category: 'west-end', venue: 'Cambridge Theatre' };
  const excerpt = 'The play at the Cambridge Theatre is a fixture. Its national tour followed the run on Broadway.';
  assert.equal(isTourReviewExcerpt(excerpt, tourContextForShow(london)).isTourReview, true);
});
